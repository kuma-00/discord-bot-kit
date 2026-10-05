import { expectTypeOf, test } from "bun:test";
import { Client, type ClientEvents, Events } from "discord.js";
import {
    type BotRegistry,
    type BotRegistryClient,
    createBotRegistry,
    createDiscordBot,
    createEventDefinition,
    DiscordBot,
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

class FactoryClient extends Client {
    readonly factoryClient = true;
}

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

test("infers custom clients from runtime factories for empty and standard event registries", () => {
    const emptyRegistry = createBotRegistry([]);
    const emptyFactoryBot = createDiscordBot(emptyRegistry, {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options) => new FactoryClient(options),
    });
    expectTypeOf(emptyFactoryBot.client).toEqualTypeOf<FactoryClient>();
    expectTypeOf<ReturnType<typeof emptyFactoryBot.start>>().toEqualTypeOf<
        Promise<FactoryClient>
    >();

    const directBot = new DiscordBot(emptyRegistry, {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options) => new FactoryClient(options),
    });
    expectTypeOf(directBot.client).toEqualTypeOf<FactoryClient>();
    expectTypeOf<ReturnType<typeof directBot.start>>().toEqualTypeOf<
        Promise<FactoryClient>
    >();

    const standardEvent = defineEvent({
        id: "message-create",
        event: Events.MessageCreate,
        execute(client, args) {
            expectTypeOf(client).toEqualTypeOf<Client>();
            expectTypeOf(args).toEqualTypeOf<ClientEvents["messageCreate"]>();
        },
    });
    const eventRegistry = createBotRegistry([], [standardEvent]);
    const eventFactoryBot = createDiscordBot(eventRegistry, {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options) => new FactoryClient(options),
    });
    expectTypeOf(eventFactoryBot.client).toEqualTypeOf<FactoryClient>();
    expectTypeOf<ReturnType<typeof eventFactoryBot.start>>().toEqualTypeOf<
        Promise<FactoryClient>
    >();

    const directEventBot = new DiscordBot(eventRegistry, {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options) => new FactoryClient(options),
    });
    expectTypeOf(directEventBot.client).toEqualTypeOf<FactoryClient>();
    expectTypeOf<ReturnType<typeof directEventBot.start>>().toEqualTypeOf<
        Promise<FactoryClient>
    >();
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

    const invalidDirectBot = () =>
        new DiscordBot(gbotRegistry, {
            token: "token",
            clientOptions: { intents: [] },
            // @ts-expect-error A base client factory cannot satisfy custom event handlers.
            clientFactory: (options) => new Client(options),
        });
    expectTypeOf(invalidDirectBot).toBeFunction();

    const invalidFactoryBot = () =>
        createDiscordBot(gbotRegistry, {
            token: "token",
            clientOptions: { intents: [] },
            // @ts-expect-error A base client factory cannot satisfy custom event handlers.
            clientFactory: (options) => new Client(options),
        });
    expectTypeOf(invalidFactoryBot).toBeFunction();
});
