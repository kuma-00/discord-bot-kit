import { expectTypeOf, test } from "bun:test";
import { Client, type ClientEvents, Events } from "discord.js";
import {
    type BotRegistry,
    type BotRegistryClient,
    createBotRegistry,
    createDiscordBot,
    createEventDefinition,
    type DiscordBotRuntimeOptions,
    defineEvent,
} from "../src/index.ts";

class GbotClient extends Client {
    readonly gbot = true;
}

const defineGbotEvent = createEventDefinition<GbotClient>();

const messageCreate = defineGbotEvent({
    id: "message-create",
    event: Events.MessageCreate,
    metadata: { category: "messages" },
    execute(client, args) {
        expectTypeOf(client).toEqualTypeOf<GbotClient>();
        expectTypeOf(args).toEqualTypeOf<ClientEvents["messageCreate"]>();
    },
});

const ready = defineGbotEvent({
    id: "ready",
    event: Events.ClientReady,
    execute(client, args) {
        expectTypeOf(client).toEqualTypeOf<GbotClient>();
        expectTypeOf(args).toEqualTypeOf<ClientEvents["clientReady"]>();
    },
});

const gbotRegistry = createBotRegistry([], [messageCreate, ready]);

test("preserves a custom client across heterogeneous events and runtime", () => {
    expectTypeOf(messageCreate.id).toEqualTypeOf<"message-create">();
    expectTypeOf(messageCreate.metadata).toEqualTypeOf<{
        readonly category: "messages";
    }>();
    expectTypeOf(gbotRegistry).toEqualTypeOf<BotRegistry<GbotClient>>();
    const bot = createDiscordBot(gbotRegistry, {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options) => new GbotClient(options),
    });
    expectTypeOf(bot.client).toEqualTypeOf<GbotClient>();
});

test("matches generated bot options to the registry client", () => {
    const createGeneratedDiscordBot = (
        options: DiscordBotRuntimeOptions<
            BotRegistryClient<typeof gbotRegistry>
        >,
    ) => createDiscordBot(gbotRegistry, options);

    const bot = createGeneratedDiscordBot({
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options) => new GbotClient(options),
    });
    expectTypeOf(bot.client).toEqualTypeOf<GbotClient>();

    const invalidGeneratedOptions = () => {
        // @ts-expect-error A custom-client registry requires its client factory.
        createGeneratedDiscordBot({
            token: "token",
            clientOptions: { intents: [] },
        });

        createGeneratedDiscordBot({
            token: "token",
            clientOptions: { intents: [] },
            // @ts-expect-error The generated factory must use the event registry's client.
            clientFactory: (options) => new Client(options),
        });
    };
    expectTypeOf(invalidGeneratedOptions).toBeFunction();
});

test("requires a factory for standard Client event definitions", () => {
    const standardEvent = defineEvent({
        id: "message-create",
        event: Events.MessageCreate,
        execute(client, args) {
            expectTypeOf(client).toEqualTypeOf<Client>();
            expectTypeOf(args).toEqualTypeOf<ClientEvents["messageCreate"]>();
        },
    });
    const registry = createBotRegistry([], [standardEvent]);
    expectTypeOf(registry).toEqualTypeOf<BotRegistry<Client>>();

    const missingStandardFactory = () => {
        // @ts-expect-error Every registry requires an explicit client factory.
        createDiscordBot(registry, {
            token: "token",
            clientOptions: { intents: [] },
        });
    };
    expectTypeOf(missingStandardFactory).toBeFunction();

    const bot = createDiscordBot(registry, {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options) => new Client(options),
    });
    expectTypeOf(bot.client).toEqualTypeOf<Client>();
});
