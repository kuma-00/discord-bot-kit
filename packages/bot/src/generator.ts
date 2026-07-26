import { resolve } from "node:path";
import {
    buildStaticRegistryFragment,
    StaticRegistryError,
    type StaticRegistryFragment,
    type StaticRegistryValidator,
} from "@kuma-00/bot-kit-registry";
import {
    SlashCommandSubcommandBuilder,
    SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { commandKey } from "./commands.ts";
import { RegistryValidationError } from "./errors.ts";
import type { BotCommand, BotEvent } from "./types.ts";

const BOT_PACKAGE_NAME = "@kuma-00/bot-kit-bot";

/** Source directories and committed output path for bot registry generation. */
export interface BotRegistryGeneratorConfig {
    readonly commandSourceDir: string;
    readonly eventSourceDir: string;
    readonly outputPath: string;
}

/** Counts and stale-state information returned by registry generation checks. */
export interface GenerateBotRegistryResult {
    readonly changed: boolean;
    readonly commandCount: number;
    readonly eventCount: number;
    readonly outputPath: string;
}

/** Preserves literal paths in a bot registry generator configuration. */
export function defineBotRegistryConfig<
    const T extends BotRegistryGeneratorConfig,
>(config: T): T {
    return config;
}

function validateCommand(value: unknown, file: string): true {
    if (typeof value !== "object" || value === null) {
        throw new RegistryValidationError(
            "invalid-module",
            `${file} must default export a valid bot command`,
        );
    }
    const command = value as Record<string, unknown>;
    const kind = command.kind;
    const hasId = typeof command.id === "string" && command.id.trim() !== "";
    const hasParent =
        typeof command.parentId === "string" && command.parentId.trim() !== "";
    const hasBuilderObject =
        typeof command.builder === "object" &&
        command.builder !== null &&
        typeof (command.builder as { toJSON?: unknown }).toJSON === "function";
    const hasBuilderFunction = typeof command.builder === "function";
    const hasOptionalGroup =
        command.groupId === undefined ||
        (typeof command.groupId === "string" && command.groupId.trim() !== "");
    const hasOptionalExecute =
        command.execute === undefined || typeof command.execute === "function";
    const hasOptionalAutocomplete =
        command.autocomplete === undefined ||
        typeof command.autocomplete === "function";
    const valid =
        hasId &&
        ((kind === "chat-input" &&
            hasBuilderObject &&
            hasOptionalExecute &&
            hasOptionalAutocomplete) ||
            (kind === "context-menu" &&
                hasBuilderObject &&
                typeof command.execute === "function") ||
            (kind === "subcommand" &&
                hasParent &&
                hasOptionalGroup &&
                hasBuilderFunction &&
                typeof command.execute === "function") ||
            (kind === "subcommand-group" && hasParent && hasBuilderFunction));
    if (!valid) {
        throw new RegistryValidationError(
            "invalid-module",
            `${file} must default export a valid bot command`,
        );
    }
    return true;
}

function validateEvent(value: unknown, file: string): true {
    const event = value as {
        readonly id?: unknown;
        readonly event?: unknown;
        readonly execute?: unknown;
    };
    const valid =
        typeof value === "object" &&
        value !== null &&
        typeof event.id === "string" &&
        event.id.trim() !== "" &&
        typeof event.event === "string" &&
        event.event.trim() !== "" &&
        typeof event.execute === "function";
    if (!valid) {
        throw new RegistryValidationError(
            "invalid-module",
            `${file} must default export a valid bot event`,
        );
    }
    return true;
}

function normalizedId(id: string): string {
    return id.trim().toLowerCase();
}

function validateRegistryDefinitions(
    commands: readonly BotCommand[],
    events: readonly BotEvent[],
): void {
    const commandKeys = new Set<string>();
    const roots = new Map<
        string,
        Extract<BotCommand, { kind: "chat-input" | "context-menu" }>
    >();
    const groups = new Set<string>();

    for (const command of commands) {
        const key = commandKey(command);
        if (commandKeys.has(key)) {
            throw new RegistryValidationError(
                "duplicate-id",
                `Duplicate command id: ${key}`,
            );
        }
        commandKeys.add(key);
        if (command.kind === "chat-input" || command.kind === "context-menu") {
            const id = normalizedId(command.id);
            if (roots.has(id)) {
                throw new RegistryValidationError(
                    "duplicate-id",
                    `Duplicate root command id: ${id}`,
                );
            }
            roots.set(id, command);
            if (command.builder.toJSON().name.toLowerCase() !== id) {
                throw new RegistryValidationError(
                    "builder-name-mismatch",
                    `Command "${key}" builder name does not match id "${id}"`,
                );
            }
        }
    }

    for (const command of commands) {
        if (
            command.kind !== "subcommand" &&
            command.kind !== "subcommand-group"
        ) {
            continue;
        }
        const parentId = normalizedId(command.parentId);
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
            if (
                builder.toJSON().name.toLowerCase() !== normalizedId(command.id)
            ) {
                throw new RegistryValidationError(
                    "builder-name-mismatch",
                    `Command "${commandKey(command)}" builder name does not match id`,
                );
            }
            groups.add(commandKey(command));
        }
    }

    for (const command of commands) {
        if (command.kind !== "subcommand") continue;
        const builder = command.builder(new SlashCommandSubcommandBuilder());
        if (builder.toJSON().name.toLowerCase() !== normalizedId(command.id)) {
            throw new RegistryValidationError(
                "builder-name-mismatch",
                `Command "${commandKey(command)}" builder name does not match id`,
            );
        }
        if (
            command.groupId &&
            !groups.has(
                `${normalizedId(command.parentId)}/${normalizedId(command.groupId)}`,
            )
        ) {
            throw new RegistryValidationError(
                "missing-parent",
                `Subcommand "${commandKey(command)}" references missing group`,
            );
        }
    }

    const eventIds = new Set<string>();
    for (const event of events) {
        const id = normalizedId(event.id);
        if (eventIds.has(id)) {
            throw new RegistryValidationError(
                "duplicate-id",
                `Duplicate event handler id: ${id}`,
            );
        }
        eventIds.add(id);
    }
}

