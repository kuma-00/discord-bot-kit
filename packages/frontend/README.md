# @kuma-00/bot-kit-frontend

UI-framework-neutral HTTP and realtime client state.

```ts
import { FrontendApiClient } from "@kuma-00/bot-kit-frontend";
import { healthContract } from "./contracts.ts";

const client = new FrontendApiClient({ baseUrl: "https://api.example.com" });
const result = await client.request(healthContract, {});
```

`FrontendApiClient` delegates to the transport client, so multipart contracts,
typed HTTP/validation failures, timeout, network failure, and `AbortSignal`
cancellation have identical semantics. Pass a signal owned by the view or
request lifecycle and dispose it when that owner is gone.

`RealtimeController` exposes observable connection state, the last validated
event, and the current connection failure. Its transport reconnects transient
failures without recreating the controller. Browser online and visible-page
hints only accelerate a pending backoff; permanent failures remain closed until
the owner explicitly starts the controller again. Incomplete SSE input is bounded
to 1,048,576 buffered characters by default and can be configured with
`maxBufferSize`.

`RealtimeController`には`contract`か`contracts: createEventRegistry([...])`の
どちらか一方を必ず指定します。registryでは`lastEvent`がtype/payloadの判別unionです。
`onEventError`で未知のtype/versionや不正payloadを観測し、後続配送は続きます。
start/stop/retryとfailure分類はtransportに委譲します。[利用例](../../docs/minimum-integration.md)。
