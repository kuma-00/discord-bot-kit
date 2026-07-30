import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ApplicationCommandType,
    type ChatInputCommandInteraction,
    type Client,
    ContextMenuCommandBuilder,
    SlashCommandBuilder,
} from "discord.js";
import { OperationTracker } from "../src/execution.ts";
import {
    type BotCommand,
    buildBotRegistryModule,
    CommandDispatcher,
    checkBotRegistry,
    createBotRegistry,
    createHelpEmbeds,
    DiscordBot,
    defineGuildCommand,
    generateBotRegistry,
    RegistryValidationError,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((path) => rm(path, { recursive: true, force: true })),
    );
});

const rootCommand = (): BotCommand => ({
    kind: "chat-input",
    id: "queue",
    builder: new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Manage the queue"),
});

const subcommand = (execute: () => void = () => {}): BotCommand => ({
    kind: "subcommand",
    id: "remove",
    parentId: "queue",
    builder: (builder) =>
        builder.setName("remove").setDescription("Remove an item"),
    execute,
});

describe("command registry", () => {
    test("defines guild commands with object-style execute arguments", async () => {
        const client = {} as Client;
        const interaction = {
            guild: {},
            guildId: "guild",
        } as unknown as ChatInputCommandInteraction & {
            guild: NonNullable<ChatInputCommandInteraction["guild"]>;
            guildId: string;
        };
        const signal = new AbortController().signal;
        let received:
            | {
                  client: Client;
                  interaction: ChatInputCommandInteraction;
                  signal: AbortSignal;
              }
            | undefined;
        const command = defineGuildCommand({
            id: "play",
            builder: new SlashCommandBuilder()
                .setName("play")
                .setDescription("Play music"),
            execute: (arguments_) => {
                received = arguments_;
            },
        });

        await command.execute?.(client, interaction, { signal });
        expect(command.kind).toBe("chat-input");
        expect(command.guildOnly).toBe(true);
        expect(received).toEqual({ client, interaction, signal });
    });

    test("composes subcommands and application command JSON", () => {
        const registry = createBotRegistry([rootCommand(), subcommand()]);
        expect(registry.executableCommands.has("queue/remove")).toBe(true);
        expect(registry.applicationCommands).toEqual([
            {
                contexts: undefined,
                default_member_permissions: undefined,
                default_permission: undefined,
                description: "Manage the queue",
                description_localizations: undefined,
                dm_permission: undefined,
                integration_types: undefined,
                name: "queue",
                name_localizations: undefined,
                nsfw: undefined,
                options: [
                    {
                        description: "Remove an item",
                        description_localizations: undefined,
                        name: "remove",
                        name_localizations: undefined,
                        options: [],
                        type: 1,
                    },
                ],
                type: 1,
            },
        ]);
    });

    test("composes subcommand groups", () => {
        const group: BotCommand = {
            kind: "subcommand-group",
            id: "admin",
            parentId: "queue",
            builder: (builder) =>
                builder.setName("admin").setDescription("Admin commands"),
        };
        const child: BotCommand = {
            kind: "subcommand",
            id: "remove",
            parentId: "queue",
            groupId: "admin",
            builder: (builder) =>
                builder.setName("remove").setDescription("Remove an item"),
            execute: () => {},
        };
        const registry = createBotRegistry([rootCommand(), group, child]);
        expect(registry.executableCommands.has("queue/admin/remove")).toBe(
            true,
        );
        expect(
            (
                registry.applicationCommands[0]?.options?.[0] as {
                    options?: unknown[];
                }
            ).options,
        ).toHaveLength(1);
    });

    test("supports context menu command data", () => {
        const command: BotCommand = {
            kind: "context-menu",
            id: "Inspect",
            builder: new ContextMenuCommandBuilder()
                .setName("Inspect")
                .setType(ApplicationCommandType.User),
            execute: () => {},
        };
        expect(createBotRegistry([command]).applicationCommands[0]?.type).toBe(
            ApplicationCommandType.User,
        );
    });

    test("rejects duplicate, missing parent, and builder mismatch", () => {
        expect(() => createBotRegistry([rootCommand(), rootCommand()])).toThrow(
            RegistryValidationError,
        );
        expect(() => createBotRegistry([subcommand()])).toThrow(
            /missing parent/,
        );
        expect(() =>
            createBotRegistry([
                {
                    kind: "chat-input",
                    id: "queue",
                    builder: new SlashCommandBuilder()
                        .setName("different")
                        .setDescription("Different"),
                },
            ]),
        ).toThrow(/does not match/);
    });

    test("allows multiple handlers for one Discord event", () => {
        const execute = () => {};
        const registry = createBotRegistry(
            [],
            [
                { id: "ready-a", event: "ready", execute },
                { id: "ready-b", event: "ready", execute },
            ],
        );
        expect(registry.events).toHaveLength(2);
    });

    test("does not mutate command builders while composing registries", () => {
        const root = rootCommand();
        const child = subcommand();
        const first = createBotRegistry([root, child]);
        const second = createBotRegistry([root, child]);

        expect(first.applicationCommands).toEqual(second.applicationCommands);
        if (root.kind !== "chat-input") {
            throw new Error("Expected a chat-input root");
        }
        expect(
            (root.builder.toJSON() as { options?: unknown[] }).options,
        ).toHaveLength(0);
    });
});

