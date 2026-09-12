# @kuma-00/bot-kit-transport

Contract-driven Fetch and transport-owned SSE lifecycle for Bun applications.

```ts
import { HttpClient } from "@kuma-00/bot-kit-transport";
import { healthContract } from "./contracts.ts";

const client = new HttpClient({ baseUrl: "https://api.example.com" });
const result = await client.request(healthContract, {});
```

Multipart contracts are serialized to `FormData` (including `File`/`Blob` and
repeated fields). The client removes any caller-supplied `content-type` so
Fetch can add the boundary. Invalid input, HTTP failures, malformed responses,
network errors, timeouts, and caller cancellation are returned as typed
`ApiFailure` results.
Framework input failures are bypassed only with `kind: "request-input"` and a matching code/status pair; malformed markers are `invalid-error-response`.

`SseSubscription` owns Fetch, stream parsing, `Last-Event-ID`, and reconnection.
Transient network, EOF, 408/425/429, and 5xx failures retry with bounded
exponential backoff and jitter; authentication, missing endpoint, HTTP 204, and
invalid SSE responses close permanently. Observe connection failures with
`onConnectionFailure`, and call `stop()` when the subscription owner is disposed.
Application event validation failures remain isolated to `onEventError`.
Incomplete SSE lines and events are buffered up to 1,048,576 characters by
default. Set `maxBufferSize` to a positive safe integer when a different bound is
required; exceeding it reports a terminal `stream-format` connection failure.
