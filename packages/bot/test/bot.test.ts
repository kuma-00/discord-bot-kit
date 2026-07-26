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
import {
    type BotCommand,
    buildBotRegistryModule,
    CommandDispatcher,
    checkBotRegistry,
    createBotRegistry,
    DiscordBot,
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
});

describe("lifecycle", () => {
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
            'export default { id: "b", kind: "chat-input", builder: {} };',
        );
        await Bun.write(
            join(commands, "a.ts"),
            'export default { id: "a", kind: "chat-input", builder: {} };',
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
});
