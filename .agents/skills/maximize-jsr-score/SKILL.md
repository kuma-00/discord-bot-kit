---
name: maximize-jsr-score
description: Audit and improve TypeScript or JavaScript packages published to JSR until their current package-page score reaches 100%. Use for JSR score, package quality, missing documentation, slow types, provenance, package descriptions, runtime compatibility, jsr.json, deno.json, publish dry runs, or post-publish score remediation, including monorepos with multiple JSR packages.
---

# Maximize JSR Score

Treat the live JSR package page as the score authority. JSR changes factors and
weights, and its documentation explicitly says that completing every factor is
not always required for 100%.

## Workflow

1. Identify every target package, its manifest, public entrypoints, current
   published version, JSR URL, and whether the task permits publishing.
2. Read [references/jsr-score.md](references/jsr-score.md) before auditing.
3. Inspect the live **Score** tab for each published package. Record every
   satisfied and unsatisfied factor rather than inferring the score solely from
   repository files.
4. If the package is not published yet, use all documented factors as the
   provisional target and clearly label the result as a pre-publish forecast.
5. Fix repository-controlled factors:
   - include a useful README in the published files;
   - add a `@module` doc comment to every public entrypoint;
   - document every public symbol and important parameter, return value,
     thrown error, default, lifecycle rule, and non-obvious example;
   - replace slow public types with explicit, portable types; never use
     `--allow-slow-types` to claim completion;
   - keep the manifest valid, licensed, and limited to intended source,
     README, and license files.
6. Validate behavior and documentation with the repository's own formatter,
   type checker, tests, and release checks. For this repository run:

```sh
bun run biome:write
bun run check
bun run test
bun run jsr:dry-run
```

7. Fix JSR-hosted settings with the user’s authenticated session when needed:
   add a concise package description, link the GitHub repository, mark only
   runtimes actually verified as compatible, and configure GitHub Actions OIDC
   publishing for provenance.
8. Publish only when the user explicitly requests or authorizes publishing.
   Do not bump versions, create tags, publish, or change live package settings
   merely because the user requested an audit.
9. After publishing, reopen each package’s **Score** tab. Continue until it
   reports 100%, or report the exact remaining factor and the external action
   required. A successful dry run is necessary but does not prove a 100% score.

## Evidence Rules

- Separate local evidence, live JSR evidence, and assumptions.
- Verify compatibility with tests on each claimed runtime. Do not mark
  compatibility based only on ESM syntax or an aspirational README table.
- Require `contents: read` and `id-token: write` for the GitHub Actions publish
  job. Link the repository in JSR before relying on OIDC provenance.
- Prefer TypeScript source and ESM. Resolve every relative import and include
  file extensions unless the package deliberately uses supported sloppy
  imports with `package.json`.
- Preview generated API docs with `deno doc --html` when Deno is available.
- Treat missing public docs, documentation-generation warnings, excluded
  README/LICENSE files, slow types, or publish warnings as incomplete work.
- Never state “100%” from a checklist estimate. State it only after observing
  100% on the live Score tab for the newly published version.

## Handoff

Report a compact per-package table containing the starting score, ending score,
changed factors, validation results, published version, and remaining manual
actions. For unpublished work, report “forecast” instead of a numeric verified
score.
