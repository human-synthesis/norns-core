# Norns Core

**AI-driven software architecture and development framework, based on Svelte.**

Svelte preprocessor for the Norns stack: **Pug + Civet** in `.n` files. The `.c` extension is recognised as an alias for `.civet` — both compile through Civet.

## Stack

- [Svelte 5](https://svelte.dev) — components and runes
- [Pug](https://pugjs.org) — templates
- [Civet](https://civet.dev) — script (TypeScript-flavored, indented)
- [Vite](https://vitejs.dev) — bundler
- [bun](https://bun.sh) — runtime / package manager

## Install

```sh
bun add -D @human-synthesis/norns-core svelte
```

Most users want the umbrella package [`@human-synthesis/norns`](https://github.com/human-synthesis/norns) instead — it adds the SvelteKit config, the Vite plugin, and the runtime layer.

## Usage

`svelte.config.js`:

```js
import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';

export default {
  extensions: ['.svelte', '.n'],
  preprocess: nornsPreprocess()
};
```

## What it does

- `.n` files default `<script>` to `lang="civet"` and `<template>` to `lang="pug"` — write neither attribute and it just works.
- `<script lang="civet">` blocks are compiled to JavaScript via [@danielx/civet](https://civet.dev) before svelte-preprocess sees them.
- Top-level Pug-only content is auto-wrapped in `<template lang="pug">` so you don't need the wrapper boilerplate; a trailing `<script>` block may omit its closing tag.
- Pug class shorthand is rewritten so Tailwind variants (`.hover:bg-X`), fractional values (`.gap-2.5`) and slashes (`.bg-white/40`) work without escaping.
- `+if` / `+elseif` / `+else` chains are rewritten to Svelte block syntax (`{#if}/{:else if}/{:else}/{/if}`), and `+snippet('name', args)` blocks to `{#snippet name(args)}`.
- Pug and Civet errors are reported as `file:line:column` **in the `.n` file you wrote**, with a code frame — not against svelte-preprocess's ~50-line mixin prelude or the script block's own numbering.

## Template syntax

| Write | Becomes |
|---|---|
| `+if('cond')` … `+elseif('other')` … `+else` | `{#if cond}` … `{:else if other}` … `{:else}` … `{/if}` |
| `+each('items as item (item.id)')` | `{#each items as item (item.id)}` … `{/each}` — the Svelte `as` form; `item of items` is **not** valid |
| `+snippet('row', user, idx)` | `{#snippet row(user, idx)}` … `{/snippet}` |
| `\| {@render row(u, i)}` / `\| {@html raw}` | passed through as text — any line starting with `{` needs the `\| ` prefix |
| `attr!="{expr}"` | `attr={expr}` (Svelte expression); plain `attr="text"` stays a string |
| `.flex.items-center.gap-2.5(class="hover:bg-x")` | `class="flex items-center gap-2.5 hover:bg-x"` |
| `+key('expr')`, `+await('p')` / `+then('v')` / `+catch('e')` | the matching Svelte blocks (svelte-preprocess mixins) |

The `<script>` block is Civet by default (`lang="ts"` / `lang="js"` opt out): `{ a, b = 1 } := $props()`, `count .= $state 0` (use `.=` for anything you reassign), `total := $derived a + b`, `$effect => …`.

## Auto-imports — see the umbrella

The auto-import layer (helpers, components, project utilities, UI library presets) lives in [`@human-synthesis/norns`](https://github.com/human-synthesis/norns), not here. `norns-core` is the syntax preprocessor only — the import resolver needs Vite-plugin hooks the umbrella provides.

## License

MIT © Daniel Teodoroiu / [Human Synthesis](https://humansynthesis.ai). Built on top of [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
