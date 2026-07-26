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

export interface ExecutionPolicy {
    readonly defer?: boolean | undefined;
    readonly ephemeral?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
}

export interface ExecutionContext {
    readonly signal: AbortSignal;
}

export type GuildChatInputCommandInteraction = ChatInputCommandInteraction & {
    readonly guild: Guild;
    readonly guildId: string;
};

export type GuildContextMenuCommandInteraction =
    ContextMenuCommandInteraction & {
        readonly guild: Guild;
        readonly guildId: string;
    };

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

export interface GlobalChatInputCommand extends ChatInputCommandBase {
    readonly guildOnly?: false;
    readonly execute?: (
        client: Client,
        interaction: ChatInputCommandInteraction,
        context: ExecutionContext,
    ) => Promise<void> | void;
}

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

export interface GlobalSubcommand extends SubcommandBase {
    readonly guildOnly?: false;
    readonly execute: (
        client: Client,
        interaction: ChatInputCommandInteraction,
        context: ExecutionContext,
    ) => Promise<void> | void;
}

export interface GuildSubcommand extends SubcommandBase {
    readonly guildOnly: true;
    readonly execute: (
        client: Client,
        interaction: GuildChatInputCommandInteraction,
        context: ExecutionContext,
    ) => Promise<void> | void;
}

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

export type BotCommand =
    | GlobalChatInputCommand
    | GuildChatInputCommand
    | GlobalSubcommand
    | GuildSubcommand
    | SubcommandGroup
    | GlobalContextMenuCommand
    | GuildContextMenuCommand;

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

export interface BotErrorContext {
    readonly phase: "command" | "autocomplete" | "event" | "lifecycle";
    readonly id?: string;
    readonly interaction?: Interaction;
    readonly timedOut?: boolean;
    readonly aborted?: boolean;
}

export type BotErrorHandler = (
    error: unknown,
    context: BotErrorContext,
) => Promise<void> | void;

export interface DiscordBotRuntimeOptions<TClient extends Client = Client> {
    readonly token: string;
    readonly clientOptions: ClientOptions;
    readonly clientFactory?: (options: ClientOptions) => TClient;
    readonly logger?: BotLogger;
    readonly onError?: BotErrorHandler;
    readonly execution?: ExecutionPolicy | undefined;
}
