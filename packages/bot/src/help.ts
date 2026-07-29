import {
    EmbedBuilder,
    type EmbedFooterOptions,
    SlashCommandSubcommandBuilder,
    SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { commandKey } from "./commands.ts";
import type { BotRegistry } from "./registry.ts";
import type { BotCommand } from "./types.ts";

const EMBED_TITLE_LIMIT = 256;
const EMBED_DESCRIPTION_LIMIT = 4_096;
const EMBED_FIELD_COUNT_LIMIT = 25;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_VALUE_LIMIT = 1_024;
const EMBED_FOOTER_LIMIT = 2_048;
const EMBED_TOTAL_LIMIT = 6_000;
const EMBED_PRESENTATION_LIMIT = 4_500;
const PAGE_TITLE_RESERVE = 20;

/** Presentation options for registry-backed help embeds. */
export interface HelpEmbedOptions {
    /** Embed title. Defaults to `"コマンド一覧"`. */
    readonly title?: string;
    /** Embed description. Defaults to `"説明"`. */
    readonly description?: string;
    /** Optional footer, such as the current bot user's name and avatar. */
    readonly footer?: EmbedFooterOptions;
    /**
     * Timestamp passed to Discord.js. Defaults to the current time; use `null`
     * to omit it.
     */
    readonly timestamp?: Date | number | null;
    /** Category used when command metadata has no category. Defaults to `"Other"`. */
    readonly uncategorizedLabel?: string;
}

type HelpCommand = Exclude<BotCommand, { kind: "context-menu" }>;

interface HelpField {
    readonly name: string;
    readonly value: string;
}

interface HelpPresentation {
    readonly title: string;
    readonly description: string;
    readonly footer?: EmbedFooterOptions;
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    if (limit <= 1) return "…".slice(0, limit);
    return `${value.slice(0, limit - 1)}…`;
}

function builderDescription(command: HelpCommand): string {
    if (command.kind === "chat-input") {
        return command.builder.toJSON().description;
    }
    if (command.kind === "subcommand") {
        return command.builder(new SlashCommandSubcommandBuilder()).toJSON()
            .description;
    }
    return command.builder(new SlashCommandSubcommandGroupBuilder()).toJSON()
        .description;
}

function displayPath(command: HelpCommand): string {
    return `/${commandKey(command).replaceAll("/", " ")}`;
}

function fieldName(
    category: string,
    commandCount: number,
    part: number,
    partCount: number,
): string {
    const prefix = `**${commandCount} · `;
    const suffix = `${partCount > 1 ? ` (${part}/${partCount})` : ""}**`;
    return `${prefix}${truncate(
        category,
        EMBED_FIELD_NAME_LIMIT - prefix.length - suffix.length,
    )}${suffix}`;
}

function createCategoryFields(
    category: string,
    commands: readonly HelpCommand[],
): readonly HelpField[] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentLength = 0;

    for (const command of commands) {
        const description =
            command.metadata?.description ?? builderDescription(command);
        const line = truncate(
            `\`${displayPath(command)}\` : ${description}`,
            EMBED_FIELD_VALUE_LIMIT,
        );
        const separatorLength = current.length > 0 ? 1 : 0;
        if (
            current.length > 0 &&
            currentLength + separatorLength + line.length >
                EMBED_FIELD_VALUE_LIMIT
        ) {
            chunks.push(current);
            current = [];
            currentLength = 0;
        }
        current.push(line);
        currentLength += (current.length > 1 ? 1 : 0) + line.length;
    }

    if (current.length > 0) chunks.push(current);

    return chunks.map((lines, index) => ({
        name: fieldName(category, commands.length, index + 1, chunks.length),
        value: lines.join("\n"),
    }));
}

