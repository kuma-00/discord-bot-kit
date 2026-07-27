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

`SseEventBroker`がBackendから複数consumerへイベントを配信します。`SseSubscription`はfetch streamをincrementalに解析し、次を提供します。
SSE protocolの解析には`eventsource-parser`を使用し、接続life cycle、再接続、
schema検証、callbackの直列化はtransportが管理します。

- 任意chunk境界への対応
- `Last-Event-ID`
- 既定3000msの再接続待機時間
- server指定`retry`による以後の再接続待機時間の更新
- AbortSignalによる停止
- JSONとevent contractの検証

イベントEnvelopeは`id`、`type`、`version`、`occurredAt`、任意の`guildId`、`payload`を持ちます。v0.1.0はSSEのみを提供し、WebSocketは扱いません。
`createEventRegistry`で複数のevent contractを`type + version`単位に束ねられます。
JSON不正、未知の契約、payload validation失敗はイベント単位で`onEventError`へ通知し、
接続と後続イベントの配送を継続します。network・HTTP・stream errorは再接続対象です。
event callbackは直列に実行します。停止時はnetwork resourceを直ちに解放し、開始済みの
event処理と、それに伴う`onEventError`が完了してから`closed`へ遷移します。
成功responseはHTTP `200`かつ`Content-Type: text/event-stream`を必須とし、
Content-Typeのparameterは許可します。
headerが欠落している場合や別のmedia typeの場合は接続失敗として再接続します。
HTTP `204 No Content`はserverによる明示的な停止指示として扱い、再接続しません。
再接続は現在の待機時間が経過してから行い、接続失敗が続いても自動的には増加しません。
`minRetryMs`と`maxRetryMs`を指定した場合だけ待機時間をclampします。標準外の
full jitterが必要な場合は`jitter: true`で明示的に有効化できます。
event IDはSSE protocolのframe終端を解析した時点でacknowledgeします。
未完了のframeは反映せず、dataを持たずdispatchされない完了frameのIDも反映し、空の`id`は以後の
`Last-Event-ID`送信を解除します。
