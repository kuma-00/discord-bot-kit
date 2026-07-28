---
name: design-discord-bot-kit
description: Design, implement, and review reusable Discord bot infrastructure in the discord-bot-kit repository. Use for package additions, public API changes, configuration loading, HTTP or SSE contracts, Discord client lifecycle and registries, backend or frontend core changes, Elysia or Svelte adapters, JSR publishing changes, and dependency-boundary reviews.
---

# Design Discord Bot Kit

Keep the reusable Bun library independent from bot-specific domains. Treat the
repository documentation as the architecture source of truth.

## Workflow

1. Read the relevant documents before changing code:
   - Architecture or package ownership: `docs/architecture.md`
   - Dependency changes: `docs/package-boundaries.md`
   - Configuration: `docs/configuration.md`
   - HTTP, errors, or SSE: `docs/communication.md`
   - Discord client, commands, or events: `docs/bot-foundation.md`
   - Foundational tradeoffs: `docs/decisions/0001-initial-architecture.md`
2. Classify the requested behavior as reusable infrastructure, a framework
   adapter, or a bot-specific domain.
3. Keep bot-specific domains outside this repository. Do not modify
   `nicobot-v6`, `gbot-v8Engine`, or `botbase` unless migration is explicitly
   requested.
4. Put framework-neutral behavior in a core package. Put Elysia, Svelte, or
   another framework integration in an adapter package.
5. Define network boundaries with Standard Schema-compatible runtime schemas.
   Validate both input and output.
6. Preserve the dependency directions in `docs/package-boundaries.md`. When a
   direction must change, update the boundary test and ADR in the same task.
7. Add focused Bun tests for success, invalid input, external failure,
   cancellation, and lifecycle cleanup as applicable.
8. Run:

```sh
bun run biome:write
bun run check
bun run test
```

Run `bun run jsr:dry-run` when exported symbols, dependencies, manifests, or
release metadata change.

Release Please rewrites JSON `extra-files` with expanded arrays. Keep the
Biome override for `**/jsr.json` at `json.formatter.expand: "always"` so the
generated release commit passes `bun run check`. If release tooling or manifest
formatting changes, validate the generated release-style `jsr.json` files
instead of checking only the pre-release working tree.
Keep `include-component-in-tag: false` so Release Please emits `vX.Y.Z`; the
publish script and manual retry input use that component-free tag format.
Publish JSR packages in a deterministic topological order derived from their
`workspace:` dependencies. Reject unknown workspace dependencies and cycles;
do not fall back to directory or package-name order.

## Package Placement

Use the existing responsibilities:

- `config`: source merging and configuration validation
- `contracts`: framework-neutral runtime contracts and envelopes
- `registry`: Bun-time static module discovery and readonly registry generation
- `transport`: Fetch and SSE client behavior
- `bot`: Discord.js lifecycle, command/event composition, and dispatch
- `voice`: Discord voice transport lifecycle and bounded reconnect behavior
- `backend`: Request/Response routes, auth, errors, and SSE broker
- `elysia`: Elysia adapter only
- `frontend`: UI-neutral client and observable state
- `svelte`: Svelte store adapter only

Create a new package only when the responsibility would otherwise force an
unrelated dependency or framework into an existing package.

## Registry and Voice Patterns

- Put reusable module discovery in `registry`, not `bot`. Generate sorted
  static imports and readonly arrays; keep lookup maps, duplicate policy, and
  entry lifecycle in the consumer.
- Allow registry sources to select default or named exports and validate them
  at generation time. Exclude tests, declarations, and the output file. Commit
  generated source and provide a stale check.
- Directory scanning and dynamic imports are generation-time behavior only.
  Runtime bot code must use the generated static imports.
- Keep `voice` separate from `bot` so `@discordjs/voice` is optional for
  non-voice consumers. Limit it to one-guild connection lifecycle, Ready
  waiting, bounded recovery, cancellation, hooks, and cleanup.
- Keep audio players, speakers/listeners, queues, persistence, status syncing,
  and guild-level connection managers in consumers.
- Prefer responsibility files with a barrel-only `index.ts`. Split types,
  errors, adapters, async utilities, discovery, generation, and lifecycle
  logic once an entrypoint starts owning multiple concerns.

## JSR Documentation

- Add JSDoc to every exported class, function, interface, type, option object,
  error, and non-obvious constant. JSR renders this documentation as the public
  API reference.
- Document behavior and contracts rather than restating the TypeScript name:
  ownership, defaults, validation, cancellation, failure modes, idempotency,
  cleanup, and whether an operation runs at generation time or runtime.
- Add `@param`, `@returns`, and `@throws` where they clarify behavior. Include a
  short `@example` for generators, lifecycle controllers, or APIs whose correct
  call sequence is not obvious.
- Keep internal helpers unexported. Do not expose implementation details merely
  to make them documentable.
- Treat missing or stale public JSDoc as a release issue alongside slow types.
  Inspect the JSR dry-run file list and warnings before considering publication
  validation complete.

## Design Guardrails

- Support Bun as the only guaranteed runtime.
- Prefer Web standard APIs inside framework-neutral packages.
- Keep JSR public symbols explicitly typed and documented.
- Do not bypass JSR slow-type checks.
- Keep commands and events statically registered; do not add runtime directory
  scanning.
- Keep Bun-time registry validation imports fully dynamic with `import(fileUrl)`.
  JSR rewrites statically prefixed `file://` templates into package-relative
  paths, which breaks absolute consumer-module loading after publication. The
  resulting unanalyzable-dynamic-import diagnostic is the one accepted JSR
  dry-run exception for `registry`.
- Keep realtime v0.1 behavior on SSE. Add WebSocket only after an explicit
  architecture decision.
- Never expose configured secrets in errors or logs.
- Avoid compatibility layers unless a consumer requirement explicitly needs
  one.
