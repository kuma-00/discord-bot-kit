import type { BotCommand } from "./types.ts";

export function defineCommand<const TCommand extends BotCommand>(
    command: TCommand,
): TCommand {
    return command;
}

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
