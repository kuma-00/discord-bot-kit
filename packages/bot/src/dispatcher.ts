import type {
    ChatInputCommandInteraction,
    Client,
    Interaction,
} from "discord.js";
import { ExecutionTimeoutError } from "./errors.ts";
import { OperationTracker } from "./execution.ts";
import type { BotRegistry } from "./registry.ts";
import type {
    BotCommand,
    BotErrorHandler,
    DispatchResult,
    ExecutionPolicy,
} from "./types.ts";

/** Dependencies and default execution policy used by a command dispatcher. */
export interface CommandDispatcherOptions<TClient extends Client> {
    readonly client: TClient;
    readonly registry: BotRegistry;
    readonly execution?: ExecutionPolicy | undefined;
    readonly onError?: BotErrorHandler;
    readonly tracker?: OperationTracker;
}

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
export class CommandDispatcher<TClient extends Client> {
    readonly tracker: OperationTracker;

    constructor(private readonly options: CommandDispatcherOptions<TClient>) {
        this.tracker = options.tracker ?? new OperationTracker();
    }

    /** Dispatches one supported interaction and reports whether it was handled. */
    async dispatch(interaction: Interaction): Promise<DispatchResult> {
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
            await this.execute(root, "autocomplete", interaction, (signal) =>
                root.autocomplete?.(this.options.client, interaction, {
                    signal,
                }),
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
        await this.execute(command, "command", interaction, async (signal) => {
            if (
                policy.defer &&
                interaction.isRepliable() &&
                !interaction.deferred &&
                !interaction.replied
            ) {
                await interaction.deferReply({
                    ephemeral: policy.ephemeral ?? false,
                });
            }
            const execute = command.execute as unknown as (
                client: Client,
                interaction: Interaction,
                context: { signal: AbortSignal },
            ) => Promise<void> | void;
            if (command.kind === "context-menu") {
                return execute(
                    this.options.client,
                    interaction as unknown as Interaction,
                    { signal },
                );
            }
            return execute?.(
                this.options.client,
                interaction as ChatInputCommandInteraction,
                { signal },
            );
        });
        return { handled: true, commandId: key };
    }

    private async execute(
        command: BotCommand,
        phase: "command" | "autocomplete",
        interaction: Interaction,
        operation: (signal: AbortSignal) => Promise<void> | void | undefined,
    ): Promise<void> {
        const policy = mergePolicy(this.options.execution, command.execution);
        try {
            await this.tracker.run(command.id, policy.timeoutMs, operation);
        } catch (error) {
            if (!this.options.onError) throw error;
            await this.options.onError(error, {
                phase,
                id: command.id,
                interaction,
                timedOut: error instanceof ExecutionTimeoutError,
                aborted:
                    error instanceof ExecutionTimeoutError ||
                    (error instanceof Error && error.name === "AbortError"),
            });
        }
    }
}
