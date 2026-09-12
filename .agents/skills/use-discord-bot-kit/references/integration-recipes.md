# Integration Recipes

These recipes describe composition and verification, not a frozen API
reference. Before coding, inspect the installed package exports and signatures.

## Configuration

1. Define the complete application configuration with a Standard
   Schema-compatible validator.
2. Call `loadConfig` from `@kuma-00/bot-kit-config`.
3. Supply sources in increasing precedence: defaults, one YAML source,
   environment bindings, then explicit overrides.
4. Mark secret environment bindings as secret and keep validators from
   embedding secret values in issue messages.
5. Catch `ConfigError` only where the application can report the failed source
   and terminate safely.

For versioned YAML, include the current positive integer `version` in the
application schema and loader options. Register a complete sequence of
one-version migrations from v1 to the current version. A file without a
version is treated as v1. Each synchronous or asynchronous migration receives
the YAML mapping only and returns the next mapping; defaults, environment
bindings, and overrides are merged afterward in their current shape.

File migrations are written only after final schema validation succeeds. The
loader preserves the original in a non-overwriting `.v<old>.bak` file and then
atomically replaces the YAML while preserving the original permission mode on
both files. Symlinked paths update their resolved target without replacing the
symlink, and backups are stored beside the target. Migrations of the same target
share an adjacent heartbeat lease even through different symlinks; competing
loaders fail without replacing the file, while stale leases are recovered.
Symlink retargeting, inode replacement, and content changes detected before
replacement also stop migration, but writers that do not honor the lease cannot
be excluded after the final check. Comments and original formatting are
retained in the backup rather than the rewritten file. Direct YAML strings
migrate only in memory. Test future and invalid versions, missing migration
steps, migration failure, validation failure without writeback, symlink
preservation, backup creation and permissions, concurrent migration, stale
lease recovery, and the `file-migrated` diagnostic.

For a logger-safe error boundary, import `toConfigDiagnostics` and pass its
result to the consumer's logger:

```ts
try {
    await loadDefinedConfig(applicationConfig);
} catch (error) {
    logger.error(toConfigDiagnostics(error), "Configuration loading failed");
    throw error;
}
```

`toConfigDiagnostics(error)` accepts `unknown` and returns a JSON-serializable
`ConfigErrorDiagnostic`. `ConfigError` results include `kind`, stable `code`,
`source`, safe `message`, optional `path`, `issues`, and `cause`; unknown
values return the fixed `unknown-error` shape. It never copies raw causes,
stacks, configuration values, or environment values. Secret bindings are
carried into loader error metadata. Validation issues overlapping a secret
path in either ancestor direction are replaced with
`Invalid secret configuration value` and `redacted: true`.

Before using this helper, inspect the installed package exports and type
declarations in the consumer's lockfile-resolved version. Existing
`ConfigError` handling remains compatible. Replace consumer-maintained secret
path lists with `secret: true` bindings and the diagnostic helper; do not
reimplement redaction in the logger.

Test recursive object merging, array replacement, missing files, environment
parsing, schema failure, and secret redaction.

## Discord Bot

1. Define `BotCommand` and `BotEvent` values with static imports.
2. Pass explicit command and event arrays to `createDiscordBot`.
3. Supply the required `clientFactory`, only the required Discord intents, and
   a logger and error handler that do not expose secrets.
4. Start once during application startup and call `stop` during shutdown.
5. Inject a fake client through `clientFactory` in tests to avoid connecting to
   Discord.

Remember that chat input commands defer by default, autocomplete has a separate
path, registry IDs are normalized, and duplicates are rejected. Keep voice,
queues, persistence, and command domain logic outside the library.

## Voice Connection

Use `@kuma-00/bot-kit-voice` for the framework-neutral, single-guild voice
connection lifecycle. Configure recovery in three stages: grace-period waiting,
bounded `rejoin`, then optional bounded `recreate`. Keep `AudioPlayer`, queue,
playlist, speech, recording, and guild-level controller composition in the
consumer. Subscribe consumer-owned players with
`connection.subscribe(audioPlayer)` in `onRecovered`; a recreate operation
returns a new connection and may require application state migration.

