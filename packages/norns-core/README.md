# @human-synthesis/norns-core

Svelte with CoffeeScript, Pug, and UnoCSS preconfigured.

## Install

```sh
pnpm add -D @human-synthesis/norns-core svelte unocss vite
```

## Usage

`svelte.config.js`:

```js
import { nornsPreprocess } from '@human-synthesis/norns-core/preprocess';

export default {
  preprocess: nornsPreprocess()
};
```

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nornsUno } from '@human-synthesis/norns-core/uno';

export default defineConfig({
  plugins: [nornsUno(), svelte()]
});
```

## Writing components

```svelte
<template lang="pug">
  h1.text-3xl.font-bold Hello {name}
  button(on:click="{increment}") count is {count}
</template>

<script lang="coffee">
  export let name = 'world'
  count = 0
  increment = -> count++
</script>
```

## Why this exists

Norns wraps Svelte with the language and styling defaults we like:

- **CoffeeScript** in `<script lang="coffee">` blocks
- **Pug** in `<template lang="pug">` blocks
- **UnoCSS** with `presetUno`, `presetAttributify`, `presetIcons`, `presetTypography` enabled

The wrapper is intentionally thin — under the hood it's just `svelte-preprocess` and `unocss/vite` with reasonable defaults. Override anything by passing options.

## License & attribution

MIT © Human Synthesis. Built on top of [Svelte](https://github.com/sveltejs/svelte) © Svelte Contributors, MIT licensed.
