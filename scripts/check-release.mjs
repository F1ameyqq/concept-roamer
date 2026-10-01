import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const versions = JSON.parse(await readFile('versions.json', 'utf8'));
assert.match(manifest.id, /^[a-z-]+$/, 'Plugin ID must contain only lowercase letters and hyphens.');
assert.ok(!manifest.id.includes('obsidian') && !manifest.id.endsWith('plugin'), 'Plugin ID contains a reserved term.');
assert.match(manifest.name, /^[A-Za-z0-9 +()-]+$/, 'Community name must use Basic Latin letters and numbers, with spaces, hyphens, plus signs or parentheses only.');
assert.equal(manifest.name, manifest.name.trim(), 'Community name must not have surrounding spaces.');
assert.ok(!/obsidian|obsi-|sidian|\bplugin\b/i.test(manifest.name), 'Community name contains a reserved term.');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, manifest.version, 'Package and manifest versions must match.');
assert.equal(versions[manifest.version], manifest.minAppVersion, 'Missing compatibility entry.');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, manifest.version, 'Tag must exactly match manifest version, without v.');
}
assert.ok((await readFile('LICENSE', 'utf8')).trim().length > 100, 'Add the owner-approved license before publishing.');
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  assert.ok((await stat(`dist/concept-roamer/${name}`)).size > 0, `Missing release asset: ${name}`);
}
assert.deepEqual(JSON.parse(await readFile('dist/concept-roamer/manifest.json', 'utf8')), manifest);
console.log(`Release ${manifest.version}: metadata and assets checked.`);
