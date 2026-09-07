# norns-core — agent guide

This repo is a fork of `sveltejs/svelte`. **Our code is only `packages/norns-core/`** (`@human-synthesis/norns-core`, the Pug + Civet preprocessor for `.n` files). `packages/svelte/` and everything else is a pristine upstream mirror — never edit it; every change there is a future merge conflict.

## Working on packages/norns-core

```sh
cd packages/norns-core
bun test                 # preprocessor, vetted Civet/Pug subset + traps, error line mapping
```

Then smoke against a consumer: `cd ../../../norns-app && bun run check && bun run build` (the workspace symlinks the package; `norns dev` respawns on framework-source changes).

- `src/preprocess.js` is the whole package: `.n` default langs + auto-wrap, `+if` / `+elseif` / `+else` chains, `+snippet`, Pug class-shorthand rewriting, Civet script compilation, and the error mapping that turns Pug / Civet failures into `file:line:column` in the user's source. Keep the mapping tests in `tests/errors.test.js` green — agents open whatever line the message says.
- `tests/vetted-subset.test.js` pins the constructs apps rely on and the documented traps; extend it when you add syntax.
- Bump `version` in `packages/norns-core/package.json` when behaviour changes; `@human-synthesis/norns` pins the range. Publishing and pushing are user-gated.

## Upstream part of the repo

The rest of this file is the upstream Svelte guide, relevant only after an upstream merge (`git fetch upstream && git merge upstream/main`, then `vitest run`).

---

# Svelte Coding Agent Guide

This guide is for AI coding agents working in the Svelte monorepo.

**Important:** Read and follow [`CONTRIBUTING.md`](./CONTRIBUTING.md) as well - it contains essential information about testing, code structure, and contribution guidelines that applies here.

When submitting a PR, you **MUST** read [`PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) and fill it out correctly. **DO NOT** submit a PR without running the full test suite.

## Quick Reference

If asked to do a performance investigation, use the `performance-investigation` skill.
