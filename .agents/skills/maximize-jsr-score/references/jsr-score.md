# JSR Score Reference

Use the live official documentation when requirements may have changed:

- Scoring: https://jsr.io/docs/scoring
- Publishing: https://jsr.io/docs/publishing-packages
- Package settings and generated docs: https://jsr.io/docs/packages
- Writing documentation: https://jsr.io/docs/writing-docs
- Package configuration: https://jsr.io/docs/package-configuration
- Provenance: https://jsr.io/docs/trust
- Troubleshooting: https://jsr.io/docs/troubleshooting

## Current Score Categories

JSR currently groups score factors into:

1. **Documentation**: README presence, module documentation, and documentation
   coverage for public functions and types.
2. **Best practices**: no slow types and publication with provenance.
3. **Discoverability**: a package description configured on JSR.
4. **Compatibility**: at least one runtime marked compatible; broader verified
   compatibility can contribute additional credit.

The exact factors and weights are shown on each package’s **Score** tab and may
change. JSR states that completing every factor is not necessarily required to
reach 100%.

## What Local Validation Can Prove

`jsr publish --dry-run` verifies publish rules and prints the file set without
publishing. It can catch invalid imports, documentation-generation failures,
slow types, manifest errors, and unintended file inclusion. It cannot prove:

- the live JSR description is present;
- runtime compatibility settings are accurate;
- a published version has provenance;
- the current score or factor weights;
- that the server has recalculated the score.

## Documentation Checklist

- Publish a substantive `README.md`.
- Put a JSDoc block containing `@module` at the top of each exported entrypoint.
- Document all exported functions, classes, interfaces, types, variables, and
  constructors.
- Add `@param`, `@returns`, `@throws`, and `@example` where they add contract
  information.
- State supported runtimes, installation commands, entrypoints, and a working
  usage example.
- Preview with `deno doc --html` when practical.

## Provenance Checklist

- Link the JSR package to the administered GitHub repository.
- Publish from GitHub Actions using `jsr publish` or `deno publish`.
- Grant the publish job `contents: read` and `id-token: write`.
- Do not use a token-based publish when provenance is the target; JSR documents
  provenance for GitHub Actions OIDC publishing.

## Compatibility Checklist

JSR supports declaring Deno, Node.js, Cloudflare Workers, Bun, and browser
compatibility in package settings. Run a meaningful import and behavioral test
on each runtime before marking it supported. Keep unsupported or untested
runtimes as unsupported or unknown.

## Completion Standard

The only verified completion signal is the live package page showing a score of
100% after the intended version is published and processed. If publishing or
authenticated settings changes are out of scope, finish with a forecast and an
explicit action list instead.
