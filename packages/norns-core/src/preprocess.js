import { sveltePreprocess } from 'svelte-preprocess';
import { compile as compileCivet } from '@danielx/civet';

export { transformIfChains, transformSnippets, rewritePugClasses };


const SCRIPT_TAG = /<script\b([^>]*)>/i;
const TEMPLATE_TAG = /<template\b([^>]*)>/i;

function hasLangAttr(attrs) {
	return /\blang\s*=/.test(attrs || '');
}

/**
 * For .norn files: inject lang="civet" / lang="pug" defaults on
 * <script> and <template> blocks, and auto-wrap any top-level non-script /
 * non-style content in <template lang="pug">.
 */
/**
 * If a .n file ends with an opening <script> or <style> tag but no matching
 * close before EOF, append the closing tag. Lets users skip the boilerplate
 * when the block is the very last thing in the file.
 */
function autoCloseTrailingBlock(content) {
	let out = content;
	for (const tag of ['script', 'style']) {
		const opens = (out.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) ?? []).length;
		const closes = (out.match(new RegExp(`</${tag}>`, 'gi')) ?? []).length;
		if (opens > closes) {
			out = out.replace(/\s*$/, `\n</${tag}>\n`);
		}
	}
	return out;
}

const IF_RE = /^(\s*)\+if\s*\((.+)\)\s*$/;
const ELSEIF_RE_TPL = (ind) => new RegExp(`^${escapeRegex(ind)}\\+elseif\\s*\\((.+)\\)\\s*$`);
const ELSE_RE_TPL = (ind) => new RegExp(`^${escapeRegex(ind)}\\+else\\s*$`);

