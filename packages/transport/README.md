# @kuma-00/bot-kit-transport

Contract-driven Fetch and standard EventSource transport for Bun applications.

```ts
import { HttpClient } from "@kuma-00/bot-kit-transport";
import { healthContract } from "./contracts.ts";

const client = new HttpClient({ baseUrl: "https://api.example.com" });
const result = await client.request(healthContract, {});
```
