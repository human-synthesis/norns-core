# Norns Core

**AI-driven software architecture and development framework, based on Svelte.**

Svelte preprocessor for the Norns stack: Pug + CoffeeScript in `.n` files, with the small set of fixes needed to make Svelte 5 runes feel native in Coffee.

## Stack

- [Svelte 5](https://svelte.dev) — components and runes
- [Pug](https://pugjs.org) — templates
- [CoffeeScript 2](https://coffeescript.org) — script
- [Vite](https://vitejs.dev) — bundler
- [bun](https://bun.sh) — runtime / package manager

## Install

```sh
bun add -D @human-synthesis/norns-core svelte
```

Most users want the umbrella package [`@human-synthesis/norns`](https://github.com/human-synthesis/norns) instead.

## Usage

`svelte.config.js`:

```js
import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';

export default {
  extensions: ['.svelte', '.n'],
  preprocess: nornsPreprocess()
};
```

## License

MIT © Daniel Teodoroiu / [Human Synthesis](https://humansynthesis.ai). Built on top of [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
