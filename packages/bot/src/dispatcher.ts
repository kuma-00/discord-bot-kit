import type {
    ChatInputCommandInteraction,
    Client,
    Interaction,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { ExecutionTimeoutError } from "./errors.ts";
import { OperationTracker } from "./execution.ts";
import type { BotRegistry } from "./registry.ts";
import type {
    BotCommand,
    BotErrorHandler,
    DispatchResult,
    DispatchWrapper,
    ExecutionContext,
    ExecutionPolicy,
    ServicesOptions,
    UnhandledInteractionHandler,
} from "./types.ts";

/** Dependencies and default execution policy used by a command dispatcher. */
interface CommandDispatcherBase<TClient extends Client, TServices> {
    readonly dispatchWrapper?: DispatchWrapper<TServices> | undefined;
    readonly onUnhandledInteraction?:
        | UnhandledInteractionHandler<TServices>
        | undefined;
    readonly client: TClient;
    readonly registry: BotRegistry<TClient, TServices>;
    readonly execution?: ExecutionPolicy | undefined;
    readonly onError?: BotErrorHandler;
    readonly tracker?: OperationTracker;
}

/** Typed services and hooks used by standalone dispatch and DiscordBot. */
export type CommandDispatcherOptions<
    TClient extends Client,
    TServices = undefined,
> = CommandDispatcherBase<TClient, TServices> & ServicesOptions<TServices>;

function commandPath(interaction: ChatInputCommandInteraction): string {
    const root = interaction.commandName.toLowerCase();
    const group = interaction.options.getSubcommandGroup(false)?.toLowerCase();
    const sub = interaction.options.getSubcommand(false)?.toLowerCase();
    if (group && sub) return `${root}/${group}/${sub}`;
    if (sub) return `${root}/${sub}`;
    return root;
}

function mergePolicy(
    defaults: ExecutionPolicy | undefined,
    override: ExecutionPolicy | undefined,
): ExecutionPolicy {
    return {
        defer: override?.defer ?? defaults?.defer,
        ephemeral: override?.ephemeral ?? defaults?.ephemeral,
        timeoutMs: override?.timeoutMs ?? defaults?.timeoutMs,
    };
}

/**
 * Dispatches supported Discord interactions through a validated static registry.
 *
 * Handler and defer failures are delivered to the configured error boundary,
 * or rethrown when no boundary is configured.
 */
export class CommandDispatcher<TClient extends Client, TServices = undefined> {
    readonly tracker: OperationTracker;

    constructor(
        private readonly options: CommandDispatcherOptions<TClient, TServices>,
    ) {
        this.tracker = options.tracker ?? new OperationTracker();
    }

    /** Dispatches one supported interaction and reports whether it was handled. */
    async dispatch(interaction: Interaction): Promise<DispatchResult> {
        return this.tracker.run("dispatch", undefined, async (signal) => {
            const innerBoundaryFailures = new Set<unknown>();
            const context: ExecutionContext<TServices> = {
                signal,
                services: this.options.services as TServices,
            };
            let called = false;
            let finished = false;
            let pending: Promise<DispatchResult> | undefined;
            const next = (): Promise<DispatchResult> => {
                if (called || finished)
                    throw new Error(
                        "dispatch next may only be called once while the wrapper is active",
                    );
                called = true;
                signal.throwIfAborted();
                pending = (async () => {
                    const result = await this.dispatchInternal(
                        interaction,
                        signal,
                        innerBoundaryFailures,
                    );
                    if (!result.handled)
                        await this.options.onUnhandledInteraction?.(
                            interaction,
                            result,
                            context,
                        );
                    return result;
                })();
                // A wrapper may throw before awaiting next; contain that rejection until it is joined below.
                void pending.catch(() => {});
                return pending;
            };
            try {
                const result = this.options.dispatchWrapper
                    ? await this.options.dispatchWrapper(
                          interaction,
                          next,
                          context,
                      )
                    : await next();
                finished = true;
                if (pending) return await pending;
                return result;
            } catch (error) {
                finished = true;
                await pending?.catch(() => {});
                if (innerBoundaryFailures.has(error)) throw error;
                if (!this.options.onError) throw error;
                await this.options.onError(error, {
                    phase: "dispatch",
                    interaction,
                    timedOut: error instanceof ExecutionTimeoutError,
                    aborted:
                        signal.aborted ||
                        (error instanceof Error && error.name === "AbortError"),
                });
                return { handled: false, reason: "dispatch-failed" };
            } finally {
                finished = true;
            }
        });
    }

    private async dispatchInternal(
        interaction: Interaction,
        parentSignal: AbortSignal,
        innerBoundaryFailures: Set<unknown>,
    ): Promise<DispatchResult> {
        if (
            !interaction.isChatInputCommand() &&
            !interaction.isContextMenuCommand() &&
            !interaction.isAutocomplete()
        ) {
            return { handled: false, reason: "unsupported-interaction" };
        }

        const rootId = interaction.commandName.toLowerCase();
        const root = this.options.registry.rootCommands.get(rootId);
        if (!root) return { handled: false, reason: "not-found" };

        if (interaction.isAutocomplete()) {
            if (root.kind !== "chat-input") {
                return {
                    handled: false,
                    reason: "kind-mismatch",
                    commandId: rootId,
                };
            }
            if (!root.autocomplete) {
                return {
                    handled: false,
                    reason: "handler-missing",
                    commandId: rootId,
                };
            }
            await this.execute(
                root,
                "autocomplete",
                interaction,
                (signal) =>
                    root.autocomplete?.(this.options.client, interaction, {
                        signal,
                        services: this.options.services as TServices,
                    }),
                parentSignal,
                innerBoundaryFailures,
            );
            return { handled: true, commandId: rootId };
        }

        const key = interaction.isChatInputCommand()
            ? commandPath(interaction)
            : rootId;
        const command = this.options.registry.executableCommands.get(key);
        if (!command) {
            return { handled: false, reason: "not-found", commandId: key };
        }
        if (
            (interaction.isChatInputCommand() &&
                command.kind !== "chat-input" &&
                command.kind !== "subcommand") ||
            (interaction.isContextMenuCommand() &&
                command.kind !== "context-menu")
        ) {
            return {
                handled: false,
                reason: "kind-mismatch",
                commandId: key,
            };
        }
        if (
            "guildOnly" in command &&
            command.guildOnly &&
            !interaction.inCachedGuild()
        ) {
            return { handled: false, reason: "guild-only", commandId: key };
        }
        if (
            (command.kind === "chat-input" && !command.execute) ||
            command.kind === "subcommand-group"
        ) {
            return {
                handled: false,
                reason: "handler-missing",
                commandId: key,
            };
        }

        const policy = mergePolicy(this.options.execution, command.execution);
        await this.execute(
            command,
            "command",
            interaction,
            async (signal) => {
                if (
                    policy.defer &&
                    interaction.isRepliable() &&
                    !interaction.deferred &&
                    !interaction.replied
                ) {
                    await interaction.deferReply(
                        policy.ephemeral
                            ? { flags: MessageFlags.Ephemeral }
                            : {},
                    );
                }
                const execute = command.execute as unknown as (
                    client: Client,
                    interaction: Interaction,
                    context: ExecutionContext<TServices>,
                ) => Promise<void> | void;
                if (command.kind === "context-menu") {
                    return execute(
                        this.options.client,
                        interaction as unknown as Interaction,
                        {
                            signal,
                            services: this.options.services as TServices,
                        },
                    );
                }
                return execute?.(
                    this.options.client,
                    interaction as ChatInputCommandInteraction,
                    { signal, services: this.options.services as TServices },
                );
            },
            parentSignal,
            innerBoundaryFailures,
        );
        return { handled: true, commandId: key };
    }

    private async execute(
        command: BotCommand<TServices>,
        phase: "command" | "autocomplete",
        interaction: Interaction,
        operation: (signal: AbortSignal) => Promise<void> | void | undefined,
        parentSignal: AbortSignal,
        innerBoundaryFailures: Set<unknown>,
    ): Promise<void> {
        const policy = mergePolicy(this.options.execution, command.execution);
        try {
            await this.tracker.run(
                command.id,
                policy.timeoutMs,
                (signal) => {
                    signal.throwIfAborted();
                    return operation(signal);
                },
                parentSignal,
            );
        } catch (error) {
            if (!this.options.onError) throw error;
            try {
                await this.options.onError(error, {
                    phase,
                    id: command.id,
                    interaction,
                    timedOut: error instanceof ExecutionTimeoutError,
                    aborted:
                        error instanceof ExecutionTimeoutError ||
                        (error instanceof Error && error.name === "AbortError"),
                });
            } catch (boundaryError) {
                innerBoundaryFailures.add(boundaryError);
                throw boundaryError;
            }
        }
    }
}
