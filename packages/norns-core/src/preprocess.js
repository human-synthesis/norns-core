import { sveltePreprocess } from 'svelte-preprocess';

/**
 * Norns preprocessor: Svelte with CoffeeScript and Pug enabled by default.
 *
 * @param {import('svelte-preprocess').AutoPreprocessOptions} [options]
 * @returns {import('svelte/compiler').PreprocessorGroup}
 */
export function nornsPreprocess(options = {}) {
	return sveltePreprocess({
		coffeescript: { bare: true },
		pug: {},
		...options
	});
}
