import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/concept-roamer', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  external: ['obsidian', 'https'],
  outfile: 'dist/concept-roamer/main.js',
  minify: false,
});
for (const file of ['manifest.json', 'styles.css', 'README.md']) {
  await copyFile(file, `dist/concept-roamer/${file}`);
}
