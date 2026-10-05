# Troubleshooting

Diagnose from the boundary where the failure first becomes observable. Do not
replace validated behavior with unchecked casts or copied internals.

## Package or Import Failure

1. Read the lockfile and confirm that selected bot-kit packages use compatible
   versions.
2. Inspect the installed package's manifest and exports.
3. Inspect the exact exported TypeScript source or declarations.
4. Check runtime, module, and peer dependency compatibility.
5. If an expected export is absent, report the version gap. Do not invent it.

## Configuration Failure

1. Identify the `ConfigError.source`.
2. Confirm that `file` and inline `yaml` were not both supplied.
3. Check precedence: defaults, YAML, environment, override.
4. Check environment parsers and dotted binding paths.
5. Inspect schema issue paths without logging secret values.

## Contract or Route Failure

1. Determine whether input parsing, handler execution, output parsing, or error
   mapping failed.
2. Confirm that client and server use equivalent contract definitions.
3. Verify params, query, and body serialization separately.
4. Inspect the raw JSON as an `ApiResult` envelope. Validate only success
   `data` with the output schema and failure `error.details` with the error
   schema; do not apply either schema to the whole envelope.
5. If a valid backend response is reported as `invalid-response`, confirm that
   backend and transport package versions agree on envelope handling.
6. Remove unsafe casts that hide Standard Schema failures.
7. Ensure unexpected errors map to safe responses and server-side diagnostics.

Access failures bypass the contract error-details schema only when the response
has `kind: "access"`, matching `unauthorized`/401 or `forbidden`/403 fields,
and no `details` property. Request-input bypass is limited to
`invalid-input`/400, `invalid-multipart`/400, and `payload-too-large`/413 with
`kind: "request-input"` and no `details`. Unknown markers, mismatched fields,
or added `details` are `invalid-error-response`. Valid bypasses classify as HTTP
failures. Other declared failures still validate details; safe 500
classification is unchanged.

## Transport Failure

Handle `TransportFailureDetails.kind` deliberately:

- `aborted`: the caller cancelled; do not retry automatically.
- `timeout`: the configured deadline expired.
- `network`: Fetch did not produce an HTTP response.
- `http`: the server returned an error response.
- `invalid-response`: a response or payload failed contract validation.

Check that timeout timers and abort listeners are removed after every outcome.
Never log API-key header values.

## SSE Failure

1. Inspect the connection failure kind, status, `retrying`, and `retryInMs`;
   never log configured header values.
2. Treat `connecting` as active connection or backoff work. A `closed` state
   after 401/403/404/204 or an invalid response requires corrected external
   state and an explicit restart.
3. Verify the response content type and that the body is a stream.
4. Test parsing across arbitrary byte and line chunk boundaries, including the
   configured `maxBufferSize`; an oversized incomplete event closes permanently
   as `stream-format`.
5. Validate the event envelope and payload contract separately from connection
   failures; event validation failure does not close the stream.
6. Confirm `Last-Event-ID`, `Retry-After`, server `retry:`, exponential backoff,
   jitter, and reset after open.
7. Confirm that abort stops active reads and pending backoff, and that only one
   Fetch exists per subscription.
8. Confirm that server subscribers and frontend online/visibility listeners are
   removed.

For scoped SSE, compare scope strings exactly: they are opaque, nonempty values;
empty and whitespace-only scopes are invalid and must throw rather than fall
back to broadcast. A heartbeat uses an optional 1..2,147,483,647 ms safe
integer and emits an SSE comment.
Confirm the mandatory event-stream content type remains set after custom
headers. Cancellation, abort, and enqueue failure should release the subscriber,
listeners, timer, and empty scope. In Elysia, configure only one of `broker` or
`responseFactory`; authenticate and authorize before creating a subscription.

For a multi-contract `RealtimeController`, confirm exactly one of `contract`
and `contracts` is supplied, and narrow `lastEvent` by `type` before accessing
its payload. Unknown type/version or payload errors should reach
`onEventError` without closing the stream. Verify that final Svelte store
unsubscribe stops the controller; snapshot refresh and event idempotency remain
consumer responsibilities.

Do not switch to WebSocket as a repair; SSE is the supported realtime transport.

## Discord Lifecycle or Dispatch Failure

1. Confirm the command or event is present in the static registry.
2. Check normalized IDs and duplicate registration errors.
3. Distinguish chat-input, autocomplete, unregistered, and unrelated
   interactions.
4. Confirm handlers were registered once and login succeeded.
5. Inspect the injected error handler before adding local catch blocks.
6. Confirm `stop` destroys the client during shutdown and test cleanup.
7. Use static default-export definitions and `createBotRegistry(commands, events)`;
   inspect the generated factory when registry generation is used. Inject the
   same consumer-owned services object into the bot runtime.
8. `dispatchWrapper` includes defer and the unhandled hook, but adds no timeout.
   When continuing kit dispatch, call and await `next()` once while the wrapper
   is active; a wrapper may return a `DispatchResult` without calling it.
   Calling `next()` more than once or after the wrapper settles throws. The hook
   runs only for unhandled results returned by internal kit dispatch;
   wrapper/hook exceptions belong to the dispatch boundary and are not sent
   back through that hook. `stop` requests
   cooperative cancellation of tracked dispatch work.
9. Chat-input defer is enabled only by explicit runtime defaults or command
   settings; do not assume an implicit default defer when diagnosing an
   interaction timeout.

Do not add runtime directory scanning to solve missing registrations.
