import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
	entry: ['src/index.ts'],
	outDir: 'lib',
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	minify: !options.watch,
}));