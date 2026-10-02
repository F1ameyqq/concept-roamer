const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { buildSync } = require('esbuild');

class TFile {
  constructor(filePath) { this.rename(filePath); }
  rename(filePath) {
    this.path = filePath;
    this.name = filePath.split('/').at(-1);
    this.extension = this.name.split('.').at(-1);
    this.basename = this.name.slice(0, -this.extension.length - 1);
  }
}
class TFolder { constructor(filePath) { this.path = filePath; } }
const compiled = buildSync({ entryPoints: [path.join(__dirname, '../src/store.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text;
const moduleScope = { exports: {} };
vm.runInNewContext(compiled, { module: moduleScope, exports: moduleScope.exports,
  require: name => {
    assert.equal(name, 'obsidian');
    return { TFile, TFolder, normalizePath: value => value.replace(/\\/g, '/').replace(/\/+$/g, '') };
  }, crypto: webcrypto, TextEncoder, Uint8Array, Date, Map, Set, Error });
const { VaultStore, noteSourceHash, noteContentHash, ROOT } = moduleScope.exports;
const sid = '10000000-0000-4000-8000-000000000001';
const noteId = '20000000-0000-4000-8000-000000000001';
const draftId = '30000000-0000-4000-8000-000000000001';
const nextDraftId = '30000000-0000-4000-8000-000000000002';
const thirdDraftId = '30000000-0000-4000-8000-000000000003';
const message = (number, parentId = null, role = number % 2 ? 'user' : 'assistant', status = 'complete') => ({
  schemaVersion: 1, id: `40000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  sessionId: sid, parentId, role, content: `消息 ${number}`, status, createdAt: '2026-10-02T00:00:00.000Z',
});
const first = message(1), second = message(2, first.id), third = message(3, second.id), fourth = message(4, third.id);
const chain = [first, second, third, fourth];
const markdown = (leafId = second.id, body = '原文\n\n手动保留的段落。', identity = noteId) =>
  `---\nconcept_id: ${identity}\nsession_id: ${sid}\nbranch_leaf_id: ${leafId}\ncustom: kept\n---\n\n# 反馈回路\n\n${body}\n`;
const basePath = `${ROOT}/概念/反馈回路.md`;
const plain = value => JSON.parse(JSON.stringify(value));

function host() {
  const records = new Map(), metadata = new Map(), reads = [], processCalls = [];
  let beforeProcess, failedPath;
  const add = (filePath, text) => {
    const file = new TFile(filePath);
    records.set(filePath, { file, text });
    return file;
  };
  const vault = {
    getAbstractFileByPath: filePath => records.get(filePath)?.file ?? null,
    getMarkdownFiles: () => [...records.values()].map(entry => entry.file)
      .filter(file => file instanceof TFile && file.extension === 'md'),
    read: async file => { reads.push(file.path); return records.get(file.path).text; },
    createFolder: async filePath => {
      if (records.has(filePath)) throw new Error('Already exists');
      records.set(filePath, { file: new TFolder(filePath) });
    },
    create: async (filePath, text) => {
      if (failedPath === filePath) { failedPath = null; throw new Error('simulated write failure'); }
      if (records.has(filePath)) throw new Error('Already exists');
      return add(filePath, text);
    },
    process: async (file, callback) => {
      processCalls.push(file.path);
      beforeProcess?.(file);
      const record = records.get(file.path);
      record.text = callback(record.text);
      return record.text;
    },
    adapter: {
      stat: async filePath => {
        const entry = records.get(filePath);
        return entry ? { type: entry.file instanceof TFolder ? 'folder' : 'file' } : null;
      },
      read: async filePath => records.get(filePath).text,
      list: async folder => {
        const entries = [...records.values()].filter(entry => entry.file.path.startsWith(`${folder}/`) &&
          !entry.file.path.slice(folder.length + 1).includes('/'));
        return { files: entries.filter(entry => entry.file instanceof TFile).map(entry => entry.file.path),
          folders: entries.filter(entry => entry.file instanceof TFolder).map(entry => entry.file.path) };
      },
    },
  };
  return { store: new VaultStore({ vault, metadataCache: { getFileCache: file => metadata.get(file.path) ?? null } }),
    records, metadata, reads, processCalls, add,
    changeBeforeProcess: callback => { beforeProcess = callback; },
    failNextCreate: filePath => { failedPath = filePath; },
    rename: (oldPath, newPath) => {
      const entry = records.get(oldPath);
      records.delete(oldPath); entry.file.rename(newPath); records.set(newPath, entry);
    } };
}

async function revision(messages = chain, id = draftId, mode = 'update') {
  return { schemaVersion: 1, id, noteId, sessionId: sid, path: basePath,
    leafId: messages.at(-1).id, coveredMessageIds: messages.map(entry => entry.id),
    sourceHash: await noteSourceHash(messages), createdAt: '2026-10-02T01:00:00.000Z', mode };
}
async function selected(fixture, messages = chain) {
  const candidates = await fixture.store.noteCandidates(sid, messages);
  assert.equal(candidates.length, 1);
  return candidates[0];
}

test('legacy concept discovery verifies current frontmatter despite absent or stale metadata', async () => {
  const fixture = host();
  fixture.add(basePath, markdown());
  fixture.metadata.set(basePath, { frontmatter: { session_id: 'stale-session', concept_id: 'stale-id' } });
  fixture.add('普通笔记.md', '# 普通笔记');
  const candidate = await selected(fixture);
  assert.equal(candidate.noteId, noteId);
  assert.equal(candidate.matchingBranch, true);
  assert.equal(candidate.revision, undefined);
});

test('moving a note outside the plugin directory resolves its stable identity at the new path', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture);
  fixture.rename(basePath, '研究/反馈回路.md');
  const moved = await fixture.store.readConceptNote(candidate);
  assert.equal(moved.path, '研究/反馈回路.md');
  assert.equal(moved.content, markdown());
  assert.equal((await selected(fixture)).path, '研究/反馈回路.md');
});

test('current branch membership uses the latest saved revision and exact source fingerprint', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const saved = await revision(chain.slice(0, 3), draftId, 'create');
  await fixture.store.saveNoteRevision(saved);
  const candidate = await selected(fixture);
  assert.equal(candidate.leafId, third.id);
  assert.equal(candidate.matchingBranch, true);
  assert.equal((await selected(fixture, [{ ...first, content: '被修改的记录' }, ...chain.slice(1)])).matchingBranch, false);
  const sibling = message(5, second.id);
  assert.equal((await selected(fixture, [first, second, sibling])).matchingBranch, false);
});

test('stopped assistant messages remain part of the immutable coverage prefix', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const source = [first, { ...second, status: 'stopped' }, third];
  await fixture.store.saveNoteRevision(await revision(source, draftId, 'create'));
  assert.equal((await selected(fixture, [...source, fourth])).matchingBranch, true);
  assert.equal((await selected(fixture, [first, third, fourth])).matchingBranch, false);
});

test('legacy sibling branches are displayed without enabling an update', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const sibling = message(5, first.id);
  const candidate = await selected(fixture, [first, sibling]);
  assert.equal(candidate.matchingBranch, false);
  await assert.rejects(fixture.store.updateConceptNote(candidate, markdown(), markdown(fourth.id), await revision()), /当前讨论分支/);
  assert.equal(fixture.processCalls.length, 0);
});

test('hidden, traversal, absolute and generated helper files are excluded as update targets', async () => {
  const fixture = host();
  for (const filePath of ['.obsidian/test.md', '研究/../test.md', '/absolute.md', 'C:/absolute.md', '研究/反馈#新.md', '研究/[反馈].md',
    `${ROOT}/会话/${sid}/笔记版本/${draftId}.md`, `${ROOT}/导出/test.md`, `${ROOT}/人格.md`]) fixture.add(filePath, markdown());
  assert.equal((await fixture.store.noteCandidates(sid, chain)).length, 0);
  assert.deepEqual(fixture.reads.sort(), ['研究/[反馈].md', '研究/反馈#新.md'].sort());
});

test('updating backs up the full original and atomically saves a new immutable revision', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture), desired = markdown(fourth.id, '合并后的正文\n\n手动保留的段落。');
  assert.equal(await fixture.store.updateConceptNote(candidate, markdown(), desired, await revision()), basePath);
  assert.equal(fixture.records.get(basePath).text, desired);
  assert.equal(fixture.records.get(`${ROOT}/会话/${sid}/笔记版本/${draftId}.md`).text, markdown());
  const record = JSON.parse(fixture.records.get(`${ROOT}/会话/${sid}/笔记修订/${draftId}.json`).text);
  assert.equal(record.contentHash, await noteContentHash(desired));
  assert.deepEqual(record.coveredMessageIds, chain.map(entry => entry.id));
  assert.equal(record.noteId, noteId);
});