## HTTP Contract and Backend

1. Define input, success, and error schemas near a `defineHttpContract` call in
   a shared consumer module.
   The success schema describes `ApiResult.data`; the error schema describes
   `ApiResult.error.details`. Do not wrap either schema in the `ApiResult`
   envelope.
2. Pair the contract with a framework-neutral handler through `defineRoute`.
3. Execute and validate the route with backend helpers. Keep domain services
   behind consumer-defined ports.
4. Add `authenticateApiKey` only where API-key authentication is appropriate;
   configure the header explicitly when not using `x-api-key`.
5. Convert expected failures into the contract's error envelope and let the
   backend error boundary handle unexpected exceptions without leaking details.

For multipart uploads, set `requestBody.encoding` to `"multipart/form-data"`.
The transport accepts string/Blob/File fields and readonly arrays for repeated
names; the backend normalizes repeated names to arrays and validates the full
input. `maxBytes` must be a non-negative safe integer and produces 413, while
missing/invalid multipart input produces 400. These framework failures carry
`kind: "request-input"`; malformed markers are rejected by the client. Do not
set a manual multipart boundary header.

Test valid requests, invalid params/query/body, invalid handler output,
authentication failure, expected domain failure, and unexpected exceptions.

## Elysia Adapter

1. Build and test framework-neutral route definitions first.
2. Inspect `CreateElysiaAppOptions` for the installed version.
3. Pass the supported routes and application options to `createElysiaApp`.
4. Compose the returned Elysia instance with consumer middleware and deployment
   concerns outside the core route handlers.

Do not place Elysia types in shared contracts or backend domain handlers.

## HTTP Client and Frontend

1. Construct `HttpClient` with the base URL, timeout, headers, and optional API
   key appropriate to the environment.
2. Call `request` with the same `HttpContract` used by the backend and handle
   both branches of `ApiResult`. `executeRoute` and `HttpClient` own the
   standard success and failure envelopes.
3. Pass an `AbortSignal` from request ownership, such as navigation or
   component cleanup.
4. Use `FrontendApiClient` when UI-neutral frontend composition is useful; use
   `HttpClient` directly when state management adds no value.
5. Keep domain-specific state and rendering in the consumer.

Test contract input rejection, success-data validation, typed error-details
validation, malformed or invalid envelopes, network failure, timeout, and
caller cancellation. Include at least one test that connects `executeRoute`
directly to `HttpClient` through an injected Fetch implementation.

## SSE and Realtime State

1. Define an event contract with an envelope containing `id`, `type`, `version`,
   `occurredAt`, optional `guildId`, and validated `payload`.
2. Publish events from `SseEventBroker` and return its response from a
   consumer-owned route.
3. Consume the stream with `SseSubscription`, or use `RealtimeController` when
   frontend connection state, last-event state, and connection failures are
   needed. Leave transient retry ownership in transport; do not wrap either
   client in another reconnect timer.
4. Use `createRealtimeStores` only at a Svelte boundary.
5. Stop the subscription or controller and abort the server response when its
   owner is disposed.

`connecting` covers the initial attempt and retry backoff, `open` means a
validated SSE response is being read, and `closed` means explicit stop or a
failure that will not retry. Observe `onConnectionFailure` on a direct
subscription or the controller's failure observable. Network errors, unexpected
abort, EOF, 408/425/429, and 5xx responses retry by default; 401/403/404/204 and
invalid SSE responses stay closed. Resume after corrected authentication or
configuration with an explicit `start()` rather than an automatic terminal
failure loop.

Transport carries the SSE `id:` value in `Last-Event-ID` across automatic
attempts but does not deduplicate events or restore domain state. Make handlers
idempotent and refresh an authoritative HTTP snapshot after an `open` recovery.

Incomplete SSE lines and events are bounded to 1,048,576 characters by default.
Set `maxBufferSize` to a positive safe integer only when the application contract
requires a different maximum event size; exceeding it is a terminal
`stream-format` connection failure.

Test arbitrary chunk boundaries, invalid JSON, invalid event envelopes,
`Last-Event-ID`, server retry hints, reconnection, abort during backoff, and
listener cleanup.
