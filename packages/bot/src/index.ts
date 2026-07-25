import {
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    Client,
    type ClientEvents,
    type ClientOptions,
    Events,
    type Interaction,
} from "discord.js";

/** Logger surface used by the Discord bot runtime. */
export interface BotLogger {
    readonly info?: (
        message: string,
        context?: Readonly<Record<string, unknown>>,
    ) => void;
    readonly error?: (
        message: string,
        context?: Readonly<Record<string, unknown>>,
    ) => void;
}

/** Static slash command definition. */
export interface BotCommand<TClient extends Client = Client> {
    readonly id: string;
    readonly execute: (
        client: TClient,
        interaction: ChatInputCommandInteraction,
    ) => Promise<void> | void;
    readonly autocomplete?: (
        client: TClient,
        interaction: AutocompleteInteraction,
    ) => Promise<void> | void;
}

/** Static Discord event definition. */
export interface BotEvent<
    TClient extends Client = Client,
    TEvent extends keyof ClientEvents = keyof ClientEvents,
> {
    readonly id: TEvent;
    readonly once?: boolean;
    readonly execute: (
        client: TClient,
        ...args: ClientEvents[TEvent]
    ) => Promise<void> | void;
}

/** Duplicate identifier error raised while constructing a registry. */
export class DuplicateRegistryEntryError extends Error {
    constructor(
        readonly registry: "command" | "event",
        readonly id: string,
    ) {
        super(`Duplicate ${registry} registry entry: ${id}`);
        this.name = "DuplicateRegistryEntryError";
    }
}

/** Creates a case-insensitive command registry and rejects duplicate IDs. */
export function createCommandRegistry<TClient extends Client>(
    commands: ReadonlyArray<BotCommand<TClient>>,
): ReadonlyMap<string, BotCommand<TClient>> {
    const registry = new Map<string, BotCommand<TClient>>();
    for (const command of commands) {
        const id = command.id.trim().toLowerCase();
        if (registry.has(id)) {
            throw new DuplicateRegistryEntryError("command", id);
        }
        registry.set(id, command);
    }
    return registry;
}

/** Validates event IDs and returns an immutable registry array. */
export function createEventRegistry<TClient extends Client>(
    events: ReadonlyArray<BotEvent<TClient>>,
): ReadonlyArray<BotEvent<TClient>> {
    const ids = new Set<string>();
    for (const event of events) {
        const id = String(event.id);
        if (ids.has(id)) {
            throw new DuplicateRegistryEntryError("event", id);
        }
        ids.add(id);
    }
    return [...events];
}

/** Context supplied to a bot error boundary. */
export interface BotErrorContext {
    readonly phase: "command" | "autocomplete" | "event" | "lifecycle";
    readonly id?: string;
    readonly interaction?: Interaction;
}

/** Handles an exception raised by user-provided bot code. */
export type BotErrorHandler = (
    error: unknown,
    context: BotErrorContext,
) => Promise<void> | void;

async function defaultErrorHandler(
    error: unknown,
    context: BotErrorContext,
    logger?: BotLogger,
): Promise<void> {
    logger?.error?.("Discord bot operation failed", {
        error,
        phase: context.phase,
        id: context.id,
    });
    const interaction = context.interaction;
    if (!interaction?.isRepliable()) return;
    const message = {
        content: "An unexpected error occurred.",
        ephemeral: true,
    };
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(message);
        } else {
            await interaction.reply(message);
        }
    } catch {
        // Error reporting must not replace the original failure.
    }
}

/** Options used to construct a testable Discord bot runtime. */
export interface CreateDiscordBotOptions<TClient extends Client> {
    readonly token: string;
    readonly clientOptions: ClientOptions;
    readonly commands?: ReadonlyArray<BotCommand<TClient>>;
    readonly events?: ReadonlyArray<BotEvent<TClient>>;
    readonly clientFactory?: (options: ClientOptions) => TClient;
    readonly logger?: BotLogger;
    readonly onError?: BotErrorHandler;
    readonly deferCommands?: boolean;
}

/** Lifecycle-managed Discord bot with static command and event registries. */
export class DiscordBot<TClient extends Client = Client> {
    readonly client: TClient;
    readonly commands: ReadonlyMap<string, BotCommand<TClient>>;
    readonly events: ReadonlyArray<BotEvent<TClient>>;
    private started = false;
    private registered = false;

    constructor(private readonly options: CreateDiscordBotOptions<TClient>) {
        this.client = (
            options.clientFactory ??
            ((clientOptions: ClientOptions) =>
                new Client(clientOptions) as TClient)
        )(options.clientOptions);
        this.commands = createCommandRegistry(options.commands ?? []);
        this.events = createEventRegistry(options.events ?? []);
    }

    /** Registers handlers and logs in once. */
    async start(): Promise<TClient> {
        if (this.started) return this.client;
        this.registerHandlers();
        try {
            await this.client.login(this.options.token);
            this.started = true;
            this.options.logger?.info?.("Discord bot started");
            return this.client;
        } catch (error) {
            await this.handleError(error, { phase: "lifecycle", id: "start" });
            throw error;
        }
    }

    /** Destroys the Discord client. Calling stop repeatedly is safe. */
    async stop(): Promise<void> {
        if (!this.started) return;
        try {
            this.client.destroy();
            this.started = false;
            this.options.logger?.info?.("Discord bot stopped");
        } catch (error) {
            await this.handleError(error, { phase: "lifecycle", id: "stop" });
            throw error;
        }
    }

    /** Dispatches one Discord interaction through the command registry. */
    async dispatchInteraction(interaction: Interaction): Promise<boolean> {
        if (
            !interaction.isChatInputCommand() &&
            !interaction.isAutocomplete()
        ) {
            return false;
        }
        const command = this.commands.get(
            interaction.commandName.toLowerCase(),
        );
        if (!command) return false;
        if (interaction.isAutocomplete()) {
            if (!command.autocomplete) return false;
            try {
                await command.autocomplete(this.client, interaction);
            } catch (error) {
                await this.handleError(error, {
                    phase: "autocomplete",
                    id: command.id,
                    interaction,
                });
            }
            return true;
        }
        try {
            if (
                (this.options.deferCommands ?? true) &&
                !interaction.deferred &&
                !interaction.replied
            ) {
                await interaction.deferReply();
            }
            await command.execute(this.client, interaction);
        } catch (error) {
            await this.handleError(error, {
                phase: "command",
                id: command.id,
                interaction,
            });
        }
        return true;
    }

    private registerHandlers(): void {
        if (this.registered) return;
        this.registered = true;
        this.client.on(Events.InteractionCreate, (interaction) => {
            void this.dispatchInteraction(interaction);
        });
        for (const event of this.events) {
            const listener = (...args: ClientEvents[typeof event.id]) => {
                Promise.resolve(event.execute(this.client, ...args)).catch(
                    (error: unknown) =>
                        this.handleError(error, {
                            phase: "event",
                            id: String(event.id),
                        }),
                );
            };
            if (event.once) {
                this.client.once(event.id, listener);
            } else {
                this.client.on(event.id, listener);
            }
        }
    }

    private handleError(
        error: unknown,
        context: BotErrorContext,
    ): Promise<void> {
        return Promise.resolve(
            this.options.onError?.(error, context) ??
                defaultErrorHandler(error, context, this.options.logger),
        );
    }
}

/** Creates a lifecycle-managed Discord bot. */
export function createDiscordBot<TClient extends Client = Client>(
    options: CreateDiscordBotOptions<TClient>,
): DiscordBot<TClient> {
    return new DiscordBot(options);
}
