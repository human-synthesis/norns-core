import UnoCSS from 'unocss/vite';
import { presetUno, presetAttributify, presetIcons, presetTypography } from 'unocss';

/**
 * Norns UnoCSS Vite plugin with a sensible preset stack.
 *
 * Defaults `hmrTopLevelAwait: false` to avoid a TDZ
 * "Cannot access 'component' before initialization" error in WebKit/Safari
 * when importing 'virtual:uno.css' from a SvelteKit layout/page module.
 * Pass `hmrTopLevelAwait: true` if you've verified your stack handles it.
 *
 * @param {import('unocss/vite').VitePluginConfig} [options]
 */
export function nornsUno(options = {}) {
	const { presets = [], hmrTopLevelAwait = false, ...rest } = options;
	return UnoCSS({
		presets: [
			presetUno(),
			presetAttributify(),
			presetIcons(),
			presetTypography(),
			...presets
		],
		hmrTopLevelAwait,
		...rest
	});
}
