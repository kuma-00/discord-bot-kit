# @kuma-00/bot-kit-backend

Framework-neutral backend routes, authentication, error mapping, and SSE broadcasting.

```ts
import { defineRoute } from "@kuma-00/bot-kit-backend";
import { healthContract } from "./contracts.ts";

export const healthRoute = defineRoute({
    contract: healthContract,
    handler: () => ({ ok: true, data: { status: "ok" } }),
});
```

`executeRoute` parses multipart requests with `request.formData()`, normalizes
one value to a scalar and repeated names to arrays, then validates the complete
`{ params, query, body }` input. Missing multipart content type is a safe 400;
`maxBytes` violations are 413.
Framework-generated input failures include `kind: "request-input"` so clients can distinguish them from declared handler errors.

`accessFailureResponse(createAccessFailure("forbidden"))`はdomain detailsを持たない
標準403を返します。API key失敗も`kind: "access"`の標準401です。

`SseEventBroker.publish(event)`は**全active subscriber（非scopeと全scope）**へ配送します。
既存の`response(signal)`も維持しています。追加の`publishTo(scope, event)`は
`responseFor(scope, signal)`で作った**一致scopeだけ**へ届き、別scope・非scopeには届きません。
空・欠落・不正scopeは拒否し、全配信へfallbackしません。

```ts
const broker = new SseEventBroker({ heartbeatIntervalMs: 15_000 });
const legacy = broker.response(request.signal);
const scoped = broker.responseFor("A", request.signal);
broker.publishTo("A", { id: "1", data: event }); // scopedのみ
broker.publish({ id: "2", data: announcement }); // legacyとscopedの両方
```

heartbeatはSSE commentです。abort/cancel/enqueue失敗でtimer・listener・subscriber・
空scopeを冪等に解放します。既定cache-controlは`no-cache, no-transform`です。
`headers`でproxy用headerを設定できます。[利用例](../../docs/minimum-integration.md)。
