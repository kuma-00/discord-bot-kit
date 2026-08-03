# 通信

## HTTP契約

`defineHttpContract`でoperation ID、method、path、入力・成功出力・エラー詳細のStandard Schemaを定義します。

Transportが扱う標準入力は次の形です。

```ts
interface HttpRequestInput {
    params?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
}
```

`HttpClient`はpath parameter、query、JSON bodyを組み立て、timeout、abort、header、API keyを処理します。HTTP responseは標準`ApiResult`
envelopeとして解釈し、成功時は`data`をcontractのoutput schema、契約に定義された
失敗時は`error.details`をerror schemaで検証します。JSON、envelope、data、error
detailsの不正、network、timeout、abortは`TransportFailureDetails`へ変換します。

## Backend

`defineRoute`はHTTP契約とframework-neutral handlerを対応付けます。`executeRoute`が入力と出力を検証し、`Request`から`Response`を生成します。
handlerは成功・失敗のどちらにも任意の`status`を指定できます。未指定時は成功`200`、
失敗`400`です。`status`はHTTP responseへ適用され、JSON envelopeには含めません。
失敗resultの`error.details`は必須で、常にcontractのerror schemaで検証します。
詳細が不要なrouteは`undefined`、`null`、空objectなどを明示的に許可するschemaを
利用側で定義します。

Elysia adapterでは入力を次の形でhandlerへ渡します。

```ts
{
    params,
    query,
    body,
}
```

`authenticateApiKey`は既定で`x-api-key`を使用します。認証失敗responseへ設定済みkeyを含めません。

## SSE

`SseEventBroker`がBackendから複数consumerへイベントを配信します。`SseSubscription`は
標準`EventSource`の薄い型付きwrapperです。SSE protocol解析、接続life cycle、再接続、
`retry`、`Last-Event-ID`、HTTP statusとmedia typeの判定は`eventsource`へ委譲し、
transportはJSONとevent contractの検証だけを担当します。停止は標準APIと同じく
`close()`相当で同期的に行われます。

イベントEnvelopeは`id`、`type`、`version`、`occurredAt`、任意の`guildId`、`payload`を持ちます。v0.1.0はSSEのみを提供し、WebSocketは扱いません。
`createEventRegistry`で複数のevent contractを`type + version`単位に束ねられます。
JSON不正、未知の契約、payload validation失敗はイベント単位で`onEventError`へ通知し、
接続と後続イベントの配送を継続します。接続状態は標準`readyState`に対応する
`connecting`、`open`、`closed`だけを通知します。named eventは契約の`type`、
通常のeventは`message` listenerで受信します。

`SseSubscription`はEventSourceが受信したeventを受信順に処理します。JSON parse、
contract validation、`onEvent`、`onEventError`を含むapplication-level deliveryは
直列化され、後から受信したeventが先にconsumerへ適用されることを防ぎます。
`stop()`はnetwork connectionを同期的に閉じ、未実行の旧connection eventを破棄します。
実行開始済みのcallbackは完了を許可し、新connectionのeventはその完了後に処理します。
独自のretry clamp、jitter、SSE parser互換層は提供しません。SSE protocol、network
lifecycle、reconnect、retry、`Last-Event-ID`は引き続き`eventsource`へ委譲します。
