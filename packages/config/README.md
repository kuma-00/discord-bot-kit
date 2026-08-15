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

## Versioned YAML migrations

Set a positive integer `version` and provide every one-step migration from v1
to that version. A YAML document without `version` is treated as v1. Migrations
run only on the YAML layer, before defaults, environment bindings, and explicit
overrides are merged:

```ts
const appConfig = defineConfig({
    schema: currentConfigSchema,
    version: 3,
    migrations: [
        { from: 1, to: 2, migrate: migrateV1ToV2 },
        { from: 2, to: 3, migrate: migrateV2ToV3 },
    ],
});
```

Migration functions may be synchronous or asynchronous and must return a YAML
mapping. The loader owns the top-level `version` field, which remains part of
the validated output schema. YAML strings migrate in memory only. After a file
migration passes final validation, the original is preserved as a non-
overwriting `.v<old>.bak` file and the migrated YAML atomically replaces it.
The backup and replacement preserve the original file's permission mode.
For a symlinked configuration path, migration updates the resolved target and
leaves the symlink intact; the backup is stored beside that target. Concurrent
migrations of the same resolved file use one adjacent heartbeat lease, even
through different symlinks. A competing loader fails without replacing the
file, while a stale lease left by an abnormal exit is recovered. Symlink
retargeting, inode replacement, and content changes detected before replacement
also stop migration, although writers that do not honor the lease cannot be
excluded after the final check. Re-serialization does not preserve YAML
comments or formatting.

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