test('manual or sync changes after preview are rejected inside the atomic process callback', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture), edited = markdown(second.id, '最新手工正文');
  fixture.changeBeforeProcess(file => { fixture.records.get(file.path).text = edited; });
  await assert.rejects(fixture.store.updateConceptNote(candidate, markdown(), markdown(fourth.id), await revision()), /预览后发生了修改/);
  assert.equal(fixture.records.get(basePath).text, edited);
  assert.equal(fixture.records.has(`${ROOT}/会话/${sid}/笔记修订/${draftId}.json`), false);
});

test('changed stable identity cannot be overwritten even with an unchanged path', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture), otherId = '20000000-0000-4000-8000-000000000002';
  fixture.changeBeforeProcess(file => { fixture.records.get(file.path).text = markdown(second.id, '其他笔记', otherId); });
  await assert.rejects(fixture.store.updateConceptNote(candidate, markdown(), markdown(fourth.id), await revision()), /标识已变更/);
  assert.ok(fixture.records.get(basePath).text.includes(otherId));
});

test('retrying the same completed draft does not create another revision or replace its backup', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture), desired = markdown(fourth.id, '合并结果'), saved = await revision();
  await fixture.store.updateConceptNote(candidate, markdown(), desired, saved);
  const recordPath = `${ROOT}/会话/${sid}/笔记修订/${draftId}.json`, originalRecord = fixture.records.get(recordPath).text;
  await fixture.store.updateConceptNote(candidate, markdown(), desired, saved);
  assert.equal(fixture.records.get(recordPath).text, originalRecord);
  assert.equal((await fixture.store.noteRevisions(sid)).length, 1);
  assert.equal(fixture.records.get(`${ROOT}/会话/${sid}/笔记版本/${draftId}.md`).text, markdown());
});

