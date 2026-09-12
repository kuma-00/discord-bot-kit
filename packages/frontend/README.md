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