describe("help embed", () => {
    test("groups visible chat-input definitions and resolves descriptions", () => {
        const group: BotCommand = {
            kind: "subcommand-group",
            id: "admin",
            parentId: "queue",
            metadata: { category: "Queue" },
            builder: (builder) =>
                builder.setName("admin").setDescription("Admin commands"),
        };
        const child: Extract<BotCommand, { kind: "subcommand" }> = {
            ...(subcommand() as Extract<BotCommand, { kind: "subcommand" }>),
            groupId: "admin",
            metadata: {
                category: "Queue",
                description: "Metadata description",
            },
        };
        const hidden: BotCommand = {
            kind: "chat-input",
            id: "hidden",
            metadata: { hidden: true },
            builder: new SlashCommandBuilder()
                .setName("hidden")
                .setDescription("Hidden command"),
        };
        const contextMenu: BotCommand = {
            kind: "context-menu",
            id: "Inspect",
            metadata: { category: "Other" },
            builder: new ContextMenuCommandBuilder()
                .setName("Inspect")
                .setType(ApplicationCommandType.User),
            execute: () => {},
        };
        const root = {
            ...rootCommand(),
            metadata: { category: "Queue" },
        } satisfies BotCommand;
        const [embedBuilder] = createHelpEmbeds(
            createBotRegistry([root, group, child, hidden, contextMenu]),
        );
        if (!embedBuilder) throw new Error("Expected a help embed");
        const embed = embedBuilder.toJSON();

        expect(embed.title).toBe("コマンド一覧");
        expect(embed.description).toBe("説明");
        expect(embed.timestamp).toBeDefined();
        expect(embed.fields).toEqual([
            {
                name: "**3 · Queue**",
                value: [
                    "`/queue` : Manage the queue",
                    "`/queue admin` : Admin commands",
                    "`/queue admin remove` : Metadata description",
                ].join("\n"),
            },
        ]);
    });

    test("supports uncategorized and presentation overrides", () => {
        const timestamp = new Date("2026-01-02T03:04:05.000Z");
        const [embedBuilder] = createHelpEmbeds(
            createBotRegistry([rootCommand()]),
            {
                title: "Help",
                description: "Available commands",
                footer: {
                    text: "Example Bot",
                    iconURL: "https://example.com/bot.png",
                },
                timestamp,
                uncategorizedLabel: "Misc",
            },
        );
        const embed = embedBuilder?.toJSON();

        expect(embed).toMatchObject({
            title: "Help",
            description: "Available commands",
            footer: {
                text: "Example Bot",
                icon_url: "https://example.com/bot.png",
            },
            timestamp: timestamp.toISOString(),
            fields: [
                {
                    name: "**1 · Misc**",
                    value: "`/queue` : Manage the queue",
                },
            ],
        });
    });

    test("creates a help embed for an empty registry without a timestamp", () => {
        expect(
            createHelpEmbeds(createBotRegistry([]), {
                timestamp: null,
            })[0]?.toJSON(),
        ).toEqual({
            title: "コマンド一覧",
            description: "説明",
        });
    });

    test("splits categories across valid embeds", () => {
        const commands = Array.from(
            { length: 26 },
            (_, index): BotCommand => ({
                kind: "chat-input",
                id: `command-${index}`,
                metadata: { category: `Category ${index}` },
                builder: new SlashCommandBuilder()
                    .setName(`command-${index}`)
                    .setDescription("Description"),
            }),
        );

        const embeds = createHelpEmbeds(createBotRegistry(commands));

        expect(embeds).toHaveLength(2);
        expect(embeds.map((embed) => embed.toJSON().fields?.length)).toEqual([
            25, 1,
        ]);
        expect(embeds[0]?.toJSON().title).toBe("コマンド一覧 (1/2)");
        expect(embeds[1]?.toJSON().title).toBe("コマンド一覧 (2/2)");
    });

    test("splits long categories into fields within Discord limits", () => {
        const commands = Array.from(
            { length: 12 },
            (_, index): BotCommand => ({
                kind: "chat-input",
                id: `command-${index}`,
                metadata: { category: "All" },
                builder: new SlashCommandBuilder()
                    .setName(`command-${index}`)
                    .setDescription("x".repeat(100)),
            }),
        );

        const [embed] = createHelpEmbeds(createBotRegistry(commands));
        const json = embed?.toJSON();

        expect(json?.fields).toHaveLength(2);
        expect(
            json?.fields?.every(
                (field) =>
                    field.name.length <= 256 && field.value.length <= 1_024,
            ),
        ).toBe(true);
    });

    test("bounds presentation metadata and total embed content", () => {
        const [embed] = createHelpEmbeds(createBotRegistry([rootCommand()]), {
            title: "t".repeat(300),
            description: "d".repeat(5_000),
            footer: { text: "f".repeat(3_000) },
            uncategorizedLabel: "c".repeat(300),
        });
        const json = embed?.toJSON();
        const totalLength =
            (json?.title?.length ?? 0) +
            (json?.description?.length ?? 0) +
            (json?.footer?.text.length ?? 0) +
            (json?.fields ?? []).reduce(
                (total, field) =>
                    total + field.name.length + field.value.length,
                0,
            );

        expect(json?.title?.length).toBeLessThanOrEqual(256);
        expect(json?.description?.length).toBeLessThanOrEqual(4_096);
        expect(json?.footer?.text.length).toBeLessThanOrEqual(2_048);
        expect(json?.fields?.[0]?.name.length).toBeLessThanOrEqual(256);
        expect(totalLength).toBeLessThanOrEqual(6_000);
    });
});

