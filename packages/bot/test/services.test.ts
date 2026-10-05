import { expect, expectTypeOf, test } from "bun:test";
import {
    type ChatInputCommandInteraction,
    Client,
    type ClientOptions,
    Events,
    type Interaction,
    SlashCommandBuilder,
} from "discord.js";
import {
    type BotRegistryServices,
    buildBotRegistryModule,
    CommandDispatcher,
    type CommandExecuteArguments,
    checkBotRegistry,
    createBotRegistry,
    createCommandDefinition,
    createDiscordBot,
    createEventDefinition,
    DiscordBot,
    type GuildChatInputCommandInteraction,
} from "../src/index.ts";
import menu from "./fixtures/services/commands/menu.ts";
import root from "./fixtures/services/commands/root.ts";
import sub from "./fixtures/services/commands/sub.ts";
import ready from "./fixtures/services/events/ready.ts";
import {
    type botRegistry,
    createGeneratedDiscordBot,
} from "./fixtures/services/generated.ts";
import {
    createServices,
    type Services,
    starts,
} from "./fixtures/services/services.ts";

const config = {
    commandSourceDir: new URL("./fixtures/services/commands", import.meta.url)
        .pathname,
    eventSourceDir: new URL("./fixtures/services/events", import.meta.url)
        .pathname,
    outputPath: new URL("./fixtures/services/generated.ts", import.meta.url)
        .pathname,
};

test("preserves the public CommandExecuteArguments generic order", () => {
    type LegacyArguments =
        CommandExecuteArguments<GuildChatInputCommandInteraction>;
    type ServicedArguments = CommandExecuteArguments<
        ChatInputCommandInteraction,
        Services
    >;

    expectTypeOf<
        LegacyArguments["interaction"]
    >().toEqualTypeOf<GuildChatInputCommandInteraction>();
    expectTypeOf<LegacyArguments["services"]>().toEqualTypeOf<undefined>();
    expectTypeOf<
        ServicedArguments["interaction"]
    >().toEqualTypeOf<ChatInputCommandInteraction>();
    expectTypeOf<ServicedArguments["services"]>().toEqualTypeOf<Services>();
});

function interaction(
    kind: "root" | "sub" | "menu" | "autocomplete",
): Interaction {
    return {
        commandName: kind === "menu" ? "menu" : "root",
        isChatInputCommand: () => kind === "root" || kind === "sub",
        isContextMenuCommand: () => kind === "menu",
        isAutocomplete: () => kind === "autocomplete",
        isRepliable: () => false,
        inCachedGuild: () => true,
        options: {
            getSubcommandGroup: () => null,
            getSubcommand: () => (kind === "sub" ? "sub" : null),
        },
    } as unknown as Interaction;
}
test("static services definitions and generation do not initialize consumer services", async () => {
    const before = starts;
    await buildBotRegistryModule(config);
    expect(starts).toBe(before);
    await expect(checkBotRegistry(config)).resolves.toMatchObject({
        changed: false,
        commandCount: 3,
        eventCount: 1,
    });
});

