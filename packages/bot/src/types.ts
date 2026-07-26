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
export interface ExecutionContext {
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

interface ChatInputCommandBase extends CommandBase {
    readonly kind: "chat-input";
    readonly builder: SlashCommandBuilder;
    readonly autocomplete?: (
        client: Client,
        interaction: AutocompleteInteraction,
        context: ExecutionContext,
    ) => Promise<void> | void;
}

/** Top-level chat-input command that may execute outside guilds. */
export interface GlobalChatInputCommand extends ChatInputCommandBase {
    readonly guildOnly?: false;
    readonly execute?: (
        client: Client,
        interaction: ChatInputCommandInteraction,
        context: ExecutionContext,
    ) => Promise<void> | void;
}

/** Top-level chat-input command whose handler receives guild-present types. */
export interface GuildChatInputCommand extends ChatInputCommandBase {
    readonly guildOnly: true;
    readonly execute?: (
        client: Client,
        interaction: GuildChatInputCommandInteraction,
        context: ExecutionContext,
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
export interface GlobalSubcommand extends SubcommandBase {
    readonly guildOnly?: false;
    readonly execute: (
        client: Client,
        interaction: ChatInputCommandInteraction,
        context: ExecutionContext,
    ) => Promise<void> | void;
}

/** Slash subcommand whose handler receives guild-present types. */
export interface GuildSubcommand extends SubcommandBase {
    readonly guildOnly: true;
    readonly execute: (
        client: Client,
        interaction: GuildChatInputCommandInteraction,
        context: ExecutionContext,
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
export interface GlobalContextMenuCommand extends ContextMenuCommandBase {
    readonly guildOnly?: false;
    readonly execute: (
        client: Client,
        interaction:
            | UserContextMenuCommandInteraction
            | MessageContextMenuCommandInteraction,
        context: ExecutionContext,
    ) => Promise<void> | void;
}

/** Context-menu command whose handler receives guild-present types. */
export interface GuildContextMenuCommand extends ContextMenuCommandBase {
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
        context: ExecutionContext,
    ) => Promise<void> | void;
}

/** Supported discriminated union of static Discord command definitions. */
export type BotCommand =
    | GlobalChatInputCommand
    | GuildChatInputCommand
    | GlobalSubcommand
    | GuildSubcommand
    | SubcommandGroup
    | GlobalContextMenuCommand
    | GuildContextMenuCommand;

/** Static Discord event handler with optional timeout and once semantics. */
export interface BotEvent<
    TClient extends Client = Client,
    TEvent extends keyof ClientEvents = keyof ClientEvents,
> {
    readonly id: string;
    readonly event: TEvent;
    readonly once?: boolean;
    readonly timeoutMs?: number;
    readonly execute: (
        client: TClient,
        args: ClientEvents[TEvent],
        context: ExecutionContext,
    ) => Promise<void> | void;
}

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
              | "guild-only";
          readonly commandId?: string;
      };

/** Operation phase and optional interaction metadata supplied on failure. */
export interface BotErrorContext {
    readonly phase: "command" | "autocomplete" | "event" | "lifecycle";
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

/** Client construction, credentials, logging, and execution defaults. */
export interface DiscordBotRuntimeOptions<TClient extends Client = Client> {
    readonly token: string;
    readonly clientOptions: ClientOptions;
    readonly clientFactory?: (options: ClientOptions) => TClient;
    readonly logger?: BotLogger;
    readonly onError?: BotErrorHandler;
    readonly execution?: ExecutionPolicy | undefined;
}
