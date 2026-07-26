import {
    type RESTPostAPIApplicationCommandsJSONBody,
    SlashCommandSubcommandBuilder,
    SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { commandKey } from "./commands.ts";
import { RegistryValidationError } from "./errors.ts";
import type { BotCommand, BotEvent } from "./types.ts";

export interface BotRegistry {
    readonly definitions: readonly BotCommand[];
    readonly rootCommands: ReadonlyMap<string, BotCommand>;
    readonly executableCommands: ReadonlyMap<string, BotCommand>;
    readonly events: readonly BotEvent[];
    readonly applicationCommands: readonly RESTPostAPIApplicationCommandsJSONBody[];
}

function normalizedId(id: string, label: string): string {
    const value = id.trim().toLowerCase();
    if (!value) {
        throw new RegistryValidationError(
            "invalid-id",
            `${label} must have a non-empty id`,
        );
    }
    return value;
}

function assertBuilderName(
    command: Extract<BotCommand, { builder: object }>,
    actualName: string,
): void {
    const expected = normalizedId(command.id, "Command");
    if (actualName.toLowerCase() !== expected) {
        throw new RegistryValidationError(
            "builder-name-mismatch",
            `Command "${commandKey(command)}" builder name "${actualName}" does not match id "${expected}"`,
        );
    }
}

export function createBotRegistry(
    definitions: readonly BotCommand[],
    events: readonly BotEvent[] = [],
): BotRegistry {
    const byKey = new Map<string, BotCommand>();
    const roots = new Map<string, BotCommand>();
    for (const command of definitions) {
        const key = commandKey(command);
        normalizedId(command.id, "Command");
        if (byKey.has(key)) {
            throw new RegistryValidationError(
                "duplicate-id",
                `Duplicate command id: ${key}`,
            );
        }
        byKey.set(key, command);
        if (command.kind === "chat-input" || command.kind === "context-menu") {
            const id = normalizedId(command.id, "Command");
            if (roots.has(id)) {
                throw new RegistryValidationError(
                    "duplicate-id",
                    `Duplicate root command id: ${id}`,
                );
            }
            roots.set(id, command);
            assertBuilderName(command, command.builder.toJSON().name);
        }
    }

    const groups = new Map<string, SubcommandGroupBuilder>();
    type SubcommandGroupBuilder = {
        definition: Extract<BotCommand, { kind: "subcommand-group" }>;
        builder: SlashCommandSubcommandGroupBuilder;
    };
    for (const command of definitions) {
        if (
            command.kind !== "subcommand" &&
            command.kind !== "subcommand-group"
        ) {
            continue;
        }
        const parentId = normalizedId(command.parentId, "Parent command");
        const parent = roots.get(parentId);
        if (!parent) {
            throw new RegistryValidationError(
                "missing-parent",
                `Command "${commandKey(command)}" references missing parent "${parentId}"`,
            );
        }
        if (parent.kind !== "chat-input") {
            throw new RegistryValidationError(
                "invalid-parent",
                `Command "${commandKey(command)}" parent must be a chat-input command`,
            );
        }
        if (command.kind === "subcommand-group") {
            const builder = command.builder(
                new SlashCommandSubcommandGroupBuilder(),
            );
            assertBuilderName(command, builder.toJSON().name);
            groups.set(commandKey(command), { definition: command, builder });
        }
    }

    for (const command of definitions) {
        if (command.kind !== "subcommand") continue;
        const parentId = normalizedId(command.parentId, "Parent command");
        const parent = roots.get(parentId);
        if (!parent || parent.kind !== "chat-input") continue;
        const builder = command.builder(new SlashCommandSubcommandBuilder());
        assertBuilderName(command, builder.toJSON().name);
        if (command.groupId) {
            const groupKey = `${parentId}/${normalizedId(command.groupId, "Group")}`;
            const group = groups.get(groupKey);
            if (!group) {
                throw new RegistryValidationError(
                    "missing-parent",
                    `Subcommand "${commandKey(command)}" references missing group "${groupKey}"`,
                );
            }
            group.builder.addSubcommand(builder);
        } else {
            parent.builder.addSubcommand(builder);
        }
    }
    for (const [key, group] of groups) {
        const parentId = key.split("/")[0];
        const parent = parentId ? roots.get(parentId) : undefined;
        if (parent?.kind === "chat-input") {
            parent.builder.addSubcommandGroup(group.builder);
        }
    }

    const eventIds = new Set<string>();
    for (const event of events) {
        const id = normalizedId(event.id, "Event");
        if (eventIds.has(id)) {
            throw new RegistryValidationError(
                "duplicate-id",
                `Duplicate event handler id: ${id}`,
            );
        }
        eventIds.add(id);
    }

    return {
        definitions: [...definitions],
        rootCommands: roots,
        executableCommands: byKey,
        events: [...events],
        applicationCommands: [...roots.values()].map((command) => {
            if (
                command.kind !== "chat-input" &&
                command.kind !== "context-menu"
            ) {
                throw new RegistryValidationError(
                    "invalid-parent",
                    "Root registry contains a non-root command",
                );
            }
            return command.builder.toJSON();
        }),
    };
}
