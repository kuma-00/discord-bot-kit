import type {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    Client,
    ClientEvents,
    ClientOptions,
    ContextMenuCommandBuilder,
    ContextMenuCommandInteraction,
    Guild,
    Interaction,
    MessageContextMenuCommandInteraction,
    SlashCommandBuilder,
    SlashCommandSubcommandBuilder,
    SlashCommandSubcommandGroupBuilder,
    UserContextMenuCommandInteraction,
} from "discord.js";

/** Optional structured logger used for bot lifecycle and operation failures. */
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

/** Default or per-command defer, visibility, and timeout behavior. */
export interface ExecutionPolicy {
    readonly defer?: boolean | undefined;
    readonly ephemeral?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
}

/** Cancellation context supplied to command and event handlers. */
export interface ExecutionContext<TServices = undefined> {
    /** Consumer-owned object passed unchanged; initialization and disposal stay with the consumer. */
    readonly services: TServices;
    readonly signal: AbortSignal;
}

/** Chat-input interaction narrowed to a guild context. */
export type GuildChatInputCommandInteraction = ChatInputCommandInteraction & {
    readonly guild: Guild;
    readonly guildId: string;
};

/** Context-menu interaction narrowed to a guild context. */
export type GuildContextMenuCommandInteraction =
    ContextMenuCommandInteraction & {
        readonly guild: Guild;
        readonly guildId: string;
    };

/** Consumer-owned descriptive metadata carried without runtime interpretation. */
export interface CommandMetadata {
    readonly category?: string;
    readonly description?: string;
    readonly hidden?: boolean;
    readonly [key: string]: unknown;
}

interface CommandBase {
    readonly id: string;
    readonly metadata?: CommandMetadata;
    readonly execution?: ExecutionPolicy;
}

interface ChatInputCommandBase<TServices = undefined> extends CommandBase {
    readonly kind: "chat-input";
    readonly builder: SlashCommandBuilder;
    readonly autocomplete?: (
        client: Client,
        interaction: AutocompleteInteraction,
        context: ExecutionContext<TServices>,
    ) => Promise<void> | void;
}

/** Top-level chat-input command that may execute outside guilds. */
export interface GlobalChatInputCommand<TServices = undefined>
    extends ChatInputCommandBase<TServices> {
    readonly guildOnly?: false;
    readonly execute?: (
        client: Client,
        interaction: ChatInputCommandInteraction,
        context: ExecutionContext<TServices>,
    ) => Promise<void> | void;
}

/** Top-level chat-input command whose handler receives guild-present types. */
export interface GuildChatInputCommand<TServices = undefined>
    extends ChatInputCommandBase<TServices> {
    readonly guildOnly: true;
    readonly execute?: (
        client: Client,
        interaction: GuildChatInputCommandInteraction,
        context: ExecutionContext<TServices>,
    ) => Promise<void> | void;
}

interface SubcommandBase extends CommandBase {
    readonly kind: "subcommand";
    readonly parentId: string;
    readonly groupId?: string;
    readonly builder: (
        builder: SlashCommandSubcommandBuilder,
    ) => SlashCommandSubcommandBuilder;
}

/** Slash subcommand that may execute outside guilds. */
export interface GlobalSubcommand<TServices = undefined>
    extends SubcommandBase {
    readonly guildOnly?: false;
    readonly execute: (
        client: Client,
        interaction: ChatInputCommandInteraction,
        context: ExecutionContext<TServices>,
    ) => Promise<void> | void;
}

/** Slash subcommand whose handler receives guild-present types. */
export interface GuildSubcommand<TServices = undefined> extends SubcommandBase {
    readonly guildOnly: true;
    readonly execute: (
        client: Client,
        interaction: GuildChatInputCommandInteraction,
        context: ExecutionContext<TServices>,
    ) => Promise<void> | void;
}

/** Declarative subcommand group composed into its parent command at startup. */
export interface SubcommandGroup extends CommandBase {
    readonly kind: "subcommand-group";
    readonly parentId: string;
    readonly builder: (
        builder: SlashCommandSubcommandGroupBuilder,
    ) => SlashCommandSubcommandGroupBuilder;
}

interface ContextMenuCommandBase extends CommandBase {
    readonly kind: "context-menu";
    readonly builder: ContextMenuCommandBuilder;
}

/** User or message context-menu command that may execute outside guilds. */
export interface GlobalContextMenuCommand<TServices = undefined>
    extends ContextMenuCommandBase {
    readonly guildOnly?: false;
    readonly execute: (
        client: Client,
        interaction:
            | UserContextMenuCommandInteraction
            | MessageContextMenuCommandInteraction,
        context: ExecutionContext<TServices>,
    ) => Promise<void> | void;
}