test("definition factories retain services for handlers without context", () => {
    const defineServicesCommand = createCommandDefinition<Services>();
    const handlerFreeRoot = defineServicesCommand({
        kind: "chat-input",
        id: "handler-free",
        metadata: { category: "service-test" },
        builder: new SlashCommandBuilder()
            .setName("handler-free")
            .setDescription("A root without handlers"),
    });
    const contextFreeCommand = defineServicesCommand({
        kind: "chat-input",
        id: "context-free",
        builder: new SlashCommandBuilder()
            .setName("context-free")
            .setDescription("A handler without context parameters"),
        execute: () => {},
    });
    const contextFreeEvent = createEventDefinition<Client, Services>()({
        id: "context-free-event",
        event: Events.ClientReady,
        execute: () => {},
    });
    const handlerFreeRegistry = createBotRegistry([handlerFreeRoot]);
    const contextFreeCommandRegistry = createBotRegistry([contextFreeCommand]);
    const contextFreeEventRegistry = createBotRegistry([], [contextFreeEvent]);

    expectTypeOf(handlerFreeRoot.id).toEqualTypeOf<"handler-free">();
    expectTypeOf(handlerFreeRoot.metadata).toEqualTypeOf<{
        readonly category: "service-test";
    }>();
    expectTypeOf(contextFreeCommand.id).toEqualTypeOf<"context-free">();
    expectTypeOf(contextFreeEvent.id).toEqualTypeOf<"context-free-event">();
    expectTypeOf<
        BotRegistryServices<typeof handlerFreeRegistry>
    >().toEqualTypeOf<Services>();
    expectTypeOf<
        BotRegistryServices<typeof contextFreeCommandRegistry>
    >().toEqualTypeOf<Services>();
    expectTypeOf<
        BotRegistryServices<typeof contextFreeEventRegistry>
    >().toEqualTypeOf<Services>();

    const services = createServices(() => {});
    const runtimeOptions = {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: (options: ClientOptions) => new Client(options),
        services,
    };
    createDiscordBot(handlerFreeRegistry, runtimeOptions);
    createDiscordBot(contextFreeCommandRegistry, runtimeOptions);
    createDiscordBot(contextFreeEventRegistry, runtimeOptions);

    const invalidServices = () => {
        // @ts-expect-error The handler-free definitions still require their services.
        createDiscordBot(handlerFreeRegistry, {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: (options) => new Client(options),
        });
        // @ts-expect-error A context-free command still requires its services.
        createDiscordBot(contextFreeCommandRegistry, {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: (options) => new Client(options),
        });
        // @ts-expect-error A context-free event still requires its services.
        createDiscordBot(contextFreeEventRegistry, {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: (options) => new Client(options),
        });
        createDiscordBot(contextFreeEventRegistry, {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: (options) => new Client(options),
            // @ts-expect-error The service value must match the factory's Services type.
            services: { wrong: true },
        });
    };
    expectTypeOf(invalidServices).toBeFunction();
});
test("preserves services through all command paths, event and generated factory with standard Client", async () => {
    const values: string[] = [];
    const services = createServices((value) => {
        values.push(value);
    });
    const registry = createBotRegistry([root, sub, menu], [ready]);
    expectTypeOf<
        BotRegistryServices<typeof registry>
    >().toEqualTypeOf<Services>();
    expectTypeOf<
        BotRegistryServices<typeof botRegistry>
    >().toEqualTypeOf<Services>();
    const dispatcher = new CommandDispatcher({
        client: new Client({ intents: [] }),
        registry,
        services,
    });
    for (const kind of ["root", "sub", "menu", "autocomplete"] as const)
        expect((await dispatcher.dispatch(interaction(kind))).handled).toBe(
            true,
        );
    const client = new Client({ intents: [] });
    client.login = async () => "token";
    const bot = createGeneratedDiscordBot({
        token: "token",
        clientOptions: { intents: [] },
        services,
        clientFactory: () => client,
    });
    expectTypeOf(bot.client).toEqualTypeOf<Client>();
    await bot.start();
    client.emit(Events.ClientReady, client as Client<true>);
    await Promise.resolve();
    await bot.stop();
    expect(values).toEqual(["root", "sub", "menu", "autocomplete", "event"]);
    const invalid = () => {
        // @ts-expect-error Generated factory requires the declared services.
        createGeneratedDiscordBot({
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: (options) => new Client(options),
        });
        new DiscordBot(registry, {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: (options) => new Client(options),
            // @ts-expect-error Services must match the registry.
            services: { wrong: true },
        });
        new CommandDispatcher({
            client: new Client({ intents: [] }),
            registry,
            // @ts-expect-error Services must match the registry.
            services: { wrong: true },
        });
        createDiscordBot(registry, {
            token: "token",
            clientOptions: { intents: [] },
            clientFactory: (options) => new Client(options),
            // @ts-expect-error Services must match the registry.
            services: { wrong: true },
        });
    };
    expectTypeOf(invalid).toBeFunction();
});

test("stop skips an event queued before its operation starts", async () => {
    const values: string[] = [];
    const client = new Client({ intents: [] });
    client.login = async () => "token";
    const errors: string[] = [];
    const bot = createDiscordBot(createBotRegistry([], [ready]), {
        token: "token",
        clientOptions: { intents: [] },
        clientFactory: () => client,
        services: {
            record: (value: string) => {
                values.push(value);
            },
        },
        onError: (_error, context) => {
            if (context.aborted) errors.push(context.phase);
        },
    });
    await bot.start();
    client.emit(Events.ClientReady, client as Client<true>);
    await bot.stop();
    expect(values).toEqual([]);
    expect(errors).toEqual(["event"]);
});
