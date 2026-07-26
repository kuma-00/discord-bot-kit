---
name: use-discord-bot-kit
description: Integrate the @kuma-00/bot-kit-* libraries into Bun TypeScript applications. Use when an agent needs to select discord-bot-kit packages, add or update configuration, Discord commands and events, typed HTTP or event contracts, backend or Elysia routes, Fetch or SSE clients, frontend state, or Svelte stores, or diagnose an existing discord-bot-kit integration.
---

# Use Discord Bot Kit

Build consumer applications with the smallest appropriate set of
`@kuma-00/bot-kit-*` packages. Keep application-specific behavior in the
consumer project.

## Workflow

1. Confirm that the consumer uses Bun. Treat other runtimes as unsupported
   unless the user explicitly accepts that risk.
2. Inspect the consumer's manifest, installed package versions, relevant source,
   schemas, and tests before proposing changes.
3. Read [package-selection.md](references/package-selection.md), select packages
   from the requested behavior, and preserve the documented dependency
   directions.
4. Inspect the exact installed package exports and type declarations before
   writing imports or calls. Use repository documentation only as conceptual
   guidance when it differs from the installed version.
5. Read the applicable section of
   [integration-recipes.md](references/integration-recipes.md), then implement
   the smallest end-to-end integration.
6. Validate every network boundary with a Standard Schema-compatible runtime
   schema. Validate configuration at startup.
7. Add focused tests for success, invalid input, external failure,
   cancellation, and lifecycle cleanup as applicable.
8. Run the consumer project's Bun formatting, type-checking, and test commands.
9. If validation fails, use
   [troubleshooting.md](references/troubleshooting.md) before changing the
   architecture.

## Source-of-Truth Order

Use sources in this order:

1. The consumer's lockfile and installed `@kuma-00/bot-kit-*` package version.
2. The installed package's exported TypeScript source or declarations.
3. Documentation matching that version.
4. The bundled references in this skill for stable concepts and workflows.

Never invent an export, option, response shape, or framework adapter. If the
installed version lacks a required capability, report the gap and present
consumer-owned alternatives. Do not copy library internals or create a
compatibility layer without explicit approval.

## Ownership Boundaries

Keep these concerns in the consumer application:

- commands, events, and product-specific Discord behavior
- voice connections, players, queues, playlists, speech, games, and message
  responses
- database-specific schemas, queries, and migrations
- concrete Discord OAuth session storage and policy
- product UI, routes, and domain state

Use a core package for framework-neutral behavior and an adapter package only at
the framework boundary. Do not make bot, backend, and frontend implementations
import one another directly; share runtime contracts instead.

## Required Safety Checks

- Do not expose configured secrets in logs, errors, fixtures, or generated
  examples.
- Treat schema validation errors as data-boundary failures, not trusted values.
- Distinguish timeout, caller cancellation, network failure, HTTP failure, and
  invalid responses.
- Propagate `AbortSignal` and clean up listeners, timers, SSE subscriptions, and
  streams.
- Stop the Discord client during shutdown and in test cleanup.
- Keep command and event registration static; do not add runtime directory
  scanning.
- Use SSE for the supported realtime path. Do not substitute WebSocket without
  an explicit architecture decision.

## Maintenance

When changing a public API or package responsibility in discord-bot-kit, update
the relevant bundled reference in the same change. Keep detailed signatures in
the library source and documentation rather than duplicating them here.
