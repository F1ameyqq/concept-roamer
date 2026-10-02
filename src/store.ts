import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { Message, Session, newId } from './model';
import { safeNoteTitle } from './organize';
import { TitleRevision, applyTitleRevisions, conversationTitle, provisionalTitle } from './titles';
import { noteQuote } from './selection';
import { ContextSummary, validateContextSummary } from './context';

export const ROOT = '概念漫游';
export const PERSONA = `${ROOT}/人格.md`;
export const MEMORY = `${ROOT}/全局记忆.md`;

export interface NoteRevision {
  schemaVersion: 1;
  id: string;
  noteId: string;
  sessionId: string;
  path: string;
  leafId: string;
  coveredMessageIds: string[];
  sourceHash: string;
  createdAt: string;
  mode: 'create' | 'update';
  previousRevisionId?: string;
  contentHash?: string;
}
export interface NoteCandidate {
  noteId: string;
  path: string;
  title: string;
  sessionId: string;
  leafId: string;
  matchingBranch: boolean;
  revision?: NoteRevision;
  duplicateIdentity?: true;
  unavailableReason?: string;
}

const NOTE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOTE_HASH = /^[0-9a-f]{64}$/;
const revisionError = () => new Error('笔记整理记录尚未同步完整或格式不正确，请稍后重试；仍可保存为新笔记。');

export async function noteContentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
}

export function noteSourceHash(messages: Message[]): Promise<string> {
  return noteContentHash(JSON.stringify(messages.map(message => ({
    id: message.id, sessionId: message.sessionId, parentId: message.parentId, role: message.role,
    content: message.content, status: message.status,
    ...(message.noteQuote ? { noteQuote: { path: message.noteQuote.path, title: message.noteQuote.title, text: message.noteQuote.text } } : {}),
  }))));
}

function conceptBodyPath(path: string): boolean {
  // eslint-disable-next-line no-control-regex -- Vault-relative targets cannot contain path controls.
  return path.endsWith('.md') && normalizePath(path) === path && !/[\\:\x00-\x1f]/.test(path) &&
    !path.startsWith('/') && !path.split('/').some(part => !part || part.startsWith('.')) &&
    !path.startsWith(`${ROOT}/会话/`) && !path.startsWith(`${ROOT}/导出/`) && path !== PERSONA && path !== MEMORY;
}

function safeConceptPath(path: string): boolean {
  return conceptBodyPath(path) && !/[[\]|#^]/.test(path);
}

function validateNoteRevision(value: unknown): NoteRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw revisionError();
  const revision = value as NoteRevision;
  if (revision.schemaVersion !== 1 || !NOTE_UUID.test(revision.id ?? '') ||
      !NOTE_UUID.test(revision.noteId ?? '') || !NOTE_UUID.test(revision.sessionId ?? '') ||
      !NOTE_UUID.test(revision.leafId ?? '') || typeof revision.path !== 'string' || !safeConceptPath(revision.path) ||
      !Array.isArray(revision.coveredMessageIds) || !revision.coveredMessageIds.length || revision.coveredMessageIds.length > 20000 ||
      revision.coveredMessageIds.some(id => typeof id !== 'string' || !NOTE_UUID.test(id)) ||
      new Set(revision.coveredMessageIds).size !== revision.coveredMessageIds.length ||
      revision.coveredMessageIds[revision.coveredMessageIds.length - 1] !== revision.leafId || !NOTE_HASH.test(revision.sourceHash ?? '') ||
      typeof revision.createdAt !== 'string' || !Number.isFinite(Date.parse(revision.createdAt)) ||
      (revision.mode !== 'create' && revision.mode !== 'update') ||
      (revision.previousRevisionId !== undefined && !NOTE_UUID.test(revision.previousRevisionId)) ||
      (revision.contentHash !== undefined && !NOTE_HASH.test(revision.contentHash))) throw revisionError();
  return { schemaVersion: 1, id: revision.id, noteId: revision.noteId, sessionId: revision.sessionId,
    path: revision.path, leafId: revision.leafId, coveredMessageIds: [...revision.coveredMessageIds],
    sourceHash: revision.sourceHash, createdAt: revision.createdAt, mode: revision.mode,
    ...(revision.previousRevisionId === undefined ? {} : { previousRevisionId: revision.previousRevisionId }),
    ...(revision.contentHash === undefined ? {} : { contentHash: revision.contentHash }) };
}

