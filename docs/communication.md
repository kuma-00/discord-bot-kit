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

Upload routeではcontractに`requestBody: { encoding: "multipart/form-data" }`を指定します。
`body`は文字列、`Blob`/`File`、または同名フィールドの配列を受け付けます。Transportは
`FormData`を作り、`content-type`を削除してFetchにboundary生成を委譲します。Backendは
`formData()`を読み、単一値をscalar、反復名をarrayとして完全なinput schemaを検証します。
`maxBytes`超過は、`Content-Length`がある場合は事前に、ない場合もmultipartの
エンコード済みrequest bodyをストリームで読み取りながら判定して413を返します。
content-type不正やmultipart解析失敗は安全な400です。
`maxBytes`はmultipartでのみ指定でき、0以上の安全な整数（バイト数）でなければなりません。

Backendが入力を受け付けられない場合の`invalid-input`、`invalid-multipart`、
`payload-too-large`のenvelopeには`kind: "request-input"`を付け、契約のerror detailsを
持たない標準エラーです。
Transportはmarkerとcode/statusの組み合わせが正しい場合のみHTTP失敗（`{ kind: "http", status }`）としてそのまま返し、
不正なmarkerやstatus、`details`が混在する標準エラーは`invalid-error-response`にします。
契約のerror schemaでは検証しません。認証・認可失敗の標準契約も以下のとおり分離します。
その他の宣言済み失敗は引き続き
`error.details`を契約schemaで検証します。

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
Fetch、SSE parser、接続life cycle、再接続を一元所有する型付きclientです。transportが
管理するactive attempt、AbortController、stream reader、retry timerはそれぞれ最大1つです。
`stop()`は同期的に`closed`へ遷移し、保留timerを破棄してFetchとreaderのcancelを開始します。
`stop()`直後の再startは旧generationのtransport管理処理が終了した後に実行され、古い
generationのresponse、reader結果、timer callbackは無視されます。
停止後にFetchが遅れて返したresponse bodyは破棄され、遅れてrejectしても未処理のrejectには
なりません。注入するFetch実装は基盤resourceを速やかに解放するため`RequestInit.signal`を
尊重する必要があります。signalを無視する実装でもsubscriptionの停止と再startは妨げませんが、
transportから停止できない旧Fetch処理が外部実装内に残り、新attemptと重なる可能性があります。

イベントEnvelopeは`id`、`type`、`version`、`occurredAt`、任意の`guildId`、`payload`を持ちます。v0.1.0はSSEのみを提供し、WebSocketは扱いません。
`createEventRegistry`で複数のevent contractを`type + version`単位に束ねられます。
JSON不正、未知の契約、payload validation失敗はイベント単位で`onEventError`へ通知し、
接続と後続イベントの配送を継続します。接続状態は標準`readyState`に対応する
`connecting`、`open`、`closed`だけを通知します。named eventは契約の`type`、
通常のeventは`message` listenerで受信します。

`connecting`は初回接続、再接続attempt、backoff待機を表し、`open`はstatus 200、
`text/event-stream`、ReadableStream bodyの検証後にstreamを読んでいる状態です。
`closed`は明示停止または再試行しない恒久failureを表し、active接続とtimerを持ちません。
接続failureは`onConnectionFailure`へ通知します。network断、予期しない`AbortError`、EOF、
408、425、429、5xxは再試行し、401、403、404、204、その他の非200、media type不正、
body不正は恒久failureとして閉じます。明示的な`stop()`に伴うabortはfailure通知しません。
JSON、event contract、payload、consumer callbackのfailureは従来どおり`onEventError`へ
イベント単位で通知し、接続を継続します。

SSE parserが保持する未完了lineと未配送eventの合計は、既定で1,048,576文字へ
制限します。`maxBufferSize`で正の安全な整数へ変更できます。上限超過は
`invalid-response`の`stream-format`として通知し、再試行せず閉じます。
SSE仕様上無視できる未知fieldや不正な`retry:`は、接続failureにはしません。

再接続は既定で3秒から始まる指数backoffを使い、2倍ずつ最大30秒まで増加させ、
±20%のjitterを加えます。retryable HTTP responseの有効な`Retry-After`を最優先し、
次に最後に受信したSSE `retry:`、最後にclient既定値を使います。`Retry-After`には
jitterを加えません。すべてのdelayは設定された最大値へclampし、有効な`open`後に
backoffをresetします。`reconnect: false`では一時failureも再試行しません。

