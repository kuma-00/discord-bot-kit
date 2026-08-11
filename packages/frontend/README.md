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
