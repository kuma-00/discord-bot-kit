import {
    type Client,
    type RESTPostAPIApplicationCommandsJSONBody,
    SlashCommandSubcommandBuilder,
    SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { commandKey } from "./commands.ts";
import { RegistryValidationError } from "./errors.ts";
import type { BotCommand, BotEvent } from "./types.ts";

/** Validated command lookup tables, event handlers, and Discord REST payloads. */
export interface BotRegistry<TClient extends Client = Client> {
    readonly definitions: readonly BotCommand[];
    readonly rootCommands: ReadonlyMap<string, BotCommand>;
    readonly executableCommands: ReadonlyMap<string, BotCommand>;
    readonly events: readonly BotEvent<TClient>[];
    readonly applicationCommands: readonly RESTPostAPIApplicationCommandsJSONBody[];
}

/** Extracts the Discord client type carried by a bot registry. */
export type BotRegistryClient<TRegistry> =
    TRegistry extends BotRegistry<infer TClient> ? TClient : never;

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

function appendApplicationCommandOption(
    command: RESTPostAPIApplicationCommandsJSONBody | undefined,
    option: unknown,
): void {
    if (!command) {
        throw new RegistryValidationError(
            "invalid-parent",
            "Parent application command payload is missing",
        );
    }
    const mutableCommand = command as unknown as {
        options?: unknown[];
    };
    const options = mutableCommand.options ?? [];
    mutableCommand.options = options;
    options.push(option);
}

/**
 * Validates and composes static command and event definitions.
 *
 * Command builders remain consumer-owned and are not mutated; composition is
 * applied to Registry-owned REST payloads.
 *
 * @throws {RegistryValidationError} For duplicates, invalid parents, or builder mismatches.
 */
export function createBotRegistry<TClient extends Client = Client>(
    definitions: readonly BotCommand[],
    events: readonly BotEvent<TClient>[] = [],
): BotRegistry<TClient> {
    const byKey = new Map<string, BotCommand>();
    const roots = new Map<string, BotCommand>();
    const applicationCommandById = new Map<
        string,
        RESTPostAPIApplicationCommandsJSONBody
    >();
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
            const commandJson = command.builder.toJSON();
            assertBuilderName(command, commandJson.name);
            applicationCommandById.set(id, commandJson);
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
        if (parent?.kind !== "chat-input") continue;
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
            appendApplicationCommandOption(
                applicationCommandById.get(parentId),
                builder.toJSON(),
            );
        }
    }
    for (const [key, group] of groups) {
        const parentId = key.split("/")[0];
        if (!parentId) continue;
        const parent = roots.get(parentId);
        if (parent?.kind === "chat-input") {
            appendApplicationCommandOption(
                applicationCommandById.get(parentId),
                group.builder.toJSON(),
            );
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
        applicationCommands: [...applicationCommandById.values()],
    };
}
