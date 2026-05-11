import { describe, expect, test } from 'bun:test';
import { transformIfChains, transformSnippets, rewritePugClasses } from '../src/preprocess.js';

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

	test('nested +if/+else inside outer +if recurses correctly', () => {
		const input = `+if('a')\n\t+if('b')\n\t\tdiv one\n\t+else\n\t\tdiv two`;
		const out = transformIfChains(input);
		const ifs = (out.match(/\| \{#if /g) ?? []).length;
		const closes = (out.match(/\| \{\/if\}/g) ?? []).length;
		const elses = (out.match(/\| \{:else\}/g) ?? []).length;
		expect(ifs).toBe(2);
		expect(closes).toBe(2);
		expect(elses).toBe(1);
		// No orphaned `+if` / `+else` tokens left in output
		expect(out).not.toMatch(/^\s*\+if/m);
		expect(out).not.toMatch(/^\s*\+else/m);
	});

	test('nested +if inside +else branch recurses correctly', () => {
		const input = `+if('a')\n\tdiv top\n+else\n\t+if('b')\n\t\tdiv inner`;
		const out = transformIfChains(input);
		const ifs = (out.match(/\| \{#if /g) ?? []).length;
		const closes = (out.match(/\| \{\/if\}/g) ?? []).length;
		expect(ifs).toBe(2);
		expect(closes).toBe(2);
		expect(out).not.toMatch(/^\s*\+if/m);
	});
});

describe('transformSnippets', () => {
	test('+snippet with no args becomes {#snippet name()}', () => {
		const input = `+snippet('header')\n\th2 Title`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet header()}');
		expect(out).toContain('h2 Title');
		expect(out).toContain('| {/snippet}');
	});

	test('+snippet with single arg', () => {
		const input = `+snippet('row', user)\n\t.row {user.name}`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet row(user)}');
		expect(out).toContain('.row {user.name}');
		expect(out).toContain('| {/snippet}');
	});

	test('+snippet with multiple args', () => {
		const input = `+snippet('row', user, idx)\n\t.row {idx}: {user.name}`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet row(user, idx)}');
	});

	test('+snippet with destructured arg', () => {
		const input = `+snippet('item', { name, count })\n\tspan {name}: {count}`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet item({ name, count })}');
	});

	test('+snippet with parenthesised expression in args', () => {
		const input = `+snippet('cell', cells[i])\n\t.cell {cells[i]}`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet cell(cells[i])}');
	});

	test('double-quoted name', () => {
		const input = `+snippet("header")\n\th2 Title`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet header()}');
	});

	test('body lines are de-indented one level', () => {
		const input = `+snippet('foo')\n\tdiv outer\n\t\tspan inner`;
		const out = transformSnippets(input);
		const lines = out.split('\n');
		expect(lines).toContain('| {#snippet foo()}');
		expect(lines).toContain('div outer');
		expect(lines).toContain('\tspan inner');
		expect(lines).toContain('| {/snippet}');
	});

	test('nested +snippet inside another +snippet', () => {
		const input = `+snippet('outer')\n\tdiv\n\t\t+snippet('inner')\n\t\t\tp inner`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet outer()}');
		expect(out).toContain('| {#snippet inner()}');
		expect(out).toContain('p inner');
		// Two close tags, one for each
		const closes = out.match(/\| \{\/snippet\}/g);
		expect(closes?.length).toBe(2);
	});

	test('non-snippet content passes through unchanged', () => {
		const input = `div hello\nspan world`;
		expect(transformSnippets(input)).toBe(input);
	});

	test('blank lines inside body are preserved', () => {
		const input = `+snippet('x')\n\tdiv a\n\n\tdiv b`;
		const out = transformSnippets(input);
		expect(out).toContain('div a');
		expect(out).toContain('div b');
	});

	test('multiple top-level snippets are independent', () => {
		const input = `+snippet('a')\n\tp first\n+snippet('b')\n\tp second`;
		const out = transformSnippets(input);
		expect(out).toContain('| {#snippet a()}');
		expect(out).toContain('| {#snippet b()}');
		expect(out).toContain('p first');
		expect(out).toContain('p second');
		const closes = out.match(/\| \{\/snippet\}/g);
		expect(closes?.length).toBe(2);
	});

	test('content after a snippet at lower indent is not consumed', () => {
		const input = `+snippet('a')\n\tp inside\np outside`;
		const out = transformSnippets(input);
		expect(out).toContain('| {/snippet}');
		expect(out).toContain('p outside');
		// "p outside" must come AFTER {/snippet}, not consumed as body
		const closeIdx = out.indexOf('| {/snippet}');
		const outsideIdx = out.indexOf('p outside');
		expect(outsideIdx).toBeGreaterThan(closeIdx);
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
