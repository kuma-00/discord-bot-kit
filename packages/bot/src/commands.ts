import type { ChatInputCommandInteraction, Client } from "discord.js";
import type {
    BotCommand,
    ExecutionContext,
    GlobalChatInputCommand,
    GuildChatInputCommand,
    GuildChatInputCommandInteraction,
} from "./types.ts";

/** Object-style arguments supplied by ergonomic chat-input command helpers. */
export interface CommandExecuteArguments<
    TInteraction extends
        ChatInputCommandInteraction = ChatInputCommandInteraction,
> extends ExecutionContext {
    readonly client: Client;
    readonly interaction: TInteraction;
}

/** Definition accepted by {@link defineGlobalCommand}. */
export type GlobalCommandDefinition = Omit<
    GlobalChatInputCommand,
    "kind" | "guildOnly" | "execute"
> & {
    readonly execute?: (
        arguments_: CommandExecuteArguments,
    ) => Promise<void> | void;
};

/** Definition accepted by {@link defineGuildCommand}. */
export type GuildCommandDefinition = Omit<
    GuildChatInputCommand,
    "kind" | "guildOnly" | "execute"
> & {
    readonly execute?: (
        arguments_: CommandExecuteArguments<GuildChatInputCommandInteraction>,
    ) => Promise<void> | void;
};

/** Preserves the concrete type of a statically declared bot command. */
export function defineCommand<const TCommand extends BotCommand>(
    command: TCommand,
): TCommand {
    return command;
}

/** Defines a global chat-input command with an object-style execute handler. */
export function defineGlobalCommand(
    definition: GlobalCommandDefinition,
): GlobalChatInputCommand {
    const { execute, ...command } = definition;
    return {
        ...command,
        kind: "chat-input",
        ...(execute
            ? {
                  execute: (client, interaction, context) =>
                      execute({ client, interaction, signal: context.signal }),
              }
            : {}),
    };
}

/**
 * Defines a guild-only chat-input command with guild-narrowed interaction
 * types and an object-style execute handler.
 */
export function defineGuildCommand(
    definition: GuildCommandDefinition,
): GuildChatInputCommand {
    const { execute, ...command } = definition;
    return {
        ...command,
        kind: "chat-input",
        guildOnly: true,
        ...(execute
            ? {
                  execute: (client, interaction, context) =>
                      execute({ client, interaction, signal: context.signal }),
              }
            : {}),
    };
}

/** Returns the normalized registry path used to dispatch a command. */
export function commandKey(command: BotCommand): string {
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