function noteLineage(revisions: NoteRevision[]): { revision?: NoteRevision; unavailableReason?: string } {
  if (!revisions.length) return {};
  const byId = new Map(revisions.map(revision => [revision.id, revision]));
  if (revisions.some(revision => revision.previousRevisionId && !byId.has(revision.previousRevisionId))) {
    return { unavailableReason: '笔记的先前修订尚未同步完整，请等待同步后再更新。' };
  }
  const roots = revisions.filter(revision => !revision.previousRevisionId);
  const predecessors = new Set(revisions.map(revision => revision.previousRevisionId));
  const tips = revisions.filter(revision => !predecessors.has(revision.id));
  if (roots.length !== 1 || tips.length !== 1) {
    return { unavailableReason: '这篇笔记存在并发或不一致的整理修订，请保存为新笔记。' };
  }
  const seen = new Set<string>();
  let current: NoteRevision | undefined = tips[0];
  while (current) {
    if (seen.has(current.id)) return { unavailableReason: '笔记整理修订出现循环关联，请保存为新笔记。' };
    seen.add(current.id);
    current = current.previousRevisionId ? byId.get(current.previousRevisionId) : undefined;
  }
  if (seen.size !== revisions.length) return { unavailableReason: '笔记整理修订尚未形成完整关联，请等待同步后再更新。' };
  return { revision: tips[0] };
}