automatic reconnectでは最後に受信したSSE `id:`を`Last-Event-ID`として送信します。
空の`id:`はcursorをclearし、JSON envelopeの`id`はcursorの代用にしません。
手動のstop/startは新しいlife cycleとしてcursorをclearします。transportは重複排除や
切断区間のdomain再同期を行いません。consumerはeventを冪等に適用するか、`open`復帰後に
HTTPなどのauthoritative sourceから再同期します。

`SseSubscription`はSSE parserが受信したeventを受信順に処理します。JSON parse、
contract validation、`onEvent`、`onEventError`を含むapplication-level deliveryは
直列化され、後から受信したeventが先にconsumerへ適用されることを防ぎます。
`stop()`はnetwork connectionを同期的に閉じ、未実行の旧connection eventを破棄します。
実行開始済みのcallbackは完了を許可し、新connectionのeventはその完了後に処理します。
automatic reconnectのattempt間でも同じdelivery chainを使い、受信順を維持します。

## 標準401/403

`createAccessFailure("unauthorized")`は`error.kind: "access"`、code
`unauthorized`の標準failureです。`forbidden`は同じmarkerで権限不足を表します。
`accessFailureStatus`はそれぞれ401/403を返し、backendの`accessFailureResponse`が
status付きResponseへserializeします。`authenticateApiKey`も同じ形式を返します。
どちらもdomain固有detailsを持ちません。Transportはmarker、code/statusの対応、
`details`プロパティが存在しないことを検証し、`{ kind: "http", status }`を返します。
object必須のdomain error schemaにも渡しません。不明marker、code/status不一致、detailsの
混在は`invalid-error-response`です。markerを付けない宣言済みdomain failureのschema検証、
既存request-input 400/413、safe 500の分類は従来どおりです。safe 500はerror schemaが
undefinedを拒否する場合、引き続き`invalid-error-response`になります。

Elysiaの`authorize({ request, params })`はAPI key検証後、route実行またはSSE購読前に
consumerのaccess checkをawaitします。許可はundefined、拒否は`AccessFailure`です。
認可済みcontext注入や汎用middlewareの責務は持ちません。
`authorize`とSSE `responseFactory`のthrow/rejectはbackendの既存error boundaryで
安全な500へ変換し、例外messageを公開しません。500のtransport分類は変更しません。

## 全配信とscope別SSE

`SseEventBroker.publish(event)` / `response(signal?)`は従来の全配信APIです。
**全配信は非scopeと全scopeのactive subscriberへ届きます。**
`publishTo(scope, event)` / `responseFor(scope, signal?)`は追加APIです。
**scope別配信は同じscopeのsubscriberだけへ届き、別scope・非scopeへ届きません。**
scopeは非空の不透明なstringで、比較時に正規化しません。scope欠落、非string、空文字・
空白のみはTypeErrorになり、全配信へfallbackしません。guildの認可policyはconsumerが所有します。

| Publish | 非scope | scope A | scope B |
| --- | --- | --- | --- |
| `publish(event)` | 配送 | 配送 | 配送 |
| `publishTo("A", event)` | 非配送 | 配送 | 非配送 |
| `publishTo("B", event)` | 非配送 | 非配送 | 配送 |

brokerの`heartbeatIntervalMs`は1〜2,147,483,647の安全な整数（ms）で、省略時は無効です。
Bun timerのoverflowで短い間隔へ変わらないよう、上限を超える値は拒否します。
heartbeatは`: heartbeat`のSSE commentであり、domain contractを使いません。
既定headerは`cache-control: no-cache, no-transform`、`connection: keep-alive`、
`content-type: text/event-stream; charset=utf-8`です。`headers`でproxy用headerを追加・
上書きでき、content-typeはbrokerが維持します。abort前のresponseは閉じたbodyで返り、
subscriberを作りません。abort/cancel/enqueue失敗は冪等cleanupへ到達し、subscriber、
abort listener、heartbeat timerと空scopeを解放します。

Elysiaの`sse`には従来の`broker`か`responseFactory({ request, params })`の一方を渡します。
consumerがfactory内で認証・認可し、許可後に`responseFor`を呼びます。拒否は標準
`AccessFailure`またはconsumerのResponseを返せます。認可失敗時はbrokerを呼ばないでください。
replay、分散配送、slow consumer policy、接続snapshotは提供しません。

## 複数contractのfrontend

`RealtimeController`は単一`contract`か`contracts: EventRegistry`の一方を必須とし、
registryから`lastEvent`の判別unionを推論します。Svelteの`createRealtimeStores`でも
その型を保持します。unknown type/version、不正payloadは`onEventError`へ通知し、
後続eventを受信順に処理します。start/stop/retry・failure分類はtransportへ委譲し、
controller固有retry/cache更新を追加しません。最終store unsubscribeで停止します。

[最小consumer利用例](minimum-integration.md)を参照してください。
