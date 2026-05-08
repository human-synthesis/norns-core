import { describe, expect, test } from 'bun:test';
import { transformIfChains, rewritePugClasses } from '../src/preprocess.js';

describe('transformIfChains', () => {
	test('single +if becomes {#if}/{/if}', () => {
		const input = `+if('cond')\n\tdiv content`;
		const out = transformIfChains(input);
		expect(out).toContain('| {#if cond}');
		expect(out).toContain('| {/if}');
		expect(out).toContain('div content');
	});

	test('+if + +else (two branches)', () => {
		const input = `+if('a')\n\tdiv yes\n+else\n\tdiv no`;
		const out = transformIfChains(input);
		expect(out).toContain('| {#if a}');
		expect(out).toContain('| {:else}');
		expect(out).toContain('| {/if}');
	});

	test('+if + +elseif + +else (three branches)', () => {
		const input = `+if('a')\n\tdiv one\n+elseif('b')\n\tdiv two\n+else\n\tdiv three`;
		const out = transformIfChains(input);
		expect(out).toContain('| {#if a}');
		expect(out).toContain('| {:else if b}');
		expect(out).toContain('| {:else}');
		expect(out).toContain('| {/if}');
	});

	test('de-indents body lines', () => {
		const input = `+if('cond')\n\tdiv content\n\t\tspan nested`;
		const out = transformIfChains(input);
		const lines = out.split('\n');
		// div content should be de-indented (no leading tab); span nested keeps relative indent
		expect(lines).toContain('div content');
		expect(lines).toContain('\tspan nested');
	});

	test('respects parent indentation', () => {
		const input = `.parent\n\t+if('cond')\n\t\tdiv content`;
		const out = transformIfChains(input);
		expect(out).toContain('\t| {#if cond}');
		expect(out).toContain('\tdiv content');
		expect(out).toContain('\t| {/if}');
	});

	test('leaves non-+if lines alone', () => {
		const input = `div hello\nul.list\n\tli item`;
		const out = transformIfChains(input);
		expect(out).toBe(input);
	});

	test('handles multiple chains in same file', () => {
		const input = `+if('a')\n\tdiv one\n\nul\n\tli item\n\n+if('b')\n\tdiv two`;
		const out = transformIfChains(input);
		const ifCount = (out.match(/\| \{#if/g) ?? []).length;
		const fiCount = (out.match(/\| \{\/if\}/g) ?? []).length;
		expect(ifCount).toBe(2);
		expect(fiCount).toBe(2);
	});

	test('strips quotes from condition expressions', () => {
		const input = `+if("status === 'win'")\n\tdiv yay`;
		const out = transformIfChains(input);
		expect(out).toContain(`| {#if status === 'win'}`);
	});
});

describe('rewritePugClasses', () => {
	test('safe classes pass through unchanged', () => {
		const input = `.text-blue.gap-3.flex`;
		expect(rewritePugClasses(input)).toBe(input);
	});

	test('routes single colon-variant class to attribute', () => {
		const input = `.hover:bg-red`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`(class="hover:bg-red")`);
	});

	test('combines fractional class then routes', () => {
		const input = `.gap-2.5`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`(class="gap-2.5")`);
	});

	test('routes opacity-modifier class', () => {
		const input = `.bg-white/40`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`(class="bg-white/40")`);
	});

	test('keeps safe and routes unsafe in same line', () => {
		const input = `.text-blue.hover:bg-red.gap-3`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`.text-blue.gap-3(class="hover:bg-red")`);
	});

	test('preserves tag and id', () => {
		const input = `a#main.btn:focus.text-blue`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`a#main.text-blue(class="btn:focus")`);
	});

	test('merges into existing static class attribute', () => {
		const input = `.hover:foo(class="bar")`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`(class="hover:foo bar")`);
	});

	test('merges into existing dynamic class attribute', () => {
		const input = `.hover:foo(class!="{cond ? 'a' : 'b'}")`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`(class!="hover:foo {cond ? 'a' : 'b'}")`);
	});

	test('inserts class= before other attrs when none exists', () => {
		const input = `.hover:foo(href="/")`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`(class="hover:foo" href="/")`);
	});

	test('handles multiple problematic classes', () => {
		const input = `.hover:foo.focus:bar`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`(class="hover:foo focus:bar")`);
	});

	test('preserves indentation', () => {
		const input = `\t\t.hover:foo`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`\t\t(class="hover:foo")`);
	});

	test('skips text emit lines', () => {
		const input = `| .hover:foo is text`;
		expect(rewritePugClasses(input)).toBe(input);
	});

	test('skips pug comments', () => {
		const input = `// .hover:foo`;
		expect(rewritePugClasses(input)).toBe(input);
	});

	test('skips mixin calls (+ prefix)', () => {
		const input = `+if('cond')`;
		expect(rewritePugClasses(input)).toBe(input);
	});

	test('handles balanced parens in attribute values', () => {
		const input = `button.hover:foo(onclick="{() => f()}")`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`button(class="hover:foo" onclick="{() => f()}")`);
	});

	test('skips lines inside script blocks', () => {
		const input = `<script>\n.hover:foo\n</script>`;
		expect(rewritePugClasses(input)).toBe(input);
	});

	test('preserves trailing text', () => {
		const input = `a.hover:foo Click me`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`a(class="hover:foo") Click me`);
	});

	test('handles tag with attribute and text', () => {
		const input = `a.hover:foo(href="/") Click`;
		const out = rewritePugClasses(input);
		expect(out).toBe(`a(class="hover:foo" href="/") Click`);
	});
});