test('completed draft retry rejects a subsequent manual edit, including a manual revert to the old text', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture), desired = markdown(fourth.id, '合并结果'), saved = await revision();
  await fixture.store.updateConceptNote(candidate, markdown(), desired, saved);
  fixture.records.get(basePath).text = markdown();
  await assert.rejects(fixture.store.updateConceptNote(candidate, markdown(), desired, saved), /预览后发生了修改/);
  assert.equal(fixture.records.get(basePath).text, markdown());
});

test('a failure writing the final revision can be retried after the note was already updated', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture), desired = markdown(fourth.id, '合并结果'), saved = await revision();
  fixture.failNextCreate(`${ROOT}/会话/${sid}/笔记修订/${draftId}.json`);
  await assert.rejects(fixture.store.updateConceptNote(candidate, markdown(), desired, saved), /simulated write failure/);
  assert.equal(fixture.records.get(basePath).text, desired);
  await fixture.store.updateConceptNote(candidate, markdown(), desired, saved);
  assert.equal((await fixture.store.noteRevisions(sid)).length, 1);
  assert.equal(fixture.records.get(`${ROOT}/会话/${sid}/笔记版本/${draftId}.md`).text, markdown());
});

test('backup failure stops before the note is touched', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture);
  fixture.failNextCreate(`${ROOT}/会话/${sid}/笔记版本/${draftId}.md`);
  await assert.rejects(fixture.store.updateConceptNote(candidate, markdown(), markdown(fourth.id), await revision()), /simulated write failure/);
  assert.equal(fixture.processCalls.length, 0);
  assert.equal(fixture.records.get(basePath).text, markdown());
});

