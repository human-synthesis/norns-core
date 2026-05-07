import UnoCSS from 'unocss/vite';
import { presetUno, presetAttributify, presetIcons, presetTypography } from 'unocss';

/**
 * Norns UnoCSS Vite plugin with a sensible preset stack.
 * Pass overrides to merge with the defaults.
 *
 * @param {import('unocss/vite').VitePluginConfig} [options]
 */
export function nornsUno(options = {}) {
	const { presets = [], ...rest } = options;
	return UnoCSS({
		presets: [
			presetUno(),
			presetAttributify(),
			presetIcons(),
			presetTypography(),
			...presets
		],
		...rest
	});
}
