const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('release check rejects the former Chinese community name', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'concept-roamer-manifest-'));
  try {
    const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
    manifest.name = '概念漫游';
    await fs.writeFile(path.join(temporaryDirectory, 'manifest.json'), JSON.stringify(manifest));
    await fs.copyFile('package.json', path.join(temporaryDirectory, 'package.json'));
    await fs.copyFile('versions.json', path.join(temporaryDirectory, 'versions.json'));
    const result = spawnSync(process.execPath, [path.resolve('scripts/check-release.mjs')], {
      cwd: temporaryDirectory,
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Community name must use Basic Latin/);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
