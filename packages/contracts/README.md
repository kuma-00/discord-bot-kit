# @kuma-00/bot-kit-contracts

Framework-neutral HTTP and event contracts for Discord bot systems.

```ts
import { defineHttpContract } from "@kuma-00/bot-kit-contracts";
import { z } from "zod";

export const healthContract = defineHttpContract({
    id: "health",
    method: "GET",
    path: "/health",
    input: z.object({}),
    output: z.object({ status: z.literal("ok") }),
    error: z.object({}),
});
```

For uploads, set `requestBody: { encoding: "multipart/form-data", maxBytes? }`.
Omitting `requestBody` keeps JSON serialization. Multipart input uses
`body: Record<string, string | Blob | readonly (string | Blob)[] | undefined>`;
repeated fields are represented as arrays by the backend.
