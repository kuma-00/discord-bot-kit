# @kuma-00/bot-kit-elysia

Elysia adapter for bot-kit backend contracts and SSE.

```ts
import { createElysiaApp } from "@kuma-00/bot-kit-elysia";
import { healthRoute } from "./routes.ts";

createElysiaApp({
    service: "discord-bot",
    routes: [healthRoute],
}).listen(3000);
```

Multipart routes are registered with Elysia parsing disabled; the backend
executor owns `formData()` parsing and validation. This preserves the same
contract behavior when called directly or through the adapter.
