import { expect, test } from "bun:test";
import { Client, type Interaction } from "discord.js";
import { objectSchema, schema } from "../../../tests/schema.ts";
import { defineRoute, SseEventBroker } from "../../backend/src/index.ts";
import {
    createAccessFailure,
    createEventRegistry,
    defineEventContract,
    defineHttpContract,
} from "../../contracts/src/index.ts";
import { createElysiaApp } from "../../elysia/src/index.ts";
import { RealtimeController } from "../../frontend/src/index.ts";
import { HttpClient } from "../../transport/src/index.ts";
import { createBotRegistry, createDiscordBot } from "../src/index.ts";
import root from "./fixtures/services/commands/root.ts";
import ready from "./fixtures/services/events/ready.ts";

test("static Command -> typed service -> authorized HTTP mutation -> scoped SSE -> registry controller", async () => {
    const changed = defineEventContract({
        type: "ValueChanged",
        version: 1,
        payload: schema<{ value: string }>(
            (v): v is { value: string } =>
                typeof v === "object" &&
                v !== null &&
                typeof (v as { value?: unknown }).value === "string",
        ),
    });
    const contract = defineHttpContract({
        id: "update",
        method: "POST",
        path: "/values/:scope",
        input: objectSchema,
        output: objectSchema,
        error: objectSchema,
    });
    const broker = new SseEventBroker();
    let value = "initial";
    const route = defineRoute({
        contract,
        handler: ({ input, params }) => {
            value = String((input.body as { value: string }).value);
            const event = {
                id: "event-1",
                type: changed.type,
                version: 1,
                occurredAt: new Date().toISOString(),
                payload: { value },
            };
            broker.publishTo(params.scope ?? "", {
                id: event.id,
                type: event.type,
                data: event,
            });
            return { ok: true, data: { value } };
        },
    });
    const app = createElysiaApp({
        service: "minimum-consumer",
        apiKey: { apiKey: "test-key" },
        routes: [route],
        authorize: ({ params }) =>
            params.scope === "allowed"
                ? undefined
                : createAccessFailure("forbidden"),
        sse: {
            path: "/events/:scope",
            responseFactory: ({ request, params }) =>
                broker.responseFor(params.scope ?? "", request.signal),
        },
    });
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
        app.handle(new Request(input, init));
    const http = new HttpClient({
        baseUrl: "https://example.test",
        apiKey: "test-key",
        fetch,
    });
    let received!: () => void;
    const delivered = new Promise<void>((resolve) => {
        received = resolve;
    });
    let opened!: () => void;
    const connected = new Promise<void>((resolve) => {
        opened = resolve;
    });
    const realtime = new RealtimeController({
        url: "https://example.test/events/allowed",
        contracts: createEventRegistry([changed] as const),
        headers: { "x-api-key": "test-key" },
        fetch,
        reconnect: false,
    });
    const removeState = realtime.state.subscribe((state) => {
        if (state === "open") opened();
    });
    const removeEvent = realtime.lastEvent.subscribe((event) => {
        if (event?.payload.value === "root") received();
    });
    const client = new Client({ intents: [] });
    const bot = createDiscordBot(createBotRegistry([root], [ready]), {
        token: "test-token",
        clientOptions: { intents: [] },
        clientFactory: () => client,
        services: {
            record: async (next: string) => {
                const result = await http.request(contract, {
                    params: { scope: "allowed" },
                    body: { value: next },
                });
                expect(result).toEqual({ ok: true, data: { value: next } });
            },
        },
    });
    try {
        realtime.start();
        await connected;
        expect(broker.subscriberCount).toBe(1);
        const result = await bot.dispatcher.dispatch({
            commandName: "root",
            isChatInputCommand: () => true,
            isContextMenuCommand: () => false,
            isAutocomplete: () => false,
            isRepliable: () => false,
            options: {
                getSubcommandGroup: () => null,
                getSubcommand: () => null,
            },
        } as unknown as Interaction);
        expect(result.handled).toBe(true);
        await delivered;
        expect(value).toBe("root");
        expect(realtime.lastEvent.value?.type).toBe("ValueChanged");
        const denied = await http.request(contract, {
            params: { scope: "denied" },
            body: { value: "bad" },
        });
        expect(denied).toMatchObject({
            ok: false,
            error: {
                code: "forbidden",
                details: { kind: "http", status: 403 },
            },
        });
        expect(value).toBe("root");
    } finally {
        realtime.stop();
        removeState();
        removeEvent();
        await bot.stop();
        client.destroy();
    }
    expect(broker.subscriberCount).toBe(0);
    expect(broker.scopeCount).toBe(0);
});
