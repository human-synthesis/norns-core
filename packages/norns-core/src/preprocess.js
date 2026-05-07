import { sveltePreprocess } from 'svelte-preprocess';
import { parse } from 'acorn';
import MagicString from 'magic-string';

const RUNES = new Set([
	'$state',
	'$state.raw',
	'$derived',
	'$derived.by',
	'$effect',
	'$effect.pre',
	'$effect.root',
	'$props',
	'$bindable'
]);

function isRuneCall(node) {
	if (!node || node.type !== 'CallExpression') return false;
	const c = node.callee;
	if (c.type === 'Identifier') return RUNES.has(c.name);
	if (c.type === 'MemberExpression' && c.object.type === 'Identifier') {
		return RUNES.has(`${c.object.name}.${c.property.name}`);
	}
	return false;
}

/**
 * Fuse `var X; X = expr` patterns (CoffeeScript output) into `let X = expr`,
 * so Svelte 5 accepts runes in declaration position and doesn't warn about
 * non-state variables being "updated".
 *
 * Also handles `var X; ({X, ...} = $props())` (destructured props).
 *
 * Walks function bodies recursively so closures get the same treatment.
 */
export { transformIfChains, rewritePugClasses };

export function fuseRuneDeclarations(code) {
	let ast;
	try {
		ast = parse(code, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			allowReturnOutsideFunction: true,
			allowAwaitOutsideFunction: true
		});
	} catch {
		return code;
	}

	const s = new MagicString(code);
	walkBody(ast.body);

	function walkBody(body) {
		const fused = new Set();
		const varStmts = [];
		const claimed = new Set();

		for (let i = 0; i < body.length; i++) {
			const stmt = body[i];

			if (stmt.type === 'VariableDeclaration' && stmt.kind === 'var') {
				varStmts.push(stmt);
				continue;
			}
			if (stmt.type !== 'ExpressionStatement') continue;
			const e = stmt.expression;

			// Pattern: X = expr  (where X is var-declared earlier in this scope).
			// We fuse to `let X = expr` for any expression. Coffee always emits
			// `var X; X = ...` for top-level assignments, and Svelte 5 reports
			// `non_reactive_update` warnings for any `var` that's reassigned —
			// even if the user only wrote a single function declaration. We
			// limit to TOP LEVEL only (no recursion into nested function bodies)
			// to avoid MagicString chunk conflicts.
			//
			// Special-case: `$derived(IIFE())` — Coffee compiles `$derived do ->`
			// to `$derived((function(){...})())`, which evaluates ONCE at
			// definition time instead of reactively. Rewrite to `$derived.by(fn)`.
			if (
				e.type === 'AssignmentExpression' &&
				e.operator === '=' &&
				e.left.type === 'Identifier' &&
				isVarDeclared(varStmts, e.left.name) &&
				!claimed.has(e.left.name)
			) {
				claimed.add(e.left.name);
				fused.add(e.left.name);

				const rewrite = rewriteDerivedIIFE(e.right, code);
				if (rewrite) {
					s.overwrite(
						stmt.start,
						stmt.end,
						`let ${e.left.name} = $derived.by(${rewrite});`
					);
				} else {
					s.appendLeft(stmt.start, 'let ');
				}
				continue;
			}

			// Pattern: ({X, Y} = $props())  →  let {X, Y} = $props()
			if (
				e.type === 'AssignmentExpression' &&
				e.operator === '=' &&
				e.left.type === 'ObjectPattern' &&
				isRuneCall(e.right)
			) {
				const names = collectPatternNames(e.left);
				if (names.every((n) => isVarDeclared(varStmts, n) && !claimed.has(n))) {
					for (const n of names) {
						claimed.add(n);
						fused.add(n);
					}
					const lhs = code.slice(e.left.start, e.left.end);
					const rhs = code.slice(e.right.start, e.right.end);
					s.overwrite(stmt.start, stmt.end, `let ${lhs} = ${rhs};`);
				}
			}
		}

		for (const stmt of varStmts) {
			const remaining = stmt.declarations.filter(
				(d) => !(d.id.type === 'Identifier' && fused.has(d.id.name))
			);
			if (remaining.length === 0) {
				s.remove(stmt.start, stmt.end);
			} else if (remaining.length < stmt.declarations.length) {
				const rebuilt = remaining
					.map((d) =>
						d.init ? `${d.id.name} = ${code.slice(d.init.start, d.init.end)}` : d.id.name
					)
					.join(', ');
				s.overwrite(stmt.start, stmt.end, `var ${rebuilt};`);
			}
		}

		// Note: we deliberately do NOT recurse into nested function bodies.
		// Svelte runes ($state, $derived, etc.) only apply at component
		// top-level. Inner function bodies (event handlers, callbacks) have
		// `var X; X = ...` patterns from CoffeeScript output too, but they
		// don't trigger Svelte warnings and don't need fusion. Recursing
		// also creates MagicString chunk conflicts when an outer assignment
		// is being modified at the same time as something inside its body.
	}

	function isVarDeclared(varStmts, name) {
		for (const stmt of varStmts) {
			for (const d of stmt.declarations) {
				if (d.id.type === 'Identifier' && d.id.name === name && !d.init) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * If `node` is `$derived((function(){...})())` (the result of Coffee's
	 * `$derived do ->`), return the source text of the inner FunctionExpression
	 * so the caller can rewrite to `$derived.by(<fn>)`. Otherwise null.
	 */
	function rewriteDerivedIIFE(node, src) {
		if (!node || node.type !== 'CallExpression') return null;
		if (node.callee.type !== 'Identifier' || node.callee.name !== '$derived') return null;
		if (node.arguments.length !== 1) return null;
		const arg = node.arguments[0];
		if (arg.type !== 'CallExpression') return null;
		if (arg.arguments.length !== 0) return null;
		const fn = arg.callee;
		if (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') return null;
		return src.slice(fn.start, fn.end);
	}

	function collectPatternNames(pat) {
		const names = [];
		if (pat.type === 'ObjectPattern') {
			for (const prop of pat.properties) {
				if (prop.type === 'Property') {
					let v = prop.value;
					// Unwrap default value: `{ x = 1 }` has Property → AssignmentPattern → Identifier
					if (v.type === 'AssignmentPattern') v = v.left;
					if (v.type === 'Identifier') names.push(v.name);
				} else if (prop.type === 'RestElement' && prop.argument.type === 'Identifier') {
					names.push(prop.argument.name);
				}
			}
		}
		return names;
	}

	return s.toString();
}

const SCRIPT_TAG = /<script\b([^>]*)>/i;
const TEMPLATE_TAG = /<template\b([^>]*)>/i;

function hasLangAttr(attrs) {
	return /\blang\s*=/.test(attrs || '');
}

/**
 * For .norn files: inject lang="coffee" / lang="pug" defaults on
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

function nornDefaultLangs() {
	return {
		name: 'norns-default-langs',
		markup({ content, filename }) {
			if (!filename || !filename.endsWith('.n')) return null;

			let out = autoCloseTrailingBlock(content);
			out = transformIfChains(out);
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

			// Inject lang="coffee" on <script> tags missing lang=
			out = out.replace(SCRIPT_TAG, (full, attrs) =>
				hasLangAttr(attrs) ? full : `<script lang="coffee"${attrs}>`
			);

			// Inject lang="pug" on <template> tags missing lang=
			out = out.replace(TEMPLATE_TAG, (full, attrs) =>
				hasLangAttr(attrs) ? full : `<template lang="pug"${attrs}>`
			);

			return { code: out };
		}
	};
}

function nornCoffeeRuneFusion() {
	return {
		name: 'norns-coffee-rune-fusion',
		script({ content, attributes }) {
			if (attributes.lang !== 'coffee' && attributes.lang !== 'coffeescript') return null;
			const code = fuseRuneDeclarations(content);
			return code === content ? null : { code };
		}
	};
}

/**
 * Lift `import` statements to the top of a JS module.
 *
 * CoffeeScript 2 hoists all variables to a single `var x, y, z;` line at the
 * very top of the file, then emits `import` statements *after* it. JS modules
 * require imports above all other top-level statements, and svelte-preprocess
 * + Svelte's MagicString-based pipeline don't handle this gracefully when
 * there are also nested var/assignment patterns inside script function bodies.
 *
 * This pass parses the JS, finds all `ImportDeclaration` nodes, and rewrites
 * them in source order at the very top of the module.
 */
export function liftImports(code) {
	let ast;
	try {
		ast = parse(code, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			allowReturnOutsideFunction: true,
			allowAwaitOutsideFunction: true
		});
	} catch {
		return code;
	}

	const imports = ast.body.filter((s) => s.type === 'ImportDeclaration');
	if (imports.length === 0) return code;

	const firstNonImportIdx = ast.body.findIndex((s) => s.type !== 'ImportDeclaration');
	if (firstNonImportIdx === -1) return code; // already all imports

	const lateImports = imports.filter((i) => ast.body.indexOf(i) > firstNonImportIdx);
	if (lateImports.length === 0) return code; // already in the right order

	const s = new MagicString(code);
	const importTexts = imports.map((i) => code.slice(i.start, i.end));
	for (const i of imports) {
		s.remove(i.start, i.end);
	}
	s.prependLeft(0, importTexts.join('\n') + '\n');
	return s.toString();
}

function nornsCoffeeImportLift() {
	return {
		name: 'norns-coffee-import-lift',
		script({ content, attributes }) {
			if (attributes.lang !== 'coffee' && attributes.lang !== 'coffeescript') return null;
			const code = liftImports(content);
			return code === content ? null : { code };
		}
	};
}

/**
 * Norns preprocessor stack.
 *
 * - `.norn` files default `<script>` to CoffeeScript and `<template>` to Pug
 *   (and auto-wrap top-level content in `<template lang="pug">` if no
 *   template block is present).
 * - CoffeeScript output is post-processed: `var X; X = expr` patterns become
 *   `let X = expr` so Svelte 5 runes work without backtick-embedded JS and
 *   normal variables/functions don't trigger non-reactive warnings.
 *
 * @param {import('svelte-preprocess').AutoPreprocessOptions} [options]
 */
export function nornsPreprocess(options = {}) {
	return [
		nornDefaultLangs(),
		sveltePreprocess({
			coffeescript: { bare: true },
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
		}),
		nornsCoffeeImportLift(),
		nornCoffeeRuneFusion()
	];
}