// `+snippet('name')` or `+snippet('name', arg1, arg2)`. Lazy match with `$`
// anchor lets the args list contain parens (e.g. `+snippet('row', fn(a))`)
// because the engine extends the lazy capture only until the outer `)` lands
// at end-of-line.
const SNIPPET_RE = /^(\s*)\+snippet\s*\(\s*['"](\w+)['"](?:\s*,\s*([\s\S]+?))?\s*\)\s*$/;

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripQuotes(s) {
	s = s.trim();
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if ((first === "'" || first === '"') && first === last) return s.slice(1, -1);
	}
	return s;
}

function detectIndentDiff(lines, fromIdx, parentIndent) {
	for (let j = fromIdx; j < lines.length; j++) {
		const line = lines[j];
		if (line.trim() === '') continue;
		const m = line.match(/^(\s*)/);
		if (m && m[1].length > parentIndent.length) {
			return m[1].slice(parentIndent.length);
		}
		break;
	}
	return '\t';
}

/**
 * Find the position of the matching `)` for an `(` at `start`, respecting
 * nested parens and quoted strings.
 */
function findMatchingParen(str, start) {
	if (str[start] !== '(') return -1;
	let depth = 1;
	let inSingle = false;
	let inDouble = false;
	for (let i = start + 1; i < str.length; i++) {
		const c = str[i];
		if (inSingle) {
			if (c === "'" && str[i - 1] !== '\\') inSingle = false;
		} else if (inDouble) {
			if (c === '"' && str[i - 1] !== '\\') inDouble = false;
		} else {
			if (c === "'") inSingle = true;
			else if (c === '"') inDouble = true;
			else if (c === '(') depth++;
			else if (c === ')') {
				depth--;
				if (depth === 0) return i;
			}
		}
	}
	return -1;
}

const PUG_CLASS_SPECIAL = /[:.\/]/;

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
function rewritePugClasses(content) {
	const blockRanges = [];
	const blockRe = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
	let m;
	while ((m = blockRe.exec(content)) !== null) {
		blockRanges.push([m.index, m.index + m[0].length]);
	}

	const lines = content.split('\n');
	let offset = 0;
	const out = lines.map((line) => {
		const lineEnd = offset + line.length;
		const inBlock = blockRanges.some(([s, e]) => offset < e && lineEnd > s);
		const result = inBlock ? line : rewritePugLine(line);
		offset = lineEnd + 1; // +1 for the newline
		return result;
	});
	return out.join('\n');
}

function rewritePugLine(line) {
	const trimmed = line.trimStart();
	if (!trimmed) return line;
	const first = trimmed[0];
	if (first === '|' || first === '<') return line; // text emit / raw HTML
	if (trimmed.startsWith('//')) return line; // pug comment
	if (first === '+' || first === ':') return line; // mixin call / pug filter

	let i = 0;
	while (i < line.length && /\s/.test(line[i])) i++;
	const indent = line.slice(0, i);

	let tag = '';
	if (i < line.length && /[a-zA-Z]/.test(line[i])) {
		let j = i;
		while (j < line.length && /[\w-]/.test(line[j])) j++;
		tag = line.slice(i, j);
		i = j;
	}

	const segs = [];
	while (i < line.length && (line[i] === '.' || line[i] === '#')) {
		const sep = line[i];
		let j = i + 1;
		if (sep === '#') {
			while (j < line.length && /[\w-]/.test(line[j])) j++;
		} else {
			// class — extend chars to allow `/`, `:`, plus fractional `.\d+` suffixes
			while (j < line.length && /[\w/:-]/.test(line[j])) j++;
			while (j < line.length && line[j] === '.' && /\d/.test(line[j + 1] || '')) {
				j++;
				while (j < line.length && /\d/.test(line[j])) j++;
			}
		}
		if (j === i + 1) break; // empty token, abort
		segs.push(line.slice(i, j));
		i = j;
	}

	if (segs.length === 0) return line;

	let attrs = '';
	if (line[i] === '(') {
		const close = findMatchingParen(line, i);
		if (close !== -1) {
			attrs = line.slice(i, close + 1);
			i = close + 1;
		}
	}
	const rest = line.slice(i);

	const safe = [];
	const routed = [];
	for (const seg of segs) {
		if (seg[0] === '#') {
			safe.push(seg);
		} else {
			const cls = seg.slice(1);
			if (PUG_CLASS_SPECIAL.test(cls)) routed.push(cls);
			else safe.push(seg);
		}
	}

	if (routed.length === 0) return line;

	const newAttrs = mergeClassIntoAttrs(attrs, routed);
	return `${indent}${tag}${safe.join('')}${newAttrs}${rest}`;
}

function mergeClassIntoAttrs(attrsStr, classesToAdd) {
	const classStr = classesToAdd.join(' ');
	if (!attrsStr) return `(class="${classStr}")`;
	const inner = attrsStr.slice(1, -1);

	// Existing static `class="..."` → prepend our routed classes.
	const staticRe = /((?:^|\s)class\s*=\s*)"([^"]*)"/;
	if (staticRe.test(inner)) {
		return `(${inner.replace(staticRe, (_, prefix, val) => `${prefix}"${classStr} ${val}"`)})`;
	}
	// Existing dynamic `class!="{expr}"` → prepend static text. Svelte parses
	// the resulting `class="static {expr}"` as text + interpolation.
	const dynamicRe = /((?:^|\s)class\s*!=\s*)"([^"]*)"/;
	if (dynamicRe.test(inner)) {
		return `(${inner.replace(dynamicRe, (_, prefix, val) => `${prefix}"${classStr} ${val}"`)})`;
	}

	// No class= attribute exists — insert one.
	return `(class="${classStr}" ${inner})`;
}

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
function transformIfChains(content) {
	const lines = content.split('\n');
	const out = [];
	let i = 0;

	while (i < lines.length) {
		const m = lines[i].match(IF_RE);
		if (!m) {
			out.push(lines[i]);
			i++;
			continue;
		}

		const chainIndent = m[1];
		const ifExpr = stripQuotes(m[2]);
		const indentDiff = detectIndentDiff(lines, i + 1, chainIndent);
		const elseIfRe = ELSEIF_RE_TPL(chainIndent);
		const elseRe = ELSE_RE_TPL(chainIndent);

		out.push(`${chainIndent}| {#if ${ifExpr}}`);
		i++;

		while (i < lines.length) {
			const cur = lines[i];

			const eIfM = cur.match(elseIfRe);
			if (eIfM) {
				out.push(`${chainIndent}| {:else if ${stripQuotes(eIfM[1])}}`);
				i++;
				continue;
			}
			const eM = cur.match(elseRe);
			if (eM) {
				out.push(`${chainIndent}| {:else}`);
				i++;
				continue;
			}

			if (cur.trim() === '') {
				out.push(cur);
				i++;
				continue;
			}

			const lineIndent = cur.match(/^(\s*)/)[1];
			if (lineIndent.length > chainIndent.length) {
				// Body line — de-indent by one level so it sits at the chain's level.
				out.push(cur.startsWith(indentDiff) ? cur.slice(indentDiff.length) : cur);
				i++;
				continue;
			}

			break;
		}

		out.push(`${chainIndent}| {/if}`);
	}

	return out.join('\n');
}

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
function transformSnippets(content) {
	const lines = content.split('\n');
	const out = [];
	let i = 0;

	while (i < lines.length) {
		const m = lines[i].match(SNIPPET_RE);
		if (!m) {
			out.push(lines[i]);
			i++;
			continue;
		}

		const indent = m[1];
		const name = m[2];
		const args = m[3] ? m[3].trim() : '';
		const indentDiff = detectIndentDiff(lines, i + 1, indent);

		out.push(`${indent}| {#snippet ${name}(${args})}`);
		i++;

		// Collect body lines (more indented than the +snippet header) and
		// process them recursively so nested +snippet blocks resolve.
		/** @type {string[]} */
		const body = [];
		while (i < lines.length) {
			const cur = lines[i];

			if (cur.trim() === '') {
				body.push(cur);
				i++;
				continue;
			}

			const lineIndent = cur.match(/^(\s*)/)[1];
			if (lineIndent.length > indent.length) {
				body.push(cur.startsWith(indentDiff) ? cur.slice(indentDiff.length) : cur);
				i++;
				continue;
			}

			break;
		}

		if (body.length > 0) out.push(transformSnippets(body.join('\n')));
		out.push(`${indent}| {/snippet}`);
	}

	return out.join('\n');
}

