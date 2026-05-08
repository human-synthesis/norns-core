# Norns Core

**AI-driven software architecture and development framework, based on Svelte.**

Svelte preprocessor for the Norns stack: **Pug + Civet** in `.n` files. The `.c` extension is recognised as an alias for `.civet` — both compile through Civet. CoffeeScript is no longer supported.

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
- Top-level Pug-only content is auto-wrapped in `<template lang="pug">` so you don't need the wrapper boilerplate.
- Pug class shorthand is rewritten so Tailwind variants (`.hover:bg-X`) and fractional values (`.gap-2.5`) work without escaping.
- `+if` / `+elseif` / `+else` chains are rewritten to Svelte block syntax (`{#if}/{:else if}/{:else}/{/if}`).

## License

MIT © Daniel Teodoroiu / [Human Synthesis](https://humansynthesis.ai). Built on top of [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
