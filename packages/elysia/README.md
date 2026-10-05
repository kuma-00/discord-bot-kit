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

`sse: { path, broker }`は既存の全配信接続を維持します。認可付きscope接続には
`sse: { path, responseFactory: ({ request, params }) => ... }`を使い、認可に成功した後だけ
`broker.responseFor(scope, request.signal)`を呼びます。factoryはResponseまたは
`createAccessFailure("unauthorized" | "forbidden")`を返せます。
`authorize({ request, params })`もAPI key検証後・route/SSE購読前にaccess checkを行えます。
[利用例](../../docs/minimum-integration.md)を参照してください。

認可hookとSSE response factoryの例外は既存の安全な500へ変換し、内部messageを公開しません。
