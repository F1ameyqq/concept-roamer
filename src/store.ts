import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { Message, Session } from './model';
import { safeNoteTitle } from './organize';

export const ROOT = '概念漫游';
export const PERSONA = `${ROOT}/人格.md`;
export const MEMORY = `${ROOT}/全局记忆.md`;

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
            path === `${ROOT}/会话/${entry.id}/会话.json`) result.push(entry);
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
      messages.push(entry);
    }
    return messages;
  }
}
