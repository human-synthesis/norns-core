/**
 * Errors thrown by the preprocessor must point at the line the user wrote,
 * not at svelte-preprocess's mixin prelude or the script block's own line
 * numbering. Agents open whatever line the message says.
 */
import { describe, expect, test } from 'bun:test';
import { preprocess } from 'svelte/compiler';
import { nornsPreprocess } from '../src/preprocess.js';

async function fail(source, filename = 'Bad.n') {
	try {
		await preprocess(source, nornsPreprocess(), { filename });
	} catch (e) {
		return e;
	}
	throw new Error('expected preprocess to throw');
}

describe('Pug error mapping', () => {
	test('points at the source line of a .n file (template before script)', async () => {
		const src = ['section', '\tp hi', '  span oops', '', '<script>', '\tx := 1', '</script>', ''].join('\n');
		const e = await fail(src);
		expect(e.code).toBe('norns_pug_error');
		expect(e.line).toBe(3);
		expect(e.approximate).toBe(false);
		expect(e.message).toMatch(/^Bad\.n:3:\d+: Pug: /);
		expect(e.message).toContain('span oops');
		// The raw Pug line (prelude + template) is kept for debugging and is
		// well past the real one.
		expect(e.pugLine).toBeGreaterThan(40);
	});

	test('points at the source line when the script block comes first', async () => {
		const src = ['<script>', '\tx := 1', '</script>', '', 'section', '\tp hi', '  span oops', ''].join('\n');
		const e = await fail(src);
		expect(e.line).toBe(7);
		expect(e.message).toMatch(/^Bad\.n:7:/);
	});

	test('maps a line inside a rewritten +if chain', async () => {
		const src = ['div', "\t+if('ok')", '\t\tp yes', '\t  span oops', '\t+else', '\t\tp no', ''].join('\n');
		const e = await fail(src);
		expect(e.line).toBe(4);
	});

	test('works for an explicit <template lang="pug"> in a .svelte file', async () => {
		const src = ['<script>', '\tlet x = 1;', '</script>', '', '<template lang="pug">', 'section', '\tp hi', '  span oops', '</template>', ''].join('\n');
		const e = await fail(src, 'Bad.svelte');
		expect(e.code).toBe('norns_pug_error');
		expect(e.line).toBe(8);
	});
});

describe('Civet script error mapping', () => {
	test('points at the file line of the failing script statement', async () => {
		const src = ['p hi', '', '<script>', '\tok := 1', '\tbroken := (', '\tmore := 2', '</script>', ''].join('\n');
		const e = await fail(src);
		expect(e.code).toBe('norns_civet_error');
		expect(e.line).toBeGreaterThanOrEqual(5);
		expect(e.line).toBeLessThanOrEqual(7);
		expect(e.message).toMatch(/^Bad\.n:\d+:\d+: Civet: /);
		expect(e.frame).toContain('broken := (');
	});
});