function nornDefaultLangs() {
	return {
		name: 'norns-default-langs',
		markup({ content, filename }) {
			if (!filename || !filename.endsWith('.n')) return null;

			let out = autoCloseTrailingBlock(content);
			out = transformIfChains(out);
			out = transformSnippets(out);
			out = rewritePugClasses(out);

			// If no <template> exists, scan for script/style blocks and wrap the rest.
			if (!TEMPLATE_TAG.test(out)) {
				const blocks = [];
				const blockRe = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
				let m;
				while ((m = blockRe.exec(out)) !== null) {
					blocks.push({ start: m.index, end: m.index + m[0].length });
				}
				let outside = '';
				let pos = 0;
				for (const b of blocks) {
					outside += out.slice(pos, b.start);
					pos = b.end;
				}
				outside += out.slice(pos);

				if (outside.trim()) {
					let result = `<template lang="pug">\n${outside.trim()}\n</template>\n`;
					for (const b of blocks) {
						result += '\n' + out.slice(b.start, b.end);
					}
					out = result;
				}
			}

			// Inject lang="civet" on <script> tags missing lang=
			out = out.replace(SCRIPT_TAG, (full, attrs) =>
				hasLangAttr(attrs) ? full : `<script lang="civet"${attrs}>`
			);

			// Inject lang="pug" on <template> tags missing lang=
			out = out.replace(TEMPLATE_TAG, (full, attrs) =>
				hasLangAttr(attrs) ? full : `<template lang="pug"${attrs}>`
			);

			return { code: out };
		}
	};
}

/**
 * Compile `<script lang="civet">` blocks to JavaScript via Civet.
 *
 * Runs before svelte-preprocess so that downstream stages see plain JS.
 * Civet emits source maps; we forward them so devtools can resolve back to
 * the original `.civet` source.
 *
 * Civet's emit characteristics (verified May 2026, civet@0.11):
 *   - `count .= $state 0`           → `let count = $state(0)`
 *   - `count := $state 0`           → `const count = $state(0)`
 *   - `{ a, b = 0 } := $props()`    → `const { a, b = 0 } = $props()`
 *   - imports stay where written; if user writes them at top, output is fine
 */
function nornsCivetScript() {
	return {
		name: 'norns-civet-script',
		async script({ content, attributes, filename }) {
			if (attributes.lang !== 'civet' && attributes.lang !== 'cv') return null;
			const result = await compileCivet(content, {
				js: true,
				sourceMap: true,
				filename: filename ?? 'unknown'
			});
			// Drop the `lang` attribute so svelte-preprocess doesn't try to load
			// a `./transformers/civet` module — at this point the script body is
			// already plain JS, no further script-level transform needed.
			const { lang: _drop, ...nextAttrs } = attributes;
			return {
				code: result.code,
				map: result.sourceMap?.json?.(filename ?? 'unknown') ?? null,
				attributes: nextAttrs
			};
		}
	};
}


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
export function nornsPreprocess(options = {}) {
	return [
		nornDefaultLangs(),
		nornsCivetScript(),
		sveltePreprocess({
			pug: {},
			typescript: {
				compilerOptions: {
					// Silence TS 6.x's deprecation warning for older moduleResolution
					// values (node10) that some toolchains still default to.
					ignoreDeprecations: '6.0',
					// Preserve value imports (Svelte component imports look "unused"
					// to the TS transpiler since their usage lives in the template,
					// but they MUST be emitted). verbatimModuleSyntax keeps any
					// non-`import type` imports verbatim.
					verbatimModuleSyntax: true,
					isolatedModules: true
				}
			},
			...options
		})
	];
}
