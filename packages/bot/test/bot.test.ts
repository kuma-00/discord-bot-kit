import { describe, expect, test } from "bun:test";
import type {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    Client,
} from "discord.js";
import {
    createCommandRegistry,
    DiscordBot,
    DuplicateRegistryEntryError,
} from "../src/index.ts";

describe("Discord bot core", () => {
    test("rejects case-insensitive duplicate command IDs", () => {
        expect(() =>
            createCommandRegistry([
                { id: "Ping", execute: () => {} },
                { id: "ping", execute: () => {} },
            ]),
        ).toThrow(DuplicateRegistryEntryError);
    });

    test("dispatches and defers a chat input command", async () => {
        let executed = false;
        let deferred = false;
        const fakeClient = {
            on: () => fakeClient,
            once: () => fakeClient,
            login: async () => "token",
            destroy: () => {},
        } as unknown as Client;
        const bot = new DiscordBot({
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: () => fakeClient,
            commands: [
                {
                    id: "ping",
                    execute: () => {
                        executed = true;
                    },
                },
            ],
        });
        const interaction = {
            commandName: "ping",
            deferred: false,
            replied: false,
            isChatInputCommand: () => true,
            isAutocomplete: () => false,
            deferReply: async () => {
                deferred = true;
            },
        } as unknown as ChatInputCommandInteraction;
        expect(await bot.dispatchInteraction(interaction)).toBe(true);
        expect(deferred).toBe(true);
        expect(executed).toBe(true);
    });

    test("dispatches autocomplete without deferring", async () => {
        let completed = false;
        const fakeClient = {} as Client;
        const bot = new DiscordBot({
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: () => fakeClient,
            commands: [
                {
                    id: "search",
                    execute: () => {},
                    autocomplete: () => {
                        completed = true;
                    },
                },
            ],
        });
        const interaction = {
            commandName: "search",
            isChatInputCommand: () => false,
            isAutocomplete: () => true,
        } as unknown as AutocompleteInteraction;
        expect(await bot.dispatchInteraction(interaction)).toBe(true);
        expect(completed).toBe(true);
    });
});
