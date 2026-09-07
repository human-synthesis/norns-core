import { sveltePreprocess } from 'svelte-preprocess';
import { compile as compileCivet } from '@danielx/civet';

export { transformIfChains, transformSnippets, rewritePugClasses, extractPugClasses };

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

/* === Error mapping ===========================================================
 *
 * svelte-preprocess renders Pug with a ~50-line mixin prelude prepended, so
 * raw Pug errors point ~50 lines past the real one; on top of that, `.n`
 * files are re-arranged (template first, +if/+snippet rewritten) before Pug
 * sees them. Civet errors inside `<script>` blocks are relative to the
 * block, not the file. Both are mapped back to `file:line:column` in the
 * source the user actually wrote, so an agent (or a human) opens the right
 * line on the first try.
 */

/** Original file contents, keyed by filename, stashed by nornDefaultLangs. */
const ORIGINAL_SOURCES = new Map();
const FALLBACK_PUG_PRELUDE = 52;

function rememberSource(filename, content) {
	if (!filename) return;
	if (ORIGINAL_SOURCES.size > 2000) ORIGINAL_SOURCES.clear();
	ORIGINAL_SOURCES.set(filename, content);
}

/** Parse Pug's numbered code frame out of an error message. */
function parsePugFrame(message) {
	const frame = [];
	let marked = null;
	for (const line of String(message).split('\n')) {
		const m = line.match(/^\s*(>)?\s*(\d+)\|(.*)$/);
		if (!m) continue;
		const n = Number(m[2]);
		frame.push({ n, text: m[3].replace(/^ /, ''), marked: !!m[1] });
		if (m[1]) marked = n;
	}
	return { frame, marked };
}

/** The human-readable core of a Pug error (last non-frame, non-location line). */
function pugMessageCore(message) {
	const lines = String(message).split('\n');
	let core = '';
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (/^\[svelte-preprocess\]/.test(line)) continue;
		if (/^>?\s*\d+\|/.test(line)) continue;
		if (/^-+\^?$/.test(line)) continue;
		if (/^\S+:\d+:\d+$/.test(line)) continue;
		core = line;
	}
	return core || 'Pug error';
}

function extractTemplate(content) {
	const m = content.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
	return m ? m[1] : content;
}

/**
 * Reverse the `.n` rewrites for one template line so it can be looked up in
 * the original source: `| {#if x}` came from `+if('x')`, etc.
 */