test('saved revision records reject modification and malformed records cannot silently fall back to legacy', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const saved = await revision(chain.slice(0, 2), draftId, 'create');
  await fixture.store.saveNoteRevision(saved);
  await assert.rejects(fixture.store.saveNoteRevision({ ...saved, sourceHash: 'f'.repeat(64) }), /已存在不同内容/);
  const recordPath = `${ROOT}/会话/${sid}/笔记修订/${draftId}.json`;
  assert.deepEqual(JSON.parse(fixture.records.get(recordPath).text), plain(saved));
  fixture.add(`${ROOT}/会话/${sid}/笔记修订/${nextDraftId}.json`, JSON.stringify({ ...saved, id: nextDraftId, coveredMessageIds: [] }));
  await assert.rejects(fixture.store.noteCandidates(sid, chain), /整理记录尚未同步完整/);
});

test('rename between preview and save records the current path while preserving the original revision', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const initial = { ...await revision(chain.slice(0, 2), nextDraftId, 'create'), createdAt: '2026-10-02T00:00:00.000Z' };
  await fixture.store.saveNoteRevision(initial);
  const candidate = await selected(fixture);
  fixture.rename(basePath, '研究/反馈回路.md');
  const update = { ...await revision(), previousRevisionId: nextDraftId };
  assert.equal(await fixture.store.updateConceptNote(candidate, markdown(), markdown(fourth.id), update), '研究/反馈回路.md');
  const records = await fixture.store.noteRevisions(sid);
  assert.equal(records.find(entry => entry.id === draftId).path, '研究/反馈回路.md');
  assert.equal(records.find(entry => entry.id === nextDraftId).path, basePath);
  assert.equal((await selected(fixture)).matchingBranch, true);
  assert.equal((await selected(fixture)).leafId, fourth.id);
});

test('duplicate concept IDs cannot share the latest revision across different note bodies', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  await fixture.store.saveNoteRevision(await revision(chain.slice(0, 3), draftId, 'create'));
  fixture.add('研究/反馈副本.md', markdown(second.id, '副本尚未包含最近的补充内容'));
  const candidates = await fixture.store.noteCandidates(sid, chain);
  assert.equal(candidates.length, 2);
  assert.equal(candidates.every(candidate => !candidate.matchingBranch && candidate.duplicateIdentity && candidate.unavailableReason.includes('标识重复')), true);
  for (const candidate of candidates) await assert.rejects(fixture.store.readConceptNote(candidate), /多篇同一标识/);
  const newNoteId = '20000000-0000-4000-8000-000000000002';
  await fixture.store.createConcept('反馈回路', newNoteId, markdown(fourth.id, '独立整理的新内容', newNoteId));
  assert.equal((await fixture.store.noteCandidates(sid, chain)).find(candidate => candidate.noteId === newNoteId).matchingBranch, true);
});

test('a copy arriving after preview blocks updating even when the selected original path still exists', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture);
  fixture.add('研究/反馈副本.md', markdown(second.id, '复制后的不同正文'));
  await assert.rejects(fixture.store.updateConceptNote(candidate, markdown(), markdown(fourth.id), await revision()), /多篇同一标识/);
  assert.equal(fixture.processCalls.length, 0);
  assert.equal(fixture.records.get(basePath).text, markdown());
  assert.equal(fixture.records.has(`${ROOT}/会话/${sid}/笔记版本/${draftId}.md`), false);
});

