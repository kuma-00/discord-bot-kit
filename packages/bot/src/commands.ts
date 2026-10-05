import type { ChatInputCommandInteraction, Client } from "discord.js";
import type {
    BotCommand,
    ExecutionContext,
    GlobalChatInputCommand,
    GlobalContextMenuCommand,
    GlobalSubcommand,
    GuildChatInputCommand,
    GuildChatInputCommandInteraction,
    GuildContextMenuCommand,
    GuildSubcommand,
    SubcommandGroup,
} from "./types.ts";

/** Object-style arguments supplied by ergonomic chat-input command helpers. */
export interface CommandExecuteArguments<
    TInteraction extends
        ChatInputCommandInteraction = ChatInputCommandInteraction,
    TServices = undefined,
> extends ExecutionContext<TServices> {
    readonly client: Client;
    readonly interaction: TInteraction;
}

/** Definition accepted by {@link defineGlobalCommand}. */
export type GlobalCommandDefinition<TServices = undefined> = Omit<
    GlobalChatInputCommand<TServices>,
    "kind" | "guildOnly" | "execute"
> & {
    readonly execute?: (
        arguments_: CommandExecuteArguments<
            ChatInputCommandInteraction,
            TServices
        >,
    ) => Promise<void> | void;
};

/** Definition accepted by {@link defineGuildCommand}. */
export type GuildCommandDefinition<TServices = undefined> = Omit<
    GuildChatInputCommand<TServices>,
    "kind" | "guildOnly" | "execute"
> & {
    readonly execute?: (
        arguments_: CommandExecuteArguments<
            GuildChatInputCommandInteraction,
            TServices
        >,
    ) => Promise<void> | void;
};

/** Preserves the concrete type of a statically declared bot command. */
export function defineCommand<const TCommand extends BotCommand>(
    command: TCommand,
): TCommand {
    return command;
}

/** Defines a global chat-input command with an object-style execute handler. */
export function defineGlobalCommand<TServices = undefined>(
    definition: GlobalCommandDefinition<TServices>,
): GlobalChatInputCommand<TServices> {
    const { execute, ...command } = definition;
    return {
        ...command,
        kind: "chat-input",
        ...(execute
            ? {
                  execute: (client, interaction, context) =>
                      execute({ client, interaction, ...context }),
              }
            : {}),
    };
}

/**
 * Defines a guild-only chat-input command with guild-narrowed interaction
 * types and an object-style execute handler.
 */
export function defineGuildCommand<TServices = undefined>(
    definition: GuildCommandDefinition<TServices>,
): GuildChatInputCommand<TServices> {
    const { execute, ...command } = definition;
    return {
        ...command,
        kind: "chat-input",
        guildOnly: true,
        ...(execute
            ? {
                  execute: (client, interaction, context) =>
                      execute({ client, interaction, ...context }),
              }
            : {}),
    };
}

/** Returns the normalized registry path used to dispatch a command. */
export function commandKey(command: BotCommand<never>): string {
    const id = command.id.trim().toLowerCase();
    if (command.kind === "subcommand") {
        const parent = command.parentId.trim().toLowerCase();
        const group = command.groupId?.trim().toLowerCase();
        return group ? `${parent}/${group}/${id}` : `${parent}/${id}`;
    }
    if (command.kind === "subcommand-group") {
        return `${command.parentId.trim().toLowerCase()}/${id}`;
    }
    return id;
}

type CommandHandlerFields<TCommand, TServices> = TCommand extends {
    readonly kind: "chat-input";
}
    ? TCommand extends { readonly guildOnly: true }
        ? Pick<GuildChatInputCommand<TServices>, "execute" | "autocomplete">
        : Pick<GlobalChatInputCommand<TServices>, "execute" | "autocomplete">
    : TCommand extends { readonly kind: "subcommand" }
      ? TCommand extends { readonly guildOnly: true }
          ? Pick<GuildSubcommand<TServices>, "execute">
          : Pick<GlobalSubcommand<TServices>, "execute">
      : TCommand extends { readonly kind: "context-menu" }
        ? TCommand extends { readonly guildOnly: true }
            ? Pick<GuildContextMenuCommand<TServices>, "execute">
            : Pick<GlobalContextMenuCommand<TServices>, "execute">
        : TCommand extends { readonly kind: "subcommand-group" }
          ? object
          : never;

/** Static definition helper bound only to a services type; creating it never starts services. */
export interface CommandDefinitionFactory<TServices> {
    <
        const TCommand extends
            | GlobalChatInputCommand<TServices>
            | GlobalSubcommand<TServices>
            | GlobalContextMenuCommand<TServices>
            | SubcommandGroup,
    >(
        command: TCommand,
    ): TCommand & CommandHandlerFields<TCommand, TServices>;
    <
        const TCommand extends
            | GuildChatInputCommand<TServices>
            | GuildSubcommand<TServices>
            | GuildContextMenuCommand<TServices>,
    >(
        command: TCommand,
    ): TCommand & CommandHandlerFields<TCommand, TServices>;
}

/** Creates a helper for default-exported roots, subcommands, context menus and autocomplete. */
export function createCommandDefinition<
    TServices,
>(): CommandDefinitionFactory<TServices> {
    return <const TCommand extends BotCommand<TServices>>(
        command: TCommand,
    ): TCommand & CommandHandlerFields<TCommand, TServices> =>
        command as TCommand & CommandHandlerFields<TCommand, TServices>;
}
