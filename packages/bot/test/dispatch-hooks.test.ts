import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import {
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    type Client,
    Events,
    type Interaction,
    SlashCommandBuilder,
} from "discord.js";
import {
    CommandDispatcher,
    type CommandDispatcherOptions,
    createBotRegistry,
    createCommandDefinition,
    DiscordBot,
    type DispatchResult,
} from "../src/index.ts";

function chatInteraction(
    commandName: string,
    options: {
        subcommand?: string | null;
        cachedGuild?: boolean;
        deferReply?: () => Promise<void>;
    } = {},
): ChatInputCommandInteraction {
    return {
        commandName,
        deferred: false,
        replied: false,
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        isContextMenuCommand: () => false,
        isRepliable: () => true,
        inCachedGuild: () => options.cachedGuild ?? true,
        deferReply: options.deferReply ?? (() => Promise.resolve()),
        options: {
            getSubcommandGroup: () => null,
            getSubcommand: () => options.subcommand ?? null,
        },
    } as unknown as ChatInputCommandInteraction;
}

function dispatcher(
    definitions: Parameters<typeof createBotRegistry<Client, undefined>>[0],
    options: Partial<CommandDispatcherOptions<Client, undefined>> = {},
): CommandDispatcher<Client> {
    return new CommandDispatcher({
        client: {} as Client,
        registry: createBotRegistry(definitions),
        ...options,
    });
}

