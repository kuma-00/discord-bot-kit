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

`HttpClient`はpath parameter、query、JSON bodyを組み立て、timeout、abort、header、API keyを処理します。HTTP成功・エラーのどちらも契約schemaで検証し、networkや不正responseは`TransportFailureDetails`へ変換します。

## Backend

`defineRoute`はHTTP契約とframework-neutral handlerを対応付けます。`executeRoute`が入力と出力を検証し、`Request`から`Response`を生成します。
handlerは成功・失敗のどちらにも任意の`status`を指定できます。未指定時は成功`200`、
失敗`400`です。`status`はHTTP responseへ適用され、JSON envelopeには含めません。

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

`SseEventBroker`がBackendから複数consumerへイベントを配信します。`SseSubscription`はfetch streamをincrementalに解析し、次を提供します。

- 任意chunk境界への対応
- `Last-Event-ID`
- server指定`retry`
- exponential backoff
- full jitterと正常接続後のbackoff reset
- AbortSignalによる停止
- JSONとevent contractの検証

イベントEnvelopeは`id`、`type`、`version`、`occurredAt`、任意の`guildId`、`payload`を持ちます。v0.1.0はSSEのみを提供し、WebSocketは扱いません。
`createEventRegistry`で複数のevent contractを`type + version`単位に束ねられます。
JSON不正、未知の契約、payload validation失敗はイベント単位で`onEventError`へ通知し、
接続と後続イベントの配送を継続します。network・HTTP・stream errorは再接続対象です。
