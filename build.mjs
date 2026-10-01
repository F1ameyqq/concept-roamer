import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/concept-roamer', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  // Obsidian evaluates CommonJS plugins in a renderer. Lower the guarded desktop
  // import to require so Chromium does not try to resolve a browser module URL.
  supported: { 'dynamic-import': false },
  external: ['obsidian', 'https'],
  outfile: 'dist/concept-roamer/main.js',
  minify: false,
});
for (const file of ['manifest.json', 'styles.css', 'README.md']) {
  await copyFile(file, `dist/concept-roamer/${file}`);
}
