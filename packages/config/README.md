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

## Safe error diagnostics

Use `toConfigDiagnostics` at the application boundary to convert any thrown
value into logger-neutral, JSON-serializable data. The helper has no logger
dependency, so the consumer decides how (or where) to emit it:

```ts
import {
    loadDefinedConfig,
    toConfigDiagnostics,
} from "@kuma-00/bot-kit-config";

try {
    await loadDefinedConfig(appConfig);
} catch (error) {
    logger.error(toConfigDiagnostics(error), "Configuration loading failed");
    throw error;
}
```

For a `ConfigError`, the result has `kind: "config-error"`, a stable `code`,
the failed `source`, a safe `message`, optional `path`, `issues`, and a safe
`cause`. Unknown thrown values become a fixed diagnostic with
`kind: "unknown-error"`, `code: "unknown"`, `message: "Unknown configuration
error"`, an empty `issues` array, and `cause: "unknown"`. Raw causes, stacks,
configuration values, and environment values are never copied.

Bindings marked `secret: true` are carried into `ConfigError` metadata by
`loadConfig` and `loadDefinedConfig`. If a validation issue path overlaps a
secret path (including an ancestor or descendant), its message is replaced by
`"Invalid secret configuration value"` and it is marked `redacted: true`.
Consumers should pass the diagnostic directly to their logger and no longer
maintain a separate list of secret paths for redaction.
