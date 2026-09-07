/**
 * Norns preprocessor stack.
 *
 * - `.norn` files default `<script>` to Civet and `<template>` to Pug (and
 *   auto-wrap top-level content in `<template lang="pug">` if no template
 *   block is present).
 * - `<script lang="civet">` blocks are compiled to JS via @danielx/civet
 *   before svelte-preprocess sees them. Civet emits ESM-correct
 *   `let count = $state(0)` directly, so no rune-fusion or import-lift
 *   passes are needed.
 *
 * @param {import('svelte-preprocess').AutoPreprocessOptions} [options]
 */
export function nornsPreprocess(options?: import("svelte-preprocess").AutoPreprocessOptions): any[];
/**
 * Rewrite Pug `+if('expr') / +elseif('expr') / +else` chains to raw Svelte
 * block syntax emitted via Pug `|` text. Bypasses svelte-preprocess's `+if`
 * mixin (which doesn't support chaining).
 *
 * Input:
 *   +if('a')
 *     div one
 *   +elseif('b')
 *     div two
 *   +else
 *     div three
 *
 * Output:
 *   | {#if a}
 *   div one
 *   | {:else if b}
 *   div two
 *   | {:else}
 *   div three
 *   | {/if}
 */
export function transformIfChains(content: any): any;
/**
 * Rewrite Pug `+snippet('name', args…)` blocks to Svelte 5 `{#snippet name(args)}`
 * via Pug `|` text emit. Recurses into the body so nested snippets work
 * (`Tabs > +snippet('item', tab) > Card > +snippet('header')`).
 *
 * Input:
 *   +snippet('header')
 *     h2 Title
 *
 *   +snippet('row', user, idx)
 *     .row Hello {user.name} {idx}
 *
 * Output:
 *   | {#snippet header()}
 *   h2 Title
 *   | {/snippet}
 *
 *   | {#snippet row(user, idx)}
 *   .row Hello {user.name} {idx}
 *   | {/snippet}
 */
export function transformSnippets(content: any): any;
/**
 * Rewrite Pug element lines whose class shorthand contains characters Pug's
 * lexer rejects (`:`, `/`) or that Pug already mis-parses (fractional `.\d+`
 * continuations like `.gap-2.5`). Route those classes from shorthand into the
 * `(class="...")` attribute. Pug then sees only safe class shorthand.
 *
 * Examples:
 *   `.text-blue.hover:bg-red(href="/")`
 *     → `.text-blue(class="hover:bg-red" href="/")`
 *   `.gap-2.5.flex`
 *     → `.flex(class="gap-2.5")`
 *   `.bg-white/40.text-4xl(class="static")`
 *     → `.text-4xl(class="bg-white/40 static")`
 *
 * Skips lines inside `<script>` / `<style>` blocks.
 */
export function rewritePugClasses(content: any): any;
/**
 * Walk `content` and return the set of Pug class-shorthand names found in
 * element class chains (`.foo.bar-baz.hover:bg-red`) plus the value of any
 * `class="..."` attribute on the same lines.
 *
 * Tailwind v4's content scanner extracts utility candidates from string
 * contexts (`class="…"`, JS strings) but doesn't recognise Pug's chained
 * shorthand — the dotted chain looks like one token. Pages render with the
 * class names present in the markup but no matching CSS, which is silent
 * and hard to spot. The companion `nornsTailwindPlugin()` Vite plugin in
 * `@human-synthesis/norns` calls this and feeds the union into Tailwind via
 * an injected `@source inline(...)` directive.
 *
 * Skips lines inside `<script>` / `<style>` blocks. Skips lines that begin
 * with `|`, `<`, `+`, `:`, or `//` (Pug text emits, raw HTML, mixin calls,
 * pug filters, and comments). For each remaining line, reads an optional
 * tag, then chained `.<class>` segments (handling `:`, `/`, and fractional
 * `.\d+` continuations), then collects the value of any `class="…"` or
 * `class!="…"` attribute that follows.
 *
 * Pure function — does not mutate `content`. Returns a `Set<string>` so
 * callers can union across many files without dedup work.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractPugClasses(content: string): Set<string>;
