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
