# Command・HTTP・SSEの最小consumer

servicesはbootstrapで生成します。型だけを静的定義からimportし、module import時に
DB等を起動しません。Clientは標準Discord.js Clientを利用できます。

```ts
// services.ts: 型の定義。実装と起動はconsumer bootstrapが所有する。
export interface Services {
    readonly update: (value: string) => Promise<void>;
}
```

```ts
// commands/update.ts: static default export
import { createCommandDefinition } from "@kuma-00/bot-kit-bot";
import { SlashCommandBuilder } from "discord.js";
import type { Services } from "../services.ts";

export default createCommandDefinition<Services>()({
    kind: "chat-input",
    id: "update",
    builder: new SlashCommandBuilder().setName("update").setDescription("Update"),
    execute: async (_client, _interaction, { services, signal }) => {
        signal.throwIfAborted();
        await services.update("updated");
    },
});
```

```ts
// events/ready.ts: Client、services、Discord event tupleを別々に保持する。
import { Client, Events } from "discord.js";
import { createEventDefinition } from "@kuma-00/bot-kit-bot";
import type { Services } from "../services.ts";

export default createEventDefinition<Client, Services>()({
    id: "ready",
    event: Events.ClientReady,
    execute: (_client, _args, { services }) => services.update("ready"),
});
```

`generateBotRegistry`で生成し、生成済みfactoryへservicesを渡します。
wrapperはconsumerのAsyncLocalStorage等で`next`全体を包めます。

```ts
const bot = createGeneratedDiscordBot({
    token,
    clientOptions: { intents: [] },
    clientFactory: options => new Client(options),
    services,
    dispatchWrapper: (interaction, next) => logContext.run({ id: interaction.id }, next),
    onUnhandledInteraction: async (interaction, result) => {
        await consumerFallback(interaction, result.reason);
    },
});
await bot.start();
```

HTTP contractはinput/output/domain errorのschemaを持ち、handlerがcommitした変更を
brokerへ通知します。認可対象scopeをrequest bodyから信用せず、認証済みactorのpolicyと
path paramsから決めます。`authorize`は標準401/403のみを扱うaccess checkです。

```ts
import { createAccessFailure } from "@kuma-00/bot-kit-contracts";
import { SseEventBroker } from "@kuma-00/bot-kit-backend";
import { createElysiaApp } from "@kuma-00/bot-kit-elysia";

const broker = new SseEventBroker({
    heartbeatIntervalMs: 15_000,
    headers: { "x-accel-buffering": "no" },
});
const app = createElysiaApp({
    service: "consumer",
    routes,
    authorize: async ({ request, params }) => {
        const actor = await authenticate(request);
        if (!actor) return createAccessFailure("unauthorized");
        if (!params.scope || !(await canAccess(actor, params.scope))) {
            return createAccessFailure("forbidden");
        }
        return undefined;
    },
    sse: {
        path: "/events/:scope",
        responseFactory: ({ request, params }) =>
            broker.responseFor(params.scope ?? "", request.signal),
    },
});

// commit済みeventを、認可対象scopeにだけ通知する。
broker.publishTo(scope, { id: event.id, type: event.type, data: event });
// 明示的な全配信はscopeに関係なく全active subscriberへ届く。
broker.publish({ id: announcement.id, data: announcement });
// 既存の非scope購読も全配信を受け取る。scope別publishは受け取らない。
const legacyResponse = broker.response(request.signal);
```

単一contractなら`contract`、複数なら`contracts`を使います。domain eventのtypeで
payloadを絞り込めます。HTTP snapshotとの再同期と重複排除はconsumerが所有します。

```ts
const realtime = new RealtimeController({
    url: "/events/allowed",
    contracts: createEventRegistry([changedContract, deletedContract] as const),
    onEventError: error => reportEventError(error),
});
const stores = createRealtimeStores(realtime);
const unsubscribe = stores.event.subscribe(event => {
    if (event?.type === changedContract.type) applyChanged(event.payload);
});
// 最終store購読を解除すると接続も停止する。
unsubscribe();
```

実行可能な結合例は
[`minimum-consumer.test.ts`](../packages/bot/test/minimum-consumer.test.ts)です。
static default export→services→認可済みHTTP→scope SSE→registry controllerを実行し、
403拒否、停止時のsubscriber/scope解放も検証します。
Skillを使うconsumerはまずインストール済みpackage versionと公開sourceを確認してください。
