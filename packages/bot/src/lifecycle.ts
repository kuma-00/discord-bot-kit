import {
    type Client,
    type ClientEvents,
    Events,
    type Interaction,
} from "discord.js";
import { CommandDispatcher } from "./dispatcher.ts";
import { ExecutionTimeoutError } from "./errors.ts";
import { OperationTracker } from "./execution.ts";
import type { BotRegistry } from "./registry.ts";
import type { BotErrorContext, DiscordBotRuntimeOptions } from "./types.ts";

type RegisteredListener = {
    readonly event: keyof ClientEvents;
    readonly listener: (...args: never[]) => void;
};

/**
 * Owns a Discord client, its registered handlers, and active executions.
 *
 * Concurrent starts share one login. A start requested during stop waits for
 * shutdown and then starts again.
 */
export class DiscordBot<TClient extends Client = Client> {
    readonly client: TClient;
    readonly dispatcher: CommandDispatcher<TClient>;
    private readonly tracker = new OperationTracker();
    private readonly listeners: RegisteredListener[] = [];
    private startPromise: Promise<TClient> | undefined;
    private stopPromise: Promise<void> | undefined;
    private started = false;
    private registered = false;

    constructor(
        readonly registry: BotRegistry<TClient>,
        private readonly options: DiscordBotRuntimeOptions<TClient>,
    ) {
        this.client = options.clientFactory(options.clientOptions);
        this.dispatcher = new CommandDispatcher({
            client: this.client,
            registry,
            execution: options.execution,
            onError: (error, context) => this.handleError(error, context),
            tracker: this.tracker,
        });
    }

    /** Registers handlers and logs in, coalescing concurrent start requests. */
    start(): Promise<TClient> {
        if (this.stopPromise) {
            return this.stopPromise.then(() => this.start());
        }
        if (this.started) return Promise.resolve(this.client);
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.startInternal().finally(() => {
            this.startPromise = undefined;
        });
        return this.startPromise;
    }

    /** Removes handlers, settles active work, and destroys the client once. */
    stop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.stopPromise = this.stopInternal().finally(() => {
            this.stopPromise = undefined;
        });
        return this.stopPromise;
    }

    private async stopInternal(): Promise<void> {
        this.unregisterHandlers();
        await this.tracker.abortAndSettle(
            new DOMException("Discord bot stopped", "AbortError"),
        );
        await this.startPromise?.catch(() => {});
        if (!this.started) return;
        try {
            this.client.destroy();
            this.started = false;
            this.logInfo("Discord bot stopped");
        } catch (error) {
            await this.handleError(error, {
                phase: "lifecycle",
                id: "stop",
            });
            throw error;
        }
    }

    private async startInternal(): Promise<TClient> {
        this.registerHandlers();
        try {
            await this.client.login(this.options.token);
            this.started = true;
            this.logInfo("Discord bot started");
            return this.client;
        } catch (error) {
            this.unregisterHandlers();
            await this.handleError(error, {
                phase: "lifecycle",
                id: "start",
            });
            throw error;
        }
    }

    private registerHandlers(): void {
        if (this.registered) return;
        this.registered = true;
        const interactionListener = (interaction: Interaction) => {
            void this.dispatcher.dispatch(interaction);
        };
        this.client.on(Events.InteractionCreate, interactionListener);
        this.listeners.push({
            event: Events.InteractionCreate,
            listener: interactionListener as (...args: never[]) => void,
        });

        for (const definition of this.registry.events) {
            const listener = (
                ...args: ClientEvents[typeof definition.event]
            ) => {
                const execute = definition.execute as (
                    client: TClient,
                    args: ClientEvents[typeof definition.event],
                    context: { readonly signal: AbortSignal },
                ) => Promise<void> | void;
                void this.tracker
                    .run(definition.id, definition.timeoutMs, (signal) =>
                        execute(this.client, args, { signal }),
                    )
                    .catch((error) =>
                        this.handleError(error, {
                            phase: "event",
                            id: definition.id,
                            timedOut: error instanceof ExecutionTimeoutError,
                            aborted:
                                error instanceof ExecutionTimeoutError ||
                                (error instanceof Error &&
                                    error.name === "AbortError"),
                        }),
                    );
            };
            if (definition.once) {
                this.client.once(definition.event, listener);
            } else {
                this.client.on(definition.event, listener);
            }
            this.listeners.push({
                event: definition.event,
                listener: listener as (...args: never[]) => void,
            });
        }
    }

    private unregisterHandlers(): void {
        for (const { event, listener } of this.listeners) {
            (
                this.client as unknown as {
                    off(
                        event: string,
                        listener: (...args: never[]) => void,
                    ): unknown;
                }
            ).off(String(event), listener);
        }
        this.listeners.length = 0;
        this.registered = false;
    }

    private async handleError(
        error: unknown,
        context: BotErrorContext,
    ): Promise<void> {
        if (this.options.onError) {
            try {
                await this.options.onError(error, context);
                return;
            } catch (handlerError) {
                this.logError("Discord bot error handler failed", {
                    error: handlerError,
                    originalError: error,
                    ...context,
                });
                return;
            }
        }
        this.logError("Discord bot operation failed", {
            error,
            ...context,
        });
    }

    private logError(
        message: string,
        context: Readonly<Record<string, unknown>>,
    ): void {
        try {
            void Promise.resolve(
                this.options.logger?.error?.(message, context),
            ).catch(() => {});
        } catch {
            // Logging must not create an unhandled lifecycle rejection.
        }
    }

    private logInfo(message: string): void {
        try {
            void Promise.resolve(this.options.logger?.info?.(message)).catch(
                () => {},
            );
        } catch {
            // Logging must not create an unhandled lifecycle rejection.
        }
    }
}

/** Creates a lifecycle-managed Discord bot for a validated registry. */
export function createDiscordBot<TClient extends Client = Client>(
    registry: BotRegistry<TClient>,
    options: DiscordBotRuntimeOptions<TClient>,
): DiscordBot<TClient> {
    return new DiscordBot(registry, options);
}