describe("dispatcher", () => {
    test("dispatches a subcommand with explicit defer policy", async () => {
        let executed = false;
        let deferredEphemeral: boolean | undefined;
        const registry = createBotRegistry([
            rootCommand(),
            {
                ...subcommand(() => {
                    executed = true;
                }),
                execution: { defer: true, ephemeral: true },
            },
        ]);
        const dispatcher = new CommandDispatcher({
            client: {} as Client,
            registry,
        });
        const interaction = {
            commandName: "queue",
            deferred: false,
            replied: false,
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            isRepliable: () => true,
            inGuild: () => true,
            inCachedGuild: () => true,
            deferReply: async ({ ephemeral }: { ephemeral: boolean }) => {
                deferredEphemeral = ephemeral;
            },
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => "remove",
            },
        } as unknown as ChatInputCommandInteraction;
        expect(await dispatcher.dispatch(interaction)).toEqual({
            handled: true,
            commandId: "queue/remove",
        });
        expect(executed).toBe(true);
        expect(deferredEphemeral).toBe(true);
    });

    test("returns structured results for unknown and guild-only commands", async () => {
        const registry = createBotRegistry([
            {
                kind: "chat-input",
                id: "queue",
                builder: new SlashCommandBuilder()
                    .setName("queue")
                    .setDescription("Manage the queue"),
                guildOnly: true,
                execute: () => {},
            },
        ]);
        const dispatcher = new CommandDispatcher({
            client: {} as Client,
            registry,
        });
        const interaction = {
            commandName: "queue",
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            inGuild: () => false,
            inCachedGuild: () => false,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;
        expect(await dispatcher.dispatch(interaction)).toEqual({
            handled: false,
            reason: "guild-only",
            commandId: "queue",
        });
        (interaction as unknown as { commandName: string }).commandName =
            "missing";
        expect(await dispatcher.dispatch(interaction)).toEqual({
            handled: false,
            reason: "not-found",
        });
    });

    test("rejects uncached guild interactions for guild-only handlers", async () => {
        let executed = false;
        const registry = createBotRegistry([
            {
                kind: "chat-input",
                id: "queue",
                builder: new SlashCommandBuilder()
                    .setName("queue")
                    .setDescription("Manage the queue"),
                guildOnly: true,
                execute: () => {
                    executed = true;
                },
            },
        ]);
        const dispatcher = new CommandDispatcher({
            client: {} as Client,
            registry,
        });
        const interaction = {
            commandName: "queue",
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            inGuild: () => true,
            inCachedGuild: () => false,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;

        expect(await dispatcher.dispatch(interaction)).toEqual({
            handled: false,
            reason: "guild-only",
            commandId: "queue",
        });
        expect(executed).toBe(false);
    });

    test("rethrows handler failures without an error boundary", async () => {
        const failure = new Error("command failed");
        const registry = createBotRegistry([
            {
                kind: "chat-input",
                id: "queue",
                builder: new SlashCommandBuilder()
                    .setName("queue")
                    .setDescription("Manage the queue"),
                execute: () => {
                    throw failure;
                },
            },
        ]);
        const dispatcher = new CommandDispatcher({
            client: {} as Client,
            registry,
        });
        const interaction = {
            commandName: "queue",
            deferred: false,
            replied: false,
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            isRepliable: () => true,
            inCachedGuild: () => true,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;

        await expect(dispatcher.dispatch(interaction)).rejects.toBe(failure);
    });

    test("reports handler failures once when an error boundary exists", async () => {
        const failure = new Error("command failed");
        const errors: unknown[] = [];
        const registry = createBotRegistry([
            {
                kind: "chat-input",
                id: "queue",
                builder: new SlashCommandBuilder()
                    .setName("queue")
                    .setDescription("Manage the queue"),
                execute: () => {
                    throw failure;
                },
            },
        ]);
        const dispatcher = new CommandDispatcher({
            client: {} as Client,
            registry,
            onError: (error) => {
                errors.push(error);
            },
        });
        const interaction = {
            commandName: "queue",
            deferred: false,
            replied: false,
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            isRepliable: () => true,
            inCachedGuild: () => true,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;

        await expect(dispatcher.dispatch(interaction)).resolves.toEqual({
            handled: true,
            commandId: "queue",
        });
        expect(errors).toEqual([failure]);
    });

    test("reports timeout and aborts the handler signal", async () => {
        let aborted = false;
        const errors: unknown[] = [];
        const registry = createBotRegistry([
            {
                kind: "chat-input",
                id: "queue",
                builder: new SlashCommandBuilder()
                    .setName("queue")
                    .setDescription("Manage the queue"),
                execution: { timeoutMs: 5 },
                execute: async (
                    _client: Client,
                    _interaction: ChatInputCommandInteraction,
                    { signal }: { signal: AbortSignal },
                ) => {
                    await new Promise<void>((resolve) => {
                        signal.addEventListener("abort", () => {
                            aborted = true;
                            resolve();
                        });
                    });
                },
            },
        ]);
        const dispatcher = new CommandDispatcher({
            client: {} as Client,
            registry,
            onError: (error, context) => {
                errors.push({ error, context });
            },
        });
        const interaction = {
            commandName: "queue",
            deferred: false,
            replied: false,
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            isRepliable: () => true,
            inGuild: () => true,
            inCachedGuild: () => true,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;
        await dispatcher.dispatch(interaction);
        expect(aborted).toBe(true);
        expect(errors).toHaveLength(1);
        expect(
            (errors[0] as { context: { timedOut: boolean } }).context.timedOut,
        ).toBe(true);
    });

    test("reports defer failures through the error boundary", async () => {
        const failure = new Error("cannot defer");
        const errors: unknown[] = [];
        const registry = createBotRegistry([
            {
                kind: "chat-input",
                id: "queue",
                builder: new SlashCommandBuilder()
                    .setName("queue")
                    .setDescription("Manage the queue"),
                execution: { defer: true },
                execute: () => {},
            },
        ]);
        const dispatcher = new CommandDispatcher({
            client: {} as Client,
            registry,
            onError: (error) => {
                errors.push(error);
            },
        });
        const interaction = {
            commandName: "queue",
            deferred: false,
            replied: false,
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            isRepliable: () => true,
            inGuild: () => true,
            inCachedGuild: () => true,
            deferReply: () => Promise.reject(failure),
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;

        expect(await dispatcher.dispatch(interaction)).toEqual({
            handled: true,
            commandId: "queue",
        });
        expect(errors).toEqual([failure]);
    });
});

describe("operation tracker", () => {
    test("rejects an invalid timeout before starting the operation", async () => {
        const tracker = new OperationTracker();
        let started = false;

        await expect(
            tracker.run("invalid", 0, () => {
                started = true;
            }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(started).toBe(false);
    });
});

describe("lifecycle", () => {
    test("contains rejected error handlers and falls back to logging", async () => {
        const handlerFailure = new Error("error handler failed");
        const operationFailure = new Error("command failed");
        const logged: unknown[] = [];
        const fakeClient = {} as Client;
        const bot = new DiscordBot(
            createBotRegistry([
                {
                    kind: "chat-input",
                    id: "queue",
                    builder: new SlashCommandBuilder()
                        .setName("queue")
                        .setDescription("Manage the queue"),
                    execute: () => {
                        throw operationFailure;
                    },
                },
            ]),
            {
                token: "token",
                clientOptions: { intents: [] },
                clientFactory: () => fakeClient,
                onError: async () => {
                    throw handlerFailure;
                },
                logger: {
                    error: (message, context) => {
                        logged.push({ message, context });
                    },
                },
            },
        );
        const interaction = {
            commandName: "queue",
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            inCachedGuild: () => false,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;

        expect(await bot.dispatcher.dispatch(interaction)).toEqual({
            handled: true,
            commandId: "queue",
        });
        expect(logged).toEqual([
            {
                message: "Discord bot error handler failed",
                context: {
                    error: handlerFailure,
                    originalError: operationFailure,
                    phase: "command",
                    id: "queue",
                    interaction,
                    timedOut: false,
                    aborted: false,
                },
            },
        ]);
    });

    test("contains rejected asynchronous loggers", async () => {
        const bot = new DiscordBot(
            createBotRegistry([
                {
                    kind: "chat-input",
                    id: "queue",
                    builder: new SlashCommandBuilder()
                        .setName("queue")
                        .setDescription("Manage the queue"),
                    execute: () => {
                        throw new Error("command failed");
                    },
                },
            ]),
            {
                token: "token",
                clientOptions: { intents: [] },
                clientFactory: () => ({}) as Client,
                logger: {
                    error: async () => {
                        throw new Error("async logger failed");
                    },
                },
            },
        );
        const interaction = {
            commandName: "queue",
            isAutocomplete: () => false,
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            inCachedGuild: () => false,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as ChatInputCommandInteraction;

        expect(await bot.dispatcher.dispatch(interaction)).toEqual({
            handled: true,
            commandId: "queue",
        });
        await Bun.sleep(0);
    });

    test("registers once and removes listeners on stop", async () => {
        const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        let loginCount = 0;
        let destroyCount = 0;
        const fakeClient = {
            on(event: string, listener: (...args: unknown[]) => void) {
                const registered = listeners.get(event) ?? new Set();
                registered.add(listener);
                listeners.set(event, registered);
                return fakeClient;
            },
            once(event: string, listener: (...args: unknown[]) => void) {
                return fakeClient.on(event, listener);
            },
            off(event: string, listener: (...args: unknown[]) => void) {
                listeners.get(event)?.delete(listener);
                return fakeClient;
            },
            login: async () => {
                loginCount++;
                return "token";
            },
            destroy: () => {
                destroyCount++;
            },
        } as unknown as Client;
        const bot = new DiscordBot(createBotRegistry([]), {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: () => fakeClient,
        });
        await Promise.all([bot.start(), bot.start()]);
        expect(loginCount).toBe(1);
        await bot.stop();
        expect(destroyCount).toBe(1);
        expect([...listeners.values()].every((value) => value.size === 0)).toBe(
            true,
        );
    });

    test("waits for an in-progress start before stopping", async () => {
        let resolveLogin!: () => void;
        const login = new Promise<void>((resolve) => {
            resolveLogin = resolve;
        });
        let destroyCount = 0;
        const fakeClient = {
            on: () => fakeClient,
            once: () => fakeClient,
            off: () => fakeClient,
            login: async () => {
                await login;
                return "token";
            },
            destroy: () => {
                destroyCount++;
            },
        } as unknown as Client;
        const bot = new DiscordBot(createBotRegistry([]), {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: () => fakeClient,
        });

        const starting = bot.start();
        const stopping = bot.stop();
        resolveLogin();
        await Promise.all([starting, stopping]);
        expect(destroyCount).toBe(1);
    });

    test("restarts after an in-progress stop completes", async () => {
        let resolveFirstLogin!: () => void;
        const firstLogin = new Promise<void>((resolve) => {
            resolveFirstLogin = resolve;
        });
        let loginCount = 0;
        let destroyCount = 0;
        const fakeClient = {
            on: () => fakeClient,
            once: () => fakeClient,
            off: () => fakeClient,
            login: async () => {
                loginCount++;
                if (loginCount === 1) await firstLogin;
                return "token";
            },
            destroy: () => {
                destroyCount++;
            },
        } as unknown as Client;
        const bot = new DiscordBot(createBotRegistry([]), {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: () => fakeClient,
        });

        const initialStart = bot.start();
        const stopping = bot.stop();
        const restarting = bot.start();
        resolveFirstLogin();
        await Promise.all([initialStart, stopping, restarting]);
        expect(loginCount).toBe(2);
        expect(destroyCount).toBe(1);
    });
});

describe("registry generator", () => {
    async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "bot-kit-generator-"));
        temporaryDirectories.push(directory);
        const commands = join(directory, "commands");
        const events = join(directory, "events");
        await mkdir(commands);
        await mkdir(events);
        await Bun.write(
            join(commands, "b.ts"),
            'export default { id: "b", kind: "chat-input", builder: { toJSON() { return { name: "b" }; } } };',
        );
        await Bun.write(
            join(commands, "a.ts"),
            'export default { id: "a", kind: "chat-input", builder: { toJSON() { return { name: "a" }; } } };',
        );
        await Bun.write(
            join(events, "ready.ts"),
            'export default { id: "ready", event: "ready", execute() {} };',
        );
        return {
            commandSourceDir: commands,
            eventSourceDir: events,
            outputPath: join(directory, "generated", "bot.ts"),
        };
    }

    test("generates deterministic imports and detects stale output", async () => {
        const config = await fixture();
        const built = await buildBotRegistryModule(config);
        expect(built.content.indexOf("commands/a.ts")).toBeLessThan(
            built.content.indexOf("commands/b.ts"),
        );
        expect(built.content).toContain(
            "DiscordBotRuntimeOptions<BotRegistryClient<typeof botRegistry>>",
        );
        const result = await generateBotRegistry(config);
        expect(result.changed).toBe(true);
        expect((await checkBotRegistry(config)).changed).toBe(false);
        await Bun.write(config.outputPath, "// stale");
        expect(checkBotRegistry(config)).rejects.toThrow(/stale/);
    });

    test("rejects invalid default exports and empty sources", async () => {
        const config = await fixture();
        await Bun.write(join(config.commandSourceDir, "a.ts"), "export {};");
        expect(buildBotRegistryModule(config)).rejects.toThrow(
            RegistryValidationError,
        );
        const empty = await mkdtemp(join(tmpdir(), "bot-kit-empty-"));
        temporaryDirectories.push(empty);
        expect(
            buildBotRegistryModule({
                commandSourceDir: empty,
                eventSourceDir: config.eventSourceDir,
                outputPath: join(empty, "generated.ts"),
            }),
        ).rejects.toThrow(/No runtime TypeScript modules/);
    });

    test("rejects unsupported command kinds and invalid builders", async () => {
        const config = await fixture();
        await Bun.write(
            join(config.commandSourceDir, "a.ts"),
            'export default { id: "a", kind: "unknown", builder: { toJSON() {} } };',
        );
        expect(buildBotRegistryModule(config)).rejects.toThrow(
            RegistryValidationError,
        );
        await Bun.write(
            join(config.commandSourceDir, "a.ts"),
            'export default { id: "a", kind: "chat-input", builder: null };',
        );
        expect(buildBotRegistryModule(config)).rejects.toThrow(
            RegistryValidationError,
        );
    });

    test("rejects cross-module registry inconsistencies", async () => {
        const duplicate = await fixture();
        await Bun.write(
            join(duplicate.commandSourceDir, "b.ts"),
            'export default { id: "a", kind: "chat-input", builder: { toJSON() { return { name: "a" }; } } };',
        );
        expect(buildBotRegistryModule(duplicate)).rejects.toThrow(
            /Duplicate command id/,
        );

        const missingParent = await fixture();
        await Bun.write(
            join(missingParent.commandSourceDir, "child.ts"),
            `export default {
                id: "remove",
                kind: "subcommand",
                parentId: "missing",
                builder(builder) {
                    return builder.setName("remove").setDescription("Remove");
                },
                execute() {},
            };`,
        );
        expect(buildBotRegistryModule(missingParent)).rejects.toThrow(
            /missing parent/,
        );
    });

    test("rejects empty event identifiers and names", async () => {
        const emptyId = await fixture();
        await Bun.write(
            join(emptyId.eventSourceDir, "ready.ts"),
            'export default { id: " ", event: "ready", execute() {} };',
        );
        expect(buildBotRegistryModule(emptyId)).rejects.toThrow(
            RegistryValidationError,
        );

        const emptyEvent = await fixture();
        await Bun.write(
            join(emptyEvent.eventSourceDir, "ready.ts"),
            'export default { id: "ready", event: " ", execute() {} };',
        );
        expect(buildBotRegistryModule(emptyEvent)).rejects.toThrow(
            RegistryValidationError,
        );
    });
});
