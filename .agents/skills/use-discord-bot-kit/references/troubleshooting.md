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
4. Remove unsafe casts that hide Standard Schema failures.
5. Ensure unexpected errors map to safe responses and server-side diagnostics.

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

1. Verify the response content type and that the body is a stream.
2. Test parsing across arbitrary byte and line chunk boundaries.
3. Validate the event envelope and payload contract.
4. Confirm `Last-Event-ID`, server `retry`, and exponential backoff behavior.
5. Confirm that abort stops active reads and pending backoff.
6. Confirm that server subscribers and frontend listeners are removed.

Do not switch to WebSocket as a repair; SSE is the supported realtime transport.

## Discord Lifecycle or Dispatch Failure

1. Confirm the command or event is present in the static registry.
2. Check normalized IDs and duplicate registration errors.
3. Distinguish chat-input, autocomplete, unregistered, and unrelated
   interactions.
4. Confirm handlers were registered once and login succeeded.
5. Inspect the injected error handler before adding local catch blocks.
6. Confirm `stop` destroys the client during shutdown and test cleanup.

Do not add runtime directory scanning to solve missing registrations.
