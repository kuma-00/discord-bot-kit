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
   frontend connection state and last-event state are needed.
4. Use `createRealtimeStores` only at a Svelte boundary.
5. Stop the subscription or controller and abort the server response when its
   owner is disposed.

Test arbitrary chunk boundaries, invalid JSON, invalid event envelopes,
`Last-Event-ID`, server retry hints, reconnection, abort during backoff, and
listener cleanup.