test('duplicate stable IDs are rejected even when a copied file has a different session ID', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture);
  fixture.add('研究/另一会话的副本.md', markdown().replace(sid, '10000000-0000-4000-8000-000000000002'));
  assert.equal((await selected(fixture)).matchingBranch, false);
  await assert.rejects(fixture.store.readConceptNote(candidate), /多篇同一标识/);
});

test('copies with wiki delimiters or annotated YAML IDs still make the original identity ambiguous', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const candidate = await selected(fixture);
  const copied = markdown().replace(`concept_id: ${noteId}`, `concept_id: '${noteId}' # 保留来源标识`);
  fixture.add('研究/反馈#副本.md', copied);
  const candidates = await fixture.store.noteCandidates(sid, chain);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].duplicateIdentity, true);
  assert.equal(candidates[0].matchingBranch, false);
  await assert.rejects(fixture.store.readConceptNote(candidate), /多篇同一标识/);
});

test('revision lineage follows the last descendant despite device clock skew and ID ordering', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const initial = { ...await revision(chain.slice(0, 2), thirdDraftId, 'create'), createdAt: '2030-01-01T00:00:00.000Z' };
  const child = { ...await revision(chain.slice(0, 3), nextDraftId), previousRevisionId: initial.id,
    createdAt: '2026-01-01T00:00:00.000Z' };
  await fixture.store.saveNoteRevision(initial);
  await fixture.store.saveNoteRevision(child);
  const candidate = await selected(fixture);
  assert.equal(candidate.matchingBranch, true);
  assert.equal(candidate.revision.id, child.id);
  assert.equal(candidate.leafId, third.id);
  await fixture.store.updateConceptNote(candidate, markdown(), markdown(fourth.id), { ...await revision(), previousRevisionId: child.id });
  assert.equal((await selected(fixture)).revision.id, draftId);
});

test('a missing predecessor cannot fall back to legacy progress or permit a stale preview update', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const oldCandidate = await selected(fixture);
  await fixture.store.saveNoteRevision({ ...await revision(chain.slice(0, 3), nextDraftId), previousRevisionId: thirdDraftId });
  const candidate = await selected(fixture);
  assert.equal(candidate.matchingBranch, false);
  assert.match(candidate.unavailableReason, /尚未同步完整/);
  assert.equal(candidate.revision, undefined);
  await assert.rejects(fixture.store.updateConceptNote(oldCandidate, markdown(), markdown(fourth.id), await revision()), /尚未同步完整/);
  assert.equal(fixture.processCalls.length, 0);
});

test('concurrent revision descendants disable updates instead of choosing one by timestamp', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  const initial = await revision(chain.slice(0, 2), draftId, 'create');
  await fixture.store.saveNoteRevision(initial);
  const oldCandidate = await selected(fixture);
  await fixture.store.saveNoteRevision({ ...await revision(chain.slice(0, 3), nextDraftId), previousRevisionId: initial.id });
  await fixture.store.saveNoteRevision({ ...await revision(chain, thirdDraftId), previousRevisionId: initial.id,
    createdAt: '2030-01-01T00:00:00.000Z' });
  const candidate = await selected(fixture);
  assert.equal(candidate.matchingBranch, false);
  assert.match(candidate.unavailableReason, /并发/);
  await assert.rejects(fixture.store.updateConceptNote(oldCandidate, markdown(), markdown(fourth.id),
    { ...await revision(chain, '30000000-0000-4000-8000-000000000004'), previousRevisionId: initial.id }), /并发/);
  assert.equal(fixture.records.get(basePath).text, markdown());
});

test('multiple root revisions for one legacy concept disable updating', async () => {
  const fixture = host(); fixture.add(basePath, markdown());
  await fixture.store.saveNoteRevision(await revision(chain.slice(0, 2), draftId));
  await fixture.store.saveNoteRevision(await revision(chain.slice(0, 3), nextDraftId));
  const candidate = await selected(fixture);
  assert.equal(candidate.matchingBranch, false);
  assert.match(candidate.unavailableReason, /并发或不一致/);
});