function sourceVariants(text) {
	const t = text.trim();
	const out = [text, t];
	let m;
	if ((m = t.match(/^\|\s*\{#if (.+)\}$/))) out.push(`+if('${m[1]}')`, `+if("${m[1]}")`);
	else if ((m = t.match(/^\|\s*\{:else if (.+)\}$/)))
		out.push(`+elseif('${m[1]}')`, `+elseif("${m[1]}")`);
	else if (/^\|\s*\{:else\}$/.test(t)) out.push('+else');
	else if ((m = t.match(/^\|\s*\{#snippet (\w+)\((.*)\)\}$/))) {
		out.push(m[2] ? `+snippet('${m[1]}', ${m[2]})` : `+snippet('${m[1]}')`);
	}
	return out;
}

/**
 * Find the original line for a (possibly rewritten) template line.
 *
 * @returns {{ line: number, exact: boolean }}
 */
function findOriginalLine(text, origLines, approx) {
	const trimmed = text.trim();
	const clamp = (n) => Math.min(Math.max(1, n), Math.max(1, origLines.length));
	if (!trimmed) return { line: clamp(approx), exact: false };

	const nearest = (idxs) =>
		idxs.reduce(
			(best, j) => (Math.abs(j + 1 - approx) < Math.abs(best + 1 - approx) ? j : best),
			idxs[0]
		);

	for (const variant of sourceVariants(text)) {
		const v = variant.trim();
		if (!v) continue;
		const hits = [];
		for (let j = 0; j < origLines.length; j++) {
			if (origLines[j] === variant || origLines[j].trim() === v) hits.push(j);
		}
		if (hits.length === 1) return { line: hits[0] + 1, exact: true };
		if (hits.length > 1) return { line: nearest(hits) + 1, exact: true };
	}

	// Class-shorthand rewrites move classes into `(class="...")`; fall back to
	// the tag/leading-class prefix.
	const prefix = trimmed.match(/^[\w.#-]+/)?.[0];
	if (prefix && prefix.length >= 3) {
		const hits = [];
		for (let j = 0; j < origLines.length; j++) {
			if (origLines[j].trim().startsWith(prefix)) hits.push(j);
		}
		if (hits.length > 0) return { line: nearest(hits) + 1, exact: false };
	}
	return { line: clamp(approx), exact: false };
}

function frameOf(lines, line, column) {
	const from = Math.max(1, line - 2);
	const to = Math.min(lines.length, line + 1);
	const width = String(to).length;
	const out = [];
	for (let n = from; n <= to; n++) {
		out.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)}| ${lines[n - 1] ?? ''}`);
		if (n === line && column)
			out.push(`  ${' '.repeat(width)}| ${' '.repeat(Math.max(0, column - 1))}^`);
	}
	return out.join('\n');
}

/**
 * Turn a raw svelte-preprocess Pug error into one that points at the
 * source file. Non-Pug errors pass through untouched.
 */
function mapPugError(e, content, filename) {
	if (!e || typeof e.message !== 'string') return e;
	if (!/Pug error|pug/i.test(e.message) && typeof e.line !== 'number') return e;

	const { frame, marked } = parsePugFrame(e.message);
	const pugLine = typeof e.line === 'number' ? e.line : marked;
	if (!pugLine) return e;

	const tplLines = extractTemplate(content).split('\n');

	// Vote for the prelude offset using every frame line we can find verbatim
	// in the template we handed to Pug.
	const votes = new Map();
	for (const f of frame) {
		if (!f.text.trim()) continue;
		for (let j = 0; j < tplLines.length; j++) {
			if (tplLines[j] === f.text) {
				const off = f.n - (j + 1);
				votes.set(off, (votes.get(off) ?? 0) + 1);
			}
		}
	}
	let offset = FALLBACK_PUG_PRELUDE;
	let best = 0;
	for (const [off, n] of votes) {
		if (n > best) {
			best = n;
			offset = off;
		}
	}

	const tplLine = pugLine - offset;
	const text = tplLines[tplLine - 1] ?? '';

	const original = (filename && ORIGINAL_SOURCES.get(filename)) ?? content;
	const origLines = original.split('\n');
	const tplStart = Math.max(
		0,
		origLines.findIndex((l) => /<template\b/i.test(l))
	);
	const { line, exact } = findOriginalLine(text, origLines, tplLine + tplStart);
	const column = typeof e.column === 'number' && e.column > 0 ? e.column : null;

	const core = pugMessageCore(e.message);
	const name = filename ? filename.split(/[\\/]/).pop() : 'template';
	const frameText = frameOf(origLines, line, column);
	const err = new Error(
		`${name}:${line}:${column ?? 1}: Pug: ${core}${exact ? '' : ' (approximate line)'}\n\n${frameText}`
	);
	err.name = 'PugError';
	err.code = 'norns_pug_error';
	err.line = line;
	err.column = column;
	err.filename = filename;
	err.frame = frameText;
	err.approximate = !exact;
	err.pugLine = pugLine;
	err.cause = e;
	return err;
}

/**
 * Map a Civet ParseError thrown for a `<script>` block back to the line in
 * the containing file.
 */
function mapCivetScriptError(e, content, filename) {
	if (!e || typeof e.line !== 'number') return e;
	const original = filename && ORIGINAL_SOURCES.get(filename);
	if (!original) return e;

	const blockRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
	let m;
	let bodyStart = -1;
	let firstBodyStart = -1;
	while ((m = blockRe.exec(original)) !== null) {
		const start = m.index + m[0].indexOf('>') + 1;
		if (firstBodyStart < 0) firstBodyStart = start;
		if (m[1] === content) {
			bodyStart = start;
			break;
		}
	}
	if (bodyStart < 0) bodyStart = firstBodyStart;
	if (bodyStart < 0) return e;

	const bodyStartLine = original.slice(0, bodyStart).split('\n').length;
	const line = bodyStartLine + e.line - 1;
	const column = typeof e.column === 'number' ? e.column : null;
	const origLines = original.split('\n');
	const name = filename.split(/[\\/]/).pop();
	const rest = String(e.message).split('\n');
	const head = rest.shift() ?? '';
	const core = head.replace(/^\S+:\d+:\d+\s*/, '');
	const frameText = frameOf(origLines, line, column);
	e.message = [`${name}:${line}:${column ?? 1}: Civet: ${core}`, ...rest, '', frameText].join('\n');
	e.line = line;
	e.column = column;
	e.filename = filename;
	e.frame = frameText;
	e.code = 'norns_civet_error';
	return e;
}

/**
 * Wrap svelte-preprocess so Pug failures come back mapped to the source.
 */
function withMappedPugErrors(sp) {
	return {
		...sp,
		name: sp.name ?? 'norns-svelte-preprocess',
		markup: sp.markup
			? async (args) => {
					try {
						return await sp.markup(args);
					} catch (e) {
						throw mapPugError(e, args.content, args.filename);
					}
				}
			: undefined
	};
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
function extractPugClasses(content) {
	const out = new Set();
	if (typeof content !== 'string' || content.length === 0) return out;

	const blockRanges = [];
	const blockRe = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
	let m;
	while ((m = blockRe.exec(content)) !== null) {
		blockRanges.push([m.index, m.index + m[0].length]);
	}

	const lines = content.split('\n');
	let offset = 0;
	for (const line of lines) {
		const lineEnd = offset + line.length;
		const inBlock = blockRanges.some(([s, e]) => offset < e && lineEnd > s);
		if (!inBlock) collectFromPugLine(line, out);
		offset = lineEnd + 1; // +1 for the newline
	}
	return out;
}

function collectFromPugLine(line, into) {
	const trimmed = line.trimStart();
	if (!trimmed) return;
	const first = trimmed[0];
	if (first === '|' || first === '<') return;
	if (trimmed.startsWith('//')) return;
	if (first === '+' || first === ':') return;

	let i = 0;
	while (i < line.length && /\s/.test(line[i])) i++;

	// Optional element tag.
	if (i < line.length && /[a-zA-Z]/.test(line[i])) {
		let j = i;
		while (j < line.length && /[\w-]/.test(line[j])) j++;
		i = j;
	}

	// `.class` / `#id` segments. Mirrors `rewritePugLine` so the two stay
	// in sync — both must accept the same chained-shorthand grammar.
	while (i < line.length && (line[i] === '.' || line[i] === '#')) {
		const sep = line[i];
		let j = i + 1;
		if (sep === '#') {
			while (j < line.length && /[\w-]/.test(line[j])) j++;
		} else {
			while (j < line.length && /[\w/:-]/.test(line[j])) j++;
			while (j < line.length && line[j] === '.' && /\d/.test(line[j + 1] || '')) {
				j++;
				while (j < line.length && /\d/.test(line[j])) j++;
			}
		}
		if (j === i + 1) break;
		if (sep === '.') into.add(line.slice(i + 1, j));
		i = j;
	}

	// `(attrs)` block — pull class="..." and class!="..." values too. Pug
	// chained shorthand often coexists with a `(class="...")` attribute on
	// the same line (especially after `rewritePugClasses` routes special
	// chars there). Capturing both lets a single pass cover the full set.
	if (line[i] === '(') {
		const close = findMatchingParen(line, i);
		if (close !== -1) {
			const attrs = line.slice(i + 1, close);
			const re = /(?:^|\s)class\s*!?=\s*"([^"]*)"/g;
			let am;
			while ((am = re.exec(attrs)) !== null) {
				for (const tok of am[1].split(/\s+/)) {
					if (tok) into.add(tok);
				}
			}
		}
	}
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

		// Collect each branch's header + body, then recurse on the body so
		// nested `+if`/`+else` chains resolve. Mirrors `transformSnippets`.
		/** @type {{ header: string; body: string[] }[]} */
		const branches = [{ header: `${chainIndent}| {#if ${ifExpr}}`, body: [] }];
		i++;

		while (i < lines.length) {
			const cur = lines[i];

			const eIfM = cur.match(elseIfRe);
			if (eIfM) {
				branches.push({
					header: `${chainIndent}| {:else if ${stripQuotes(eIfM[1])}}`,
					body: []
				});
				i++;
				continue;
			}
			const eM = cur.match(elseRe);
			if (eM) {
				branches.push({ header: `${chainIndent}| {:else}`, body: [] });
				i++;
				continue;
			}

			if (cur.trim() === '') {
				branches[branches.length - 1].body.push(cur);
				i++;
				continue;
			}

			const lineIndent = cur.match(/^(\s*)/)[1];
			if (lineIndent.length > chainIndent.length) {
				// Body line — de-indent by one level so it sits at the chain's level.
				const deindented = cur.startsWith(indentDiff) ? cur.slice(indentDiff.length) : cur;
				branches[branches.length - 1].body.push(deindented);
				i++;
				continue;
			}

			break;
		}

		for (const b of branches) {
			out.push(b.header);
			if (b.body.length > 0) out.push(transformIfChains(b.body.join('\n')));
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
			rememberSource(filename, content);

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
			let result;
			try {
				result = await compileCivet(content, {
					js: true,
					sourceMap: true,
					filename: filename ?? 'unknown'
				});
			} catch (e) {
				throw mapCivetScriptError(e, content, filename);
			}
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
		withMappedPugErrors(
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
		)
	];
}