async function buildBotFragment(
    sourceDir: string,
    outputPath: string,
    exportName: string,
    identifierPrefix: string,
    validate: StaticRegistryValidator,
): Promise<StaticRegistryFragment> {
    try {
        return await buildStaticRegistryFragment(
            {
                sourceDir,
                outputPath,
                exportName,
                validate,
            },
            identifierPrefix,
        );
    } catch (error) {
        if (!(error instanceof StaticRegistryError)) throw error;
        throw new RegistryValidationError(
            error.code === "empty-source" ? "empty-source" : "invalid-module",
            error.message,
        );
    }
}

/**
 * Builds and validates a deterministic bot registry module without writing it.
 *
 * Validation imports consumer modules at generation time and checks the full
 * command/event graph before returning source.
 */
export async function buildBotRegistryModule(
    config: BotRegistryGeneratorConfig,
): Promise<{
    readonly content: string;
    readonly commandCount: number;
    readonly eventCount: number;
}> {
    const outputPath = resolve(config.outputPath);
    const commandDefinitions: BotCommand[] = [];
    const eventDefinitions: BotEvent[] = [];
    const commands = await buildBotFragment(
        config.commandSourceDir,
        outputPath,
        "commands",
        "command",
        (value, { file }) => {
            validateCommand(value, file);
            commandDefinitions.push(value as BotCommand);
            return true;
        },
    );
    const events = await buildBotFragment(
        config.eventSourceDir,
        outputPath,
        "events",
        "event",
        (value, { file }) => {
            validateEvent(value, file);
            eventDefinitions.push(value as BotEvent);
            return true;
        },
    );
    validateRegistryDefinitions(commandDefinitions, eventDefinitions);
    const content = `// Generated by ${BOT_PACKAGE_NAME}. Do not edit.
import {
    createBotRegistry,
    createDiscordBot as createRuntimeDiscordBot,
    type DiscordBotRuntimeOptions,
} from "${BOT_PACKAGE_NAME}";
${[...commands.imports, ...events.imports].join("\n")}

/** Validated command and event registry generated from consumer modules. */
export const botRegistry = createBotRegistry([${commands.identifiers.join(", ")}], [${events.identifiers.join(", ")}]);
/** Discord REST application-command payloads composed from the registry. */
export const applicationCommands = botRegistry.applicationCommands;
/** Creates a Discord bot bound to the generated registry. */
export const createGeneratedDiscordBot = (
    options: DiscordBotRuntimeOptions,
) => createRuntimeDiscordBot(botRegistry, options);
`;
    return {
        content,
        commandCount: commands.entryCount,
        eventCount: events.entryCount,
    };
}

/**
 * Writes the generated bot registry only when its deterministic content changed.
 *
 * @returns Counts, absolute output path, and whether a write occurred.
 */
export async function generateBotRegistry(
    config: BotRegistryGeneratorConfig,
): Promise<GenerateBotRegistryResult> {
    const generated = await buildBotRegistryModule(config);
    const outputPath = resolve(config.outputPath);
    const current = (await Bun.file(outputPath).exists())
        ? await Bun.file(outputPath).text()
        : undefined;
    const changed = current !== generated.content;
    if (changed) await Bun.write(outputPath, generated.content);
    return {
        changed,
        commandCount: generated.commandCount,
        eventCount: generated.eventCount,
        outputPath,
    };
}

/**
 * Verifies that the committed generated registry matches its source modules.
 *
 * @throws When definitions are invalid or the generated file is stale.
 */
export async function checkBotRegistry(
    config: BotRegistryGeneratorConfig,
): Promise<GenerateBotRegistryResult> {
    const generated = await buildBotRegistryModule(config);
    const outputPath = resolve(config.outputPath);
    const current = (await Bun.file(outputPath).exists())
        ? await Bun.file(outputPath).text()
        : undefined;
    if (current !== generated.content) {
        throw new Error(
            `Generated bot registry is stale: ${outputPath}. Run generateBotRegistry().`,
        );
    }
    return {
        changed: false,
        commandCount: generated.commandCount,
        eventCount: generated.eventCount,
        outputPath,
    };
}
