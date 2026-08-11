# @kuma-00/bot-kit-transport

Contract-driven Fetch and standard EventSource transport for Bun applications.

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
