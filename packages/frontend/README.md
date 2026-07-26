# @kuma-00/bot-kit-frontend

UI-framework-neutral HTTP and realtime client state.

```ts
import { FrontendApiClient } from "@kuma-00/bot-kit-frontend";
import { healthContract } from "./contracts.ts";

const client = new FrontendApiClient({ baseUrl: "https://api.example.com" });
const result = await client.request(healthContract, {});
```
