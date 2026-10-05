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
`maxBytes` is valid only for multipart and must be a non-negative safe integer.
Omitting `requestBody` keeps JSON serialization. Multipart input uses
`body: Record<string, string | Blob | readonly (string | Blob)[] | undefined>`;
repeated fields are represented as arrays by the backend.

認証・認可の標準failureは`createAccessFailure("unauthorized" | "forbidden")`で
作り、`accessFailureStatus`で401/403に対応付けます。`error.kind: "access"`には
domain固有detailsを含めません。[通信契約](../../docs/communication.md)。