/** Context-menu command whose handler receives guild-present types. */
export interface GuildContextMenuCommand<TServices = undefined>
    extends ContextMenuCommandBase {
    readonly guildOnly: true;
    readonly execute: (
        client: Client,
        interaction:
            | (UserContextMenuCommandInteraction & {
                  readonly guild: Guild;
                  readonly guildId: string;
              })
            | (MessageContextMenuCommandInteraction & {
                  readonly guild: Guild;
                  readonly guildId: string;
              }),
        context: ExecutionContext<TServices>,
    ) => Promise<void> | void;
}

/** Supported discriminated union of static Discord command definitions. */
export type BotCommand<TServices = undefined> =
    | GlobalChatInputCommand<TServices>
    | GuildChatInputCommand<TServices>
    | GlobalSubcommand<TServices>
    | GuildSubcommand<TServices>
    | SubcommandGroup
    | GlobalContextMenuCommand<TServices>
    | GuildContextMenuCommand<TServices>;

/** Static Discord event handler with optional timeout and once semantics. */
export type BotEvent<
    TClient extends Client = Client,
    TEvent extends keyof ClientEvents = keyof ClientEvents,
    TServices = undefined,
> = TEvent extends keyof ClientEvents
    ? {
          readonly id: string;
          readonly event: TEvent;
          readonly once?: boolean;
          readonly timeoutMs?: number;
          readonly execute: (
              client: TClient,
              args: ClientEvents[TEvent],
              context: ExecutionContext<TServices>,
          ) => Promise<void> | void;
      }
    : never;

/** Structured outcome returned after attempting interaction dispatch. */
export type DispatchResult =
    | { readonly handled: true; readonly commandId: string }
    | {
          readonly handled: false;
          readonly reason:
              | "unsupported-interaction"
              | "not-found"
              | "kind-mismatch"
              | "handler-missing"
              | "guild-only"
              | "dispatch-failed";
          readonly commandId?: string;
      };

/** Operation phase and optional interaction metadata supplied on failure. */
export interface BotErrorContext {
    readonly phase:
        | "command"
        | "autocomplete"
        | "event"
        | "lifecycle"
        | "dispatch";
    readonly id?: string;
    readonly interaction?: Interaction;
    readonly timedOut?: boolean;
    readonly aborted?: boolean;
}

/** Injectable async-compatible error boundary for bot operations. */
export type BotErrorHandler = (
    error: unknown,
    context: BotErrorContext,
) => Promise<void> | void;

/**
 * Client construction, credentials, logging, and execution defaults.
 *
 * The factory is required so the runtime client always matches the client type
 * promised by commands, events, and the registry.
 */
interface DiscordBotRuntimeBase<TClient extends Client, TServices> {
    /** Wraps the entire dispatch, including defer and the unhandled hook. next may run once only. */
    readonly dispatchWrapper?: DispatchWrapper<TServices> | undefined;
    /** Observes each unhandled result once; the consumer owns replies and fallbacks. */
    readonly onUnhandledInteraction?:
        | UnhandledInteractionHandler<TServices>
        | undefined;
    readonly token: string;
    readonly clientOptions: ClientOptions;
    readonly clientFactory: (options: ClientOptions) => TClient;
    readonly logger?: BotLogger;
    readonly onError?: BotErrorHandler;
    readonly execution?: ExecutionPolicy | undefined;
}

/** Requires services for a typed registry; legacy registries may omit it. */
export type ServicesOptions<TServices> = [TServices] extends [undefined]
    ? { readonly services?: TServices }
    : { readonly services: TServices };

/** Runtime options preserve client and consumer services as independent types. */
export type DiscordBotRuntimeOptions<
    TClient extends Client = Client,
    TServices = undefined,
> = DiscordBotRuntimeBase<TClient, TServices> & ServicesOptions<TServices>;

/** Wraps dispatch from before defer through fallback; await next before returning. Cancellation is cooperative. */
export type DispatchWrapper<TServices = undefined> = (
    interaction: Interaction,
    next: () => Promise<DispatchResult>,
    context: ExecutionContext<TServices>,
) => Promise<DispatchResult> | DispatchResult;

/** Observes unhandled interactions without a Kit-owned automatic reply. */
export type UnhandledInteractionHandler<TServices = undefined> = (
    interaction: Interaction,
    result: Extract<DispatchResult, { handled: false }>,
    context: ExecutionContext<TServices>,
) => Promise<void> | void;
