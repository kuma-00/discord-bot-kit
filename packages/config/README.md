# @kuma-00/bot-kit-config

Bun-first YAML, environment, and override configuration loading with Standard Schema validation.

```ts
import { defineConfig, loadDefinedConfig } from "@kuma-00/bot-kit-config";
import { z } from "zod";

const appConfig = defineConfig({
    schema: z.object({ token: z.string() }),
    defaults: { token: "" },
});

const config = await loadDefinedConfig(appConfig);
```