/** Read the stable IDs from the file itself: metadata can still describe its pre-sync contents. */
function conceptIdentity(content: string): { noteId: string; sessionId: string; leafId: string } | null {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!header) return null;
  const scalar = (field: string): string | null => {
    const lines = header.split(/\r?\n/).filter(line => new RegExp(`^${field}\\s*:`).test(line));
    if (lines.length !== 1) return null;
    const value = lines[0].replace(new RegExp(`^${field}\\s*:\\s*`), '').trim().replace(/\s+#.*$/, '').trim();
    const plain = value.replace(/^(['"])([0-9a-f-]+)\1$/, '$2');
    return NOTE_UUID.test(plain) ? plain : null;
  };
  const noteId = scalar('concept_id'), sessionId = scalar('session_id'), leafId = scalar('branch_leaf_id');
  return noteId && sessionId && leafId ? { noteId, sessionId, leafId } : null;
}

export class VaultStore {
  constructor(private app: App) {}
  private async kind(path: string): Promise<'file' | 'folder' | null> {
    const indexed = this.app.vault.getAbstractFileByPath(path);
    if (indexed instanceof TFolder) return 'folder';
    if (indexed instanceof TFile) return 'file';
    // At startup or during sync, the in-memory vault index can lag disk state.
    return (await this.app.vault.adapter.stat(path))?.type ?? null;
  }
  async folder(path: string): Promise<void> {
    let current = '';
    for (const part of normalizePath(path).split('/')) {
      current = current ? `${current}/${part}` : part;
      const existing = await this.kind(current);
      if (existing === 'file') throw new Error(`目录被文件占用：${current}`);
      if (!existing) {
        try { await this.app.vault.createFolder(current); }
        catch (error) {
          if (await this.kind(current) !== 'folder') throw error;
        }
      }
    }
  }
  async initialize(): Promise<void> {
    await this.folder(`${ROOT}/会话`);
    await this.folder(`${ROOT}/导出`);
    await this.createOnce(PERSONA,
      '用中文自然交流。先理解我的问题，再引入相关概念。\n用具体例子解释术语，主动指出适用条件与反例。\n不要把你的推测写成我的观点。来源未核验时明确说明。\n');
    await this.createOnce(MEMORY,
      '# 全局记忆\n\n此验证版仅使用你在这里明确写入的记忆。修改后，下次发送消息时生效。\n\n');
  }
  private async createOnce(path: string, text: string): Promise<void> {
    const existing = await this.kind(path);
    if (existing === 'folder') throw new Error(`文件路径被目录占用：${path}`);
    if (!existing) {
      try { await this.app.vault.create(path, text); }
      catch (error) { if (await this.kind(path) !== 'file') throw error; }
    }
  }
  async text(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return this.app.vault.read(file);
    if (await this.kind(path) !== 'file') throw new Error(`找不到上下文文件：${path}`);
    return this.app.vault.adapter.read(path);
  }
  async createSession(session: Session): Promise<void> {
    const root = `${ROOT}/会话/${session.id}`;
    await this.folder(`${root}/消息`);
    await this.createOnce(`${root}/会话.json`, JSON.stringify(session, null, 2));
  }
  async sessionTitle(session: Session): Promise<Session> {
    if (session.title === '新的探索' && !session.titleRevisionId) {
      try {
        const messages = await this.messages(session.id);
        const first = messages.filter(message => message.role === 'user').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (first) session = { ...session, title: provisionalTitle(first.noteQuote ? `${first.noteQuote.title}：${first.content}` : first.content) };
      } catch { /* Keep the placeholder until the message files finish syncing. */ }
    }
    const folder = `${ROOT}/会话/${session.id}/标题`;
    if (!await this.kind(folder)) return session;
    const revisions: TitleRevision[] = [];
    const files = (await this.app.vault.adapter.list(folder)).files;
    for (const path of files) {
      try {
        const revision = JSON.parse(await this.text(path)) as TitleRevision;
        if (revision.schemaVersion !== 1 || revision.sessionId !== session.id ||
            !/^[0-9a-f-]{36}$/.test(revision.id) || path !== `${folder}/${revision.id}.json` ||
            (revision.parentRevisionId !== null && !/^[0-9a-f-]{36}$/.test(revision.parentRevisionId)) ||
            (revision.mode !== 'auto' && revision.mode !== 'manual') ||
            (revision.origin !== 'model' && revision.origin !== 'user') ||
            typeof revision.createdAt !== 'string' || !Number.isFinite(Date.parse(revision.createdAt)) ||
            !Number.isInteger(revision.completedTurns) || revision.completedTurns < 0 ||
            (revision.leafId !== null && !/^[0-9a-f-]{36}$/.test(revision.leafId))) continue;
        revision.title = conversationTitle(revision.title);
        revisions.push(revision);
      } catch { /* Incomplete synced title revisions do not hide the chat. */ }
    }
    return applyTitleRevisions(session, revisions);
  }
  async saveTitle(session: Session, title: string, mode: 'auto' | 'manual', origin: 'model' | 'user',
    completedTurns: number, leafId: string | null): Promise<Session> {
    const revision: TitleRevision = { schemaVersion: 1, id: newId(), sessionId: session.id,
      parentRevisionId: session.titleRevisionId ?? null, title: conversationTitle(title), mode, origin,
      completedTurns, leafId, createdAt: new Date().toISOString() };
    await this.writeSnapshot(`${ROOT}/会话/${session.id}/标题/${revision.id}.json`, JSON.stringify(revision, null, 2));
    return this.sessionTitle(session);
  }
  async createConcept(title: string, id: string, content: string): Promise<string> {
    const folder = `${ROOT}/概念`;
    await this.folder(folder);
    const primary = `${folder}/${safeNoteTitle(title)}.md`;
    let path = primary;
    const existing = await this.kind(primary);
    if (existing && (existing !== 'file' || await this.text(primary) !== content)) {
      path = `${folder}/${safeNoteTitle(title)}（${id.slice(0, 8)}）.md`;
    }
    await this.writeSnapshot(path, content);
    return path;
  }
  async noteRevisions(sessionId: string): Promise<NoteRevision[]> {
    if (!NOTE_UUID.test(sessionId)) throw revisionError();
    const folder = `${ROOT}/会话/${sessionId}/笔记修订`;
    if (await this.kind(folder) !== 'folder') return [];
    const revisions: NoteRevision[] = [];
    for (const path of (await this.app.vault.adapter.list(folder)).files) {
      if (!path.endsWith('.json')) continue;
      let revision: NoteRevision;
      try { revision = validateNoteRevision(JSON.parse(await this.text(path))); }
      catch { throw revisionError(); }
      if (revision.sessionId !== sessionId || path !== `${folder}/${revision.id}.json`) throw revisionError();
      revisions.push(revision);
    }
    return revisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async saveNoteRevision(revision: NoteRevision): Promise<void> {
    const valid = validateNoteRevision(revision);
    await this.writeSnapshot(`${ROOT}/会话/${valid.sessionId}/笔记修订/${valid.id}.json`, JSON.stringify(valid, null, 2));
  }
  async noteCandidates(sessionId: string, branch: Message[]): Promise<NoteCandidate[]> {
    const revisions = await this.noteRevisions(sessionId);
    const grouped = new Map<string, NoteRevision[]>();
    for (const revision of revisions) grouped.set(revision.noteId, [...(grouped.get(revision.noteId) ?? []), revision]);
    const lineages = new Map([...grouped].map(([noteId, entries]) => [noteId, noteLineage(entries)]));
    const ids = branch.map(message => message.id);
    const candidates: NoteCandidate[] = [];
    const identityCounts = new Map<string, number>();
    // Inspect current files, including moved notes. Verify disk contents even when
    // the cache is absent or still points at an earlier frontmatter revision.
    const files = this.app.vault.getMarkdownFiles().filter(file => conceptBodyPath(file.path));
    files.sort((a, b) => {
      const priority = (file: TFile) => this.app.metadataCache?.getFileCache(file)?.frontmatter?.session_id === sessionId ? 0 : 1;
      return priority(a) - priority(b) || a.path.localeCompare(b.path);
    });
    for (const file of files) {
      const identity = conceptIdentity(await this.app.vault.read(file));
      if (!identity) continue;
      identityCounts.set(identity.noteId, (identityCounts.get(identity.noteId) ?? 0) + 1);
      if (identity.sessionId !== sessionId || !safeConceptPath(file.path)) continue;
      const { revision, unavailableReason } = lineages.get(identity.noteId) ?? {};
      let matchingBranch = false;
      if (revision) {
        const prefix = branch.slice(0, revision.coveredMessageIds.length);
        matchingBranch = prefix.length === revision.coveredMessageIds.length &&
          prefix.every((message, index) => message.sessionId === sessionId && message.id === revision.coveredMessageIds[index]) &&
          await noteSourceHash(prefix) === revision.sourceHash;
      } else if (!unavailableReason) matchingBranch = ids.includes(identity.leafId) && branch.every(message => message.sessionId === sessionId);
      candidates.push({ ...identity, path: file.path, title: file.basename, matchingBranch,
        ...(revision ? { leafId: revision.leafId, revision } : {}), ...(unavailableReason ? { unavailableReason } : {}) });
    }
    for (const candidate of candidates) {
      if ((identityCounts.get(candidate.noteId) ?? 0) > 1) {
        candidate.matchingBranch = false;
        candidate.duplicateIdentity = true;
        candidate.unavailableReason = '笔记标识重复，无法确定各副本的整理进度；请保存为新笔记。';
      }
    }
    return candidates.sort((a, b) => Number(b.matchingBranch) - Number(a.matchingBranch) || a.path.localeCompare(b.path));
  }
  async readConceptNote(candidate: NoteCandidate): Promise<{ file: TFile; path: string; content: string }> {
    if (!NOTE_UUID.test(candidate.noteId) || !NOTE_UUID.test(candidate.sessionId)) throw revisionError();
    const matches: { file: TFile; path: string; content: string }[] = [];
    let identities = 0;
    const files = this.app.vault.getMarkdownFiles().filter(file => conceptBodyPath(file.path));
    files.sort((a, b) => Number(b.path === candidate.path) - Number(a.path === candidate.path));
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const identity = conceptIdentity(content);
      if (identity?.noteId !== candidate.noteId) continue;
      identities++;
      if (identity.sessionId === candidate.sessionId && safeConceptPath(file.path)) matches.push({ file, path: file.path, content });
    }
    if (identities > 1) throw new Error('找到多篇同一标识的笔记，无法确定整理进度；请保存为新笔记。');
    if (!matches.length) throw new Error('找不到原笔记，可能尚未同步完整或已移除标识；仍可保存为新笔记。');
    return matches[0];
  }
  async updateConceptNote(candidate: NoteCandidate, expectedContent: string, content: string,
    revision: NoteRevision): Promise<string> {
    const valid = validateNoteRevision(revision);
    if (candidate.duplicateIdentity) throw new Error('找到多篇同一标识的笔记，无法确定整理进度；请保存为新笔记。');
    if (!candidate.matchingBranch || valid.mode !== 'update' || valid.noteId !== candidate.noteId ||
        valid.sessionId !== candidate.sessionId) throw new Error('这篇笔记不属于当前讨论分支，请保存为新笔记。');
    const desiredIdentity = conceptIdentity(content), expectedIdentity = conceptIdentity(expectedContent);
    if (desiredIdentity?.noteId !== candidate.noteId || desiredIdentity.sessionId !== candidate.sessionId ||
        expectedIdentity?.noteId !== candidate.noteId ||
        expectedIdentity.sessionId !== candidate.sessionId) {
      throw new Error('更新内容的笔记标识不一致，已停止覆盖。');
    }
    const current = await this.readConceptNote(candidate);
    const lineage = noteLineage((await this.noteRevisions(valid.sessionId)).filter(entry => entry.noteId === valid.noteId));
    if (lineage.unavailableReason) throw new Error(lineage.unavailableReason);
    if (lineage.revision ? lineage.revision.id !== valid.id && lineage.revision.id !== valid.previousRevisionId : valid.previousRevisionId) {
      throw new Error('笔记整理进度在预览后发生了变化，请等待同步后重新整理。');
    }
    const folder = `${ROOT}/会话/${valid.sessionId}`;
    const revisionPath = `${folder}/笔记修订/${valid.id}.json`;
    const contentHash = await noteContentHash(content);
    let saved: NoteRevision | null = null;
    if (await this.kind(revisionPath)) {
      try { saved = validateNoteRevision(JSON.parse(await this.text(revisionPath))); }
      catch { throw revisionError(); }
      const expected = { ...valid, path: saved.path, contentHash };
      if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error('同一整理记录已存在不同内容，已停止覆盖。');
    }
    // The backup is immutable and stores the exact original Markdown, including
    // manual edits and frontmatter. A conflict can leave an unused backup safely.
    await this.writeSnapshot(`${folder}/笔记版本/${valid.id}.md`, expectedContent);
    await this.app.vault.process(current.file, actual => {
      const identity = conceptIdentity(actual);
      if (!safeConceptPath(current.file.path) || identity?.noteId !== candidate.noteId ||
          identity.sessionId !== candidate.sessionId) throw new Error('原笔记的路径或标识已变更，已停止覆盖。');
      if (actual === content) return actual;
      if (saved || actual !== expectedContent) throw new Error('原笔记在预览后发生了修改，请重新整理，已保留当前内容。');
      return content;
    });
    if (!saved) await this.saveNoteRevision({ ...valid, path: current.file.path, contentHash });
    return current.file.path;
  }
  async contextSummaries(sessionId: string): Promise<ContextSummary[]> {
    const folder = `${ROOT}/会话/${sessionId}/上下文`;
    if (await this.kind(folder) !== 'folder') return [];
    const summaries: ContextSummary[] = [];
    for (const path of (await this.app.vault.adapter.list(folder)).files) {
      if (!path.endsWith('.json')) continue;
      try {
        const summary = validateContextSummary(JSON.parse(await this.text(path)));
        if (summary.sessionId === sessionId && path === `${folder}/${summary.id}.json`) summaries.push(summary);
      } catch { /* Ignore incomplete or invalid synced summaries; original messages remain authoritative. */ }
    }
    return summaries;
  }
  async saveContextSummary(summary: ContextSummary): Promise<void> {
    const valid = validateContextSummary(summary);
    await this.writeSnapshot(`${ROOT}/会话/${valid.sessionId}/上下文/${valid.id}.json`, JSON.stringify(valid, null, 2));
  }
  async writeSnapshot(path: string, content: string): Promise<void> {
    await this.folder(path.slice(0, path.lastIndexOf('/')));
    const existing = await this.kind(path);
    if (existing) {
      if (existing !== 'file' || await this.text(path) !== content) {
        throw new Error('目标文件已存在不同内容，已停止覆盖。');
      }
      return;
    }
    try { await this.app.vault.create(path, content); }
    catch (error) {
      if (await this.kind(path) !== 'file' || await this.text(path) !== content) throw error;
    }
  }
  async saveMessage(message: Message): Promise<void> {
    if (message.status === 'streaming') throw new Error('生成中的消息应保存在本机草稿中。');
    const path = `${ROOT}/会话/${message.sessionId}/消息/${message.id}.json`;
    const serialized = JSON.stringify(message, null, 2);
    const existing = await this.kind(path);
    if (existing === 'folder') throw new Error(`消息路径被目录占用：${path}`);
    if (existing === 'file') {
      const old = await this.text(path);
      if (old !== serialized) throw new Error('同一消息 ID 已存在不同内容，已停止覆盖。');
      return;
    }
    try { await this.app.vault.create(path, serialized); }
    catch (error) {
      // A concurrent recovery can create the same immutable message.
      if (await this.kind(path) !== 'file' || await this.text(path) !== serialized) throw error;
    }
  }
  async sessions(): Promise<Session[]> {
    // JSON visibility settings must not determine whether saved chats are found.
    const folders = (await this.app.vault.adapter.list(`${ROOT}/会话`)).folders;
    const result: Session[] = [];
    for (const folder of folders) {
      if (!/^[0-9a-f-]{36}$/.test(folder.split('/').pop() ?? '')) continue;
      const path = `${folder}/会话.json`;
      try {
        const entry = JSON.parse(await this.text(path)) as Session;
        if (entry.schemaVersion === 1 && typeof entry.id === 'string' &&
            typeof entry.createdAt === 'string' && typeof entry.title === 'string' &&
            path === `${ROOT}/会话/${entry.id}/会话.json`) result.push(await this.sessionTitle(entry));
      } catch { /* A synchronizing or malformed record is not opened. */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async messages(sessionId: string): Promise<Message[]> {
    const prefix = `${ROOT}/会话/${sessionId}/消息/`;
    const files = (await this.app.vault.adapter.list(prefix.slice(0, -1))).files.filter(path => path.endsWith('.json'));
    const messages: Message[] = [];
    for (const path of files) {
      let entry: Message;
      try { entry = JSON.parse(await this.text(path)) as Message; }
      catch { throw new Error('消息文件尚未同步完整，请稍后重试。'); }
      if (entry.schemaVersion !== 1 || entry.sessionId !== sessionId ||
          !/^[0-9a-f-]{36}$/.test(entry.id) || typeof entry.content !== 'string' ||
          (entry.role !== 'user' && entry.role !== 'assistant') ||
          typeof entry.createdAt !== 'string' || path !== `${prefix}${entry.id}.json`) {
        throw new Error('发现无效的会话记录，已停止加载。');
      }
      if (entry.noteQuote !== undefined) {
        try {
          if (entry.role !== 'user') throw new Error('引用只能附在用户消息上。');
          entry.noteQuote = noteQuote(entry.noteQuote.text, entry.noteQuote.path, entry.noteQuote.title);
        } catch { throw new Error('消息中的笔记引用尚未同步完整或格式不正确，请稍后重试。'); }
      }
      messages.push(entry);
    }
    return messages;
  }
}
