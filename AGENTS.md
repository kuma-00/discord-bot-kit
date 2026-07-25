# Agent Rules

## Repository Skill

- Use `.agents/skills/design-discord-bot-kit` for architecture, package additions, contract changes, transport changes, or dependency-boundary reviews.
- Treat `docs/` as the source of truth for repository architecture.

## Scope

- This repository owns reusable infrastructure only.
- Do not modify `nicobot-v6`, `gbot-v8Engine`, or `botbase` unless the user explicitly requests migration work.
- Keep bot-specific domains, persistence schemas, and UI out of this repository.

## Tooling

- Use Bun, not npm, for installation and scripts.
- Run `bun run biome:write`, `bun run check`, and `bun run test` after implementation.
- Run `bun run jsr:dry-run` before release-related changes.

## Boundaries

- Keep core packages framework-neutral.
- Add framework integrations as adapter packages.
- Update the package-boundary test and ADR when dependency directions change.