function normalizePresentation(options: HelpEmbedOptions): HelpPresentation {
    const title = truncate(
        options.title ?? "コマンド一覧",
        EMBED_TITLE_LIMIT - PAGE_TITLE_RESERVE,
    );
    const footerText = truncate(options.footer?.text ?? "", EMBED_FOOTER_LIMIT);
    const descriptionBudget = Math.max(
        0,
        EMBED_PRESENTATION_LIMIT - title.length - footerText.length,
    );
    const description = truncate(
        options.description ?? "説明",
        Math.min(EMBED_DESCRIPTION_LIMIT, descriptionBudget),
    );
    const footer =
        options.footer && footerText
            ? { ...options.footer, text: footerText }
            : undefined;
    return {
        title,
        description,
        ...(footer ? { footer } : {}),
    };
}

function paginateFields(
    fields: readonly HelpField[],
    presentationLength: number,
): readonly (readonly HelpField[])[] {
    const pages: HelpField[][] = [];
    let current: HelpField[] = [];
    let currentLength = presentationLength;

    for (const field of fields) {
        const fieldLength = field.name.length + field.value.length;
        if (
            current.length > 0 &&
            (current.length >= EMBED_FIELD_COUNT_LIMIT ||
                currentLength + fieldLength > EMBED_TOTAL_LIMIT)
        ) {
            pages.push(current);
            current = [];
            currentLength = presentationLength;
        }
        current.push(field);
        currentLength += fieldLength;
    }

    if (current.length > 0 || pages.length === 0) pages.push(current);
    return pages;
}

/**
 * Creates send-ready Discord help embeds from a validated static bot registry.
 *
 * Visible chat-input commands, subcommands, and subcommand groups are grouped
 * by their metadata category in definition order. Context-menu commands and
 * commands with `metadata.hidden: true` are omitted. Command paths include
 * their parent and group. Content is truncated or split across embeds to stay
 * within Discord embed limits.
 *
 * @param registry Registry whose command definitions are rendered.
 * @param options Optional presentation overrides.
 * @returns One or more embed builders, including one for an empty registry.
 *
 * @example
 * ```ts
 * const embeds = createHelpEmbeds(botRegistry, {
 *     footer: { text: client.user?.username ?? "" },
 * });
 * for (const embed of embeds) {
 *     await interaction.followUp({ embeds: [embed] });
 * }
 * ```
 */
export function createHelpEmbeds(
    registry: BotRegistry,
    options: HelpEmbedOptions = {},
): readonly EmbedBuilder[] {
    const uncategorizedLabel = options.uncategorizedLabel ?? "Other";
    const categories = new Map<string, HelpCommand[]>();

    for (const command of registry.definitions) {
        if (
            command.kind === "context-menu" ||
            command.metadata?.hidden === true
        ) {
            continue;
        }
        const category = command.metadata?.category ?? uncategorizedLabel;
        const commands = categories.get(category) ?? [];
        commands.push(command);
        categories.set(category, commands);
    }

    const fields = [...categories].flatMap(([category, commands]) =>
        createCategoryFields(category, commands),
    );
    const presentation = normalizePresentation(options);
    const presentationLength =
        presentation.title.length +
        presentation.description.length +
        (presentation.footer?.text.length ?? 0) +
        PAGE_TITLE_RESERVE;
    const pages = paginateFields(fields, presentationLength);

    return pages.map((pageFields, index) => {
        const suffix =
            pages.length > 1 ? ` (${index + 1}/${pages.length})` : "";
        const embed = new EmbedBuilder();
        const title = truncate(
            presentation.title,
            EMBED_TITLE_LIMIT - suffix.length,
        );
        if (title || suffix) embed.setTitle(`${title}${suffix}`);
        if (presentation.description) {
            embed.setDescription(presentation.description);
        }
        if (pageFields.length > 0) embed.addFields(...pageFields);
        if (presentation.footer) embed.setFooter(presentation.footer);
        if (options.timestamp !== null) {
            embed.setTimestamp(options.timestamp ?? Date.now());
        }
        return embed;
    });
}