describe("dispatch hooks", () => {
    const command = createCommandDefinition<undefined>();
    test("wraps defer, execution, and unhandled observation; next is single-use", async () => {
        const calls: string[] = [];
        let executionCount = 0;
        let lateNext!: () => Promise<DispatchResult>;
        const interaction = chatInteraction("play", {
            deferReply: async () => {
                calls.push("defer");
            },
        });
        const instance = dispatcher(
            [
                command({
                    kind: "chat-input",
                    id: "play",
                    builder: new SlashCommandBuilder()
                        .setName("play")
                        .setDescription("Play"),
                    execution: { defer: true },
                    execute: () => {
                        executionCount++;
                        calls.push("execute");
                    },
                }),
            ],
            {
                dispatchWrapper: async (_interaction, next) => {
                    calls.push("before");
                    lateNext = next;
                    const first = next();
                    expect(next).toThrow("only be called once");
                    const result = await first;
                    calls.push("after");
                    return result;
                },
                onUnhandledInteraction: () => {
                    calls.push("unhandled");
                },
            },
        );

        expect(await instance.dispatch(interaction)).toEqual({
            handled: true,
            commandId: "play",
        });
        expect(calls).toEqual(["before", "defer", "execute", "after"]);
        expect(executionCount).toBe(1);
        expect(interaction.deferred).toBe(false);
        expect("reply" in interaction).toBe(false);
        expect(lateNext).toThrow("only be called once");
    });

    test("observes each unhandled reason once without adding replies", async () => {
        const observed: string[] = [];
        const button = {
            isAutocomplete: () => false,
            isChatInputCommand: () => false,
            isContextMenuCommand: () => false,
            isButton: () => true,
        } as unknown as Interaction;
        const contextMenu = {
            commandName: "known",
            isAutocomplete: () => false,
            isChatInputCommand: () => false,
            isContextMenuCommand: () => true,
            isRepliable: () => true,
        } as unknown as Interaction;
        const autocomplete = {
            commandName: "known",
            isAutocomplete: () => true,
            isChatInputCommand: () => false,
            isContextMenuCommand: () => false,
        } as unknown as Interaction;
        const cases: [Interaction, string][] = [
            [button, "unsupported-interaction"],
            [chatInteraction("missing"), "not-found"],
            [contextMenu, "kind-mismatch"],
            [autocomplete, "handler-missing"],
            [chatInteraction("guild", { cachedGuild: false }), "guild-only"],
        ];
        const parentBuilder = new SlashCommandBuilder()
            .setName("parent")
            .setDescription("Parent");
        parentBuilder.addSubcommand((builder) =>
            builder.setName("child").setDescription("Child"),
        );
        const instance = dispatcher(
            [
                command({
                    kind: "chat-input",
                    id: "known",
                    builder: new SlashCommandBuilder()
                        .setName("known")
                        .setDescription("Known"),
                    execute: () => {},
                }),
                command({
                    kind: "chat-input",
                    id: "parent",
                    builder: parentBuilder,
                }),
                command({
                    kind: "chat-input",
                    id: "guild",
                    builder: new SlashCommandBuilder()
                        .setName("guild")
                        .setDescription("Guild only"),
                    guildOnly: true,
                    execute: () => {},
                }),
            ],
            {
                onUnhandledInteraction: (_interaction, result) => {
                    observed.push(result.reason);
                },
            },
        );

        for (const [interaction, reason] of cases) {
            expect(await instance.dispatch(interaction)).toMatchObject({
                handled: false,
                reason,
            });
        }
        expect(observed).toEqual(cases.map(([, reason]) => reason));
    });

    test("isolates async-local context through defer, command, and fallback", async () => {
        const storage = new AsyncLocalStorage<string>();
        const observed: string[] = [];
        const instance = dispatcher(
            [
                command({
                    kind: "chat-input",
                    id: "work",
                    builder: new SlashCommandBuilder()
                        .setName("work")
                        .setDescription("Work"),
                    execution: { defer: true },
                    execute: async (_client, _interaction, { signal }) => {
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        observed.push(`command:${storage.getStore()}`);
                        signal.throwIfAborted();
                    },
                }),
            ],
            {
                dispatchWrapper: (interaction, next) => {
                    const name = (interaction as ChatInputCommandInteraction)
                        .commandName;
                    return storage.run(name, async () => {
                        return await next();
                    });
                },
                onUnhandledInteraction: (_interaction, _result, context) => {
                    observed.push(`fallback:${storage.getStore()}`);
                    expect(context.signal.aborted).toBe(false);
                },
            },
        );
        const run = (name: string) =>
            instance.dispatch(
                chatInteraction(name, {
                    deferReply: async () => {
                        observed.push(`defer:${storage.getStore()}`);
                    },
                }),
            );

        await Promise.all([run("work"), run("missing")]);
        expect(observed).toContain("defer:work");
        expect(observed).toContain("command:work");
        expect(observed).toContain("fallback:missing");
        expect(observed).not.toContain("fallback:work");
    });

    test("routes wrapper and hook exceptions to the dispatch boundary once", async () => {
        const errors: unknown[] = [];
        const failure = new Error("wrapper failed");
        const instance = dispatcher([], {
            dispatchWrapper: async () => {
                throw failure;
            },
            onError: (error, context) => {
                errors.push({ error, context });
            },
        });
        expect(await instance.dispatch(chatInteraction("missing"))).toEqual({
            handled: false,
            reason: "dispatch-failed",
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
            error: failure,
            context: { phase: "dispatch" },
        });

        const hookError = new Error("hook failed");
        errors.length = 0;
        const hookDispatcher = dispatcher([], {
            onUnhandledInteraction: () => {
                throw hookError;
            },
            onError: (error, context) => {
                errors.push({ error, context });
            },
        });
        expect(
            await hookDispatcher.dispatch(chatInteraction("missing")),
        ).toEqual({
            handled: false,
            reason: "dispatch-failed",
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
            error: hookError,
            context: { phase: "dispatch" },
        });
    });

    test("rethrows inner command and autocomplete boundary failures only once per dispatch", async () => {
        const calls: { phase: string; commandName: string }[] = [];
        const commandBoundary = new Error("command boundary failed");
        const autocompleteBoundary = new Error("autocomplete boundary failed");
        const primitiveBoundary = "primitive boundary rejection";
        const instance = dispatcher(
            [
                command({
                    kind: "chat-input",
                    id: "command-failure",
                    builder: new SlashCommandBuilder()
                        .setName("command-failure")
                        .setDescription("Command failure"),
                    execute: () => {
                        throw new Error("command operation failed");
                    },
                }),
                command({
                    kind: "chat-input",
                    id: "autocomplete-failure",
                    builder: new SlashCommandBuilder()
                        .setName("autocomplete-failure")
                        .setDescription("Autocomplete failure"),
                    autocomplete: () => {
                        throw new Error("autocomplete operation failed");
                    },
                }),
                command({
                    kind: "chat-input",
                    id: "primitive-failure",
                    builder: new SlashCommandBuilder()
                        .setName("primitive-failure")
                        .setDescription("Primitive failure"),
                    execute: () => {
                        throw new Error("primitive operation failure");
                    },
                }),
            ],
            {
                onError: (_error, context) => {
                    const commandName = (
                        context.interaction as ChatInputCommandInteraction
                    ).commandName;
                    calls.push({ phase: context.phase, commandName });
                    if (commandName === "primitive-failure")
                        throw primitiveBoundary;
                    throw commandName === "command-failure"
                        ? commandBoundary
                        : autocompleteBoundary;
                },
            },
        );
        const autocomplete = {
            commandName: "autocomplete-failure",
            isAutocomplete: () => true,
            isChatInputCommand: () => false,
            isContextMenuCommand: () => false,
        } as unknown as AutocompleteInteraction;

        const outcomes = await Promise.allSettled([
            instance.dispatch(chatInteraction("command-failure")),
            instance.dispatch(autocomplete),
            instance.dispatch(chatInteraction("primitive-failure")),
        ]);
        expect(outcomes[0]).toMatchObject({
            status: "rejected",
            reason: commandBoundary,
        });
        expect(outcomes[1]).toMatchObject({
            status: "rejected",
            reason: autocompleteBoundary,
        });
        expect(outcomes[2]).toEqual({
            status: "rejected",
            reason: primitiveBoundary,
        });
        expect(
            calls.sort((left, right) =>
                left.commandName.localeCompare(right.commandName),
            ),
        ).toEqual([
            {
                phase: "autocomplete",
                commandName: "autocomplete-failure",
            },
            { phase: "command", commandName: "command-failure" },
            { phase: "command", commandName: "primitive-failure" },
        ]);
    });

    test("reports a distinct wrapper error after catching an inner boundary failure", async () => {
        const innerBoundary = new Error("inner boundary failed");
        const wrapperFailure = new Error("wrapper failed separately");
        const reports: { error: unknown; phase?: string }[] = [];
        const instance = dispatcher(
            [
                command({
                    kind: "chat-input",
                    id: "broken",
                    builder: new SlashCommandBuilder()
                        .setName("broken")
                        .setDescription("Broken"),
                    execute: () => {
                        throw new Error("operation failed");
                    },
                }),
            ],
            {
                onError: (error, context) => {
                    if (context.phase === "command") throw innerBoundary;
                    reports.push({ error, phase: context.phase });
                },
                dispatchWrapper: async (_interaction, next) => {
                    try {
                        await next();
                    } catch (error) {
                        expect(error).toBe(innerBoundary);
                        throw wrapperFailure;
                    }
                    throw new Error("expected inner failure");
                },
            },
        );

        expect(await instance.dispatch(chatInteraction("broken"))).toEqual({
            handled: false,
            reason: "dispatch-failed",
        });
        expect(reports).toEqual([{ error: wrapperFailure, phase: "dispatch" }]);
    });

    test("joins unawaited next before returning and tracks it through stop", async () => {
        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        let releaseCleanup!: () => void;
        const cleanup = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        let cleaned = false;
        const bot = new DiscordBot(
            createBotRegistry([
                command({
                    kind: "chat-input",
                    id: "slow",
                    builder: new SlashCommandBuilder()
                        .setName("slow")
                        .setDescription("Slow"),
                    guildOnly: true,
                    execute: async (_client, _interaction, { signal }) => {
                        handlerStarted();
                        await new Promise<void>((resolve) => {
                            if (signal.aborted) resolve();
                            else
                                signal.addEventListener(
                                    "abort",
                                    () => resolve(),
                                    {
                                        once: true,
                                    },
                                );
                        });
                        await cleanup;
                        cleaned = true;
                    },
                }),
            ]),
            {
                token: "unused",
                clientOptions: { intents: [] },
                clientFactory: () => ({ destroy() {} }) as Client,
                dispatchWrapper: (_interaction, next) => {
                    void next();
                    return { handled: false, reason: "not-found" };
                },
            },
        );
        const dispatch = bot.dispatcher.dispatch(chatInteraction("slow"));
        await started;
        let stopped = false;
        const stopping = bot.stop().then(() => {
            stopped = true;
        });
        await Bun.sleep(0);
        expect(stopped).toBe(false);
        releaseCleanup();
        expect(await dispatch).toEqual({ handled: true, commandId: "slow" });
        await stopping;
        expect(cleaned).toBe(true);
        expect(stopped).toBe(true);
    });

    test("joins unawaited next before reporting a wrapper failure", async () => {
        let releaseHandler!: () => void;
        const handlerGate = new Promise<void>((resolve) => {
            releaseHandler = resolve;
        });
        let handlerFinished = false;
        const wrapperFailure = new Error("wrapper failed");
        const reports: { error: unknown; phase?: string }[] = [];
        const instance = dispatcher(
            [
                command({
                    kind: "chat-input",
                    id: "slow",
                    builder: new SlashCommandBuilder()
                        .setName("slow")
                        .setDescription("Slow"),
                    execute: async () => {
                        await handlerGate;
                        handlerFinished = true;
                    },
                }),
            ],
            {
                dispatchWrapper: (_interaction, next) => {
                    void next();
                    throw wrapperFailure;
                },
                onError: (error, context) => {
                    reports.push({ error, phase: context.phase });
                    expect(handlerFinished).toBe(true);
                },
            },
        );

        const dispatch = instance.dispatch(chatInteraction("slow"));
        await Bun.sleep(0);
        expect(handlerFinished).toBe(false);
        releaseHandler();
        expect(await dispatch).toEqual({
            handled: false,
            reason: "dispatch-failed",
        });
        expect(reports).toEqual([{ error: wrapperFailure, phase: "dispatch" }]);
    });

    test("stop waits for wrapper and cooperative hook cleanup", async () => {
        let wrapperStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            wrapperStarted = resolve;
        });
        let releaseCleanup!: () => void;
        const cleanup = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        let cleaned = false;
        const bot = new DiscordBot(createBotRegistry([]), {
            token: "unused",
            clientOptions: { intents: [] },
            clientFactory: () => ({ destroy() {} }) as Client,
            dispatchWrapper: async (_interaction, next, { signal }) => {
                wrapperStarted();
                try {
                    return await next();
                } finally {
                    await new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else
                            signal.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                    });
                    await cleanup;
                    cleaned = true;
                }
            },
            onUnhandledInteraction: async (
                _interaction,
                _result,
                { signal },
            ) => {
                await new Promise<void>((resolve) => {
                    if (signal.aborted) resolve();
                    else
                        signal.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                });
            },
        });
        const dispatch = bot.dispatcher.dispatch(chatInteraction("missing"));
        await started;
        let stopped = false;
        const stopping = bot.stop().then(() => {
            stopped = true;
        });
        await Bun.sleep(0);
        expect(stopped).toBe(false);
        releaseCleanup();
        await Promise.all([dispatch, stopping]);
        expect(cleaned).toBe(true);
        expect(stopped).toBe(true);
    });

    test("stop settles an InteractionCreate callback aborted before its tracker callback starts", async () => {
        const client = new EventEmitter() as EventEmitter & {
            login: () => Promise<string>;
            destroy: () => void;
        };
        client.login = async () => "token";
        client.destroy = () => {};
        const errors: { phase?: string; aborted?: boolean }[] = [];
        let deferred = 0;
        let executed = 0;
        const interaction = chatInteraction("race", {
            deferReply: async () => {
                deferred++;
            },
        });
        const bot = new DiscordBot(
            createBotRegistry([
                command({
                    kind: "chat-input",
                    id: "race",
                    builder: new SlashCommandBuilder()
                        .setName("race")
                        .setDescription("Race"),
                    execution: { defer: true },
                    execute: () => {
                        executed++;
                    },
                }),
            ]),
            {
                token: "token",
                clientOptions: { intents: [] },
                clientFactory: () => client as unknown as Client,
                onError: (_error, context) => {
                    errors.push({
                        phase: context.phase,
                        aborted: context.aborted ?? false,
                    });
                },
            },
        );

        await bot.start();
        client.emit(Events.InteractionCreate, interaction);
        await bot.stop();

        expect(deferred).toBe(0);
        expect(executed).toBe(0);
        expect(errors).toEqual([{ phase: "dispatch", aborted: true }]);
    });

    test("keeps timeout handling inside command phase while stop awaits wrapper cleanup", async () => {
        let commandError!: () => void;
        const timedOut = new Promise<void>((resolve) => {
            commandError = resolve;
        });
        let releaseCleanup!: () => void;
        const cleanup = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        let wrapperCleaned = false;
        const bot = new DiscordBot(
            createBotRegistry([
                command({
                    kind: "chat-input",
                    id: "slow",
                    builder: new SlashCommandBuilder()
                        .setName("slow")
                        .setDescription("Slow"),
                    guildOnly: true,
                    execution: { timeoutMs: 5 },
                    execute: async (_client, _interaction, { signal }) =>
                        new Promise<void>((resolve) => {
                            signal.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                        }),
                }),
            ]),
            {
                token: "unused",
                clientOptions: { intents: [] },
                clientFactory: () => ({ destroy() {} }) as Client,
                onError: (_error, context) => {
                    if (context.phase === "command") commandError();
                },
                dispatchWrapper: async (_interaction, next, { signal }) => {
                    const result = await next();
                    await new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else
                            signal.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                    });
                    await cleanup;
                    wrapperCleaned = true;
                    return result;
                },
            },
        );
        const dispatch = bot.dispatcher.dispatch(chatInteraction("slow"));
        await timedOut;
        let stopped = false;
        const stopping = bot.stop().then(() => {
            stopped = true;
        });
        await Bun.sleep(0);
        expect(stopped).toBe(false);
        releaseCleanup();
        expect(await dispatch).toEqual({ handled: true, commandId: "slow" });
        await stopping;
        expect(wrapperCleaned).toBe(true);
    });
});
