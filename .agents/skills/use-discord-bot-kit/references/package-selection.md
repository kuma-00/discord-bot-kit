# Package Selection

Use this guide after inspecting the consumer's requirements and installed
versions. Install only the packages that own required behavior.

## Selection Table

| Requirement | Package | Consumer retains |
| --- | --- | --- |
| Merge defaults, YAML, environment values, and overrides; validate the result | `@kuma-00/bot-kit-config` | Application schema, environment names, defaults |
| Define shared HTTP and event runtime contracts | `@kuma-00/bot-kit-contracts` | Domain-specific contracts and schemas |
| Call contract-driven HTTP endpoints or subscribe to validated SSE | `@kuma-00/bot-kit-transport` | Base URL, credentials, retry policy choices |
| Manage a Discord.js client, static commands/events, and lifecycle | `@kuma-00/bot-kit-bot` | Commands, events, intents, token, domain services |
| Execute framework-neutral routes, API-key auth, error mapping, or publish SSE | `@kuma-00/bot-kit-backend` | Domain handlers, authorization policy, persistence adapters |
| Expose backend routes through Elysia | `@kuma-00/bot-kit-elysia` | Elysia composition and deployment |
| Manage UI-neutral API, authentication, or realtime state | `@kuma-00/bot-kit-frontend` | Product state and UI behavior |
| Expose frontend observables as Svelte stores | `@kuma-00/bot-kit-svelte` | Svelte components and product stores |

## Dependency Direction

```text
config        contracts
                 ↑
              transport
              ↗      ↖
            bot     frontend ← svelte

backend ← elysia
   ↑
contracts
```

- Core packages remain framework-neutral.
- `elysia` adapts `backend`; `svelte` adapts `frontend`.
- Bot, backend, and frontend implementations do not import each other.
- Cross-process data is shared through contracts, not implementation packages.

## Common Combinations

- Discord-only process: `config` + `bot`.
- Typed backend: `config` + `contracts` + `backend`; add `elysia` only for an
  Elysia server.
- Typed browser or UI client: `contracts` + `transport` + `frontend`; add
  `svelte` only for Svelte stores.
- Full HTTP application: define contracts once, then use `backend` on the server
  and `transport` or `frontend` on the client.
- Realtime application: define event contracts, publish with `backend`, consume
  with `transport` or `frontend`, and adapt state with `svelte` if needed.

## Installation Rules

- Use Bun commands and keep all selected `@kuma-00/bot-kit-*` packages on the
  same version unless the published metadata explicitly permits otherwise.
- Inspect each selected package's peer and direct dependencies before choosing
  versions of Discord.js, Elysia, Svelte, or a schema library.
- Prefer a Standard Schema-compatible validator already used by the consumer.
- Do not install adapter packages when the corresponding framework is absent.
