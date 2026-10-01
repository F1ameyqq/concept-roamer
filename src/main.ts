import {
  App, Component, ItemView, MarkdownRenderer, Modal, Notice, Platform, Plugin,
  PluginSettingTab, SecretComponent, Setting, SuggestModal, WorkspaceLeaf,
} from 'obsidian';
import { Message, Session, newId, leafMessages, messageChain, contextMessages } from './model';
import { MEMORY, PERSONA, ROOT, VaultStore } from './store';
import { abortError, streamBrowser, streamNode, StreamRequest } from './transport';
import { conversationTitle, parseConversationTitle, provisionalTitle, titleMessages } from './titles';
import {
  ConceptDraft, OrganizationInput, RelatedNote, conceptBody, conceptMarkdown, noteScore,
  organizationMessages, parseConceptResult, safeNoteTitle, summaryMarkdown, summaryPath,
} from './organize';

const VIEW = 'concept-roamer-chat';
const DRAFT = 'concept-roamer:pending-v1';
const ACTIVE = 'concept-roamer:active-v1';
const CONCEPT_DRAFT = 'concept-roamer:concept-draft-v1';

interface Settings {
  secretName: string;
  model: string;
  thinking: boolean;
  transport: 'auto' | 'browser';
  automaticTitles: boolean;
}
const DEFAULTS: Settings = {
  secretName: 'concept-roamer-deepseek', model: 'deepseek-flash', thinking: false, transport: 'auto',
  automaticTitles: true,
};

type ChatState = 'idle' | 'connecting' | 'streaming' | 'saving';
const STATUS: Record<Message['status'], string> = {
  complete: '完成', streaming: '生成中', stopped: '已停止', interrupted: '中断恢复',
  truncated: '达到输出限制', error: '请求失败',
};

export default class ConceptRoamer extends Plugin {
  settings: Settings = { ...DEFAULTS };
  store!: VaultStore;
  session: Session | null = null;
  messages: Message[] = [];
  activeLeaf: string | null = null;
  state: ChatState = 'idle';
  status = '准备好后，从一个问题开始。';
  ready!: Promise<void>;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private pending: Message | null = null;
  private unloading = false;
  private draftAt = 0;
  private titleJobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  conceptDraft: ConceptDraft | null = null;

  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    const fields = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
    this.settings = {
      secretName: typeof fields.secretName === 'string' ? fields.secretName : DEFAULTS.secretName,
      model: typeof fields.model === 'string' ? fields.model : DEFAULTS.model,
      thinking: typeof fields.thinking === 'boolean' ? fields.thinking : DEFAULTS.thinking,
      transport: fields.transport === 'browser' ? 'browser' : 'auto',
      automaticTitles: typeof fields.automaticTitles === 'boolean' ? fields.automaticTitles : DEFAULTS.automaticTitles,
    };
    this.store = new VaultStore(this.app);
    this.registerView(VIEW, leaf => new ChatView(leaf, this));
    this.addSettingTab(new RoamerSettings(this.app, this));
    this.addRibbonIcon('messages-square', '打开概念漫游', () => { void this.openChat(false); });
    this.addCommand({ id: 'open-chat', name: '打开聊天', callback: () => { void this.openChat(false); } });
    this.addCommand({
      id: 'open-floating-chat', name: '打开桌面悬浮聊天窗',
      checkCallback: checking => {
        if (!Platform.isDesktopApp) return false;
        if (!checking) void this.openChat(true);
        return true;
      },
    });
    this.addCommand({ id: 'open-persona', name: '编辑人格', callback: () => { void this.openNote(PERSONA); } });
    this.addCommand({ id: 'open-memory', name: '编辑全局记忆', callback: () => { void this.openNote(MEMORY); } });
    this.addCommand({ id: 'organize-concept', name: '整理并保存概念笔记', callback: () => { void this.openOrganizer(); } });
    this.addCommand({ id: 'rename-conversation', name: '修改当前会话标题', callback: () => { void this.openTitleEditor(); } });
    this.ready = new Promise<void>((resolve, reject) => {
      this.app.workspace.onLayoutReady(() => {
        if (this.unloading) { reject(new Error('插件已关闭。')); return; }
        void this.initialize().then(resolve, reject);
      });
    }).catch(error => {
      this.status = `初始化失败：${this.safeError(error)}`;
      this.emit();
      throw error;
    });
    // Avoid an unhandled rejection before a view consumes ready.
    void this.ready.catch(() => undefined);
  }

  onunload(): void {
    this.unloading = true;
    if (this.pending) this.app.saveLocalStorage(DRAFT, this.pending);
    this.controller?.abort();
    this.titleJobs.forEach(job => job.controller.abort());
    this.listeners.clear();
  }

  private async initialize(): Promise<void> {
    await this.store.initialize();
    const concept = this.app.loadLocalStorage(CONCEPT_DRAFT) as ConceptDraft | null;
    if (concept?.schemaVersion === 1 && /^[0-9a-f-]{36}$/.test(concept.id) &&
        /^[0-9a-f-]{36}$/.test(concept.input?.sessionId) && /^[0-9a-f-]{36}$/.test(concept.input?.leafId) &&
        Array.isArray(concept.input?.messages) && Array.isArray(concept.input?.relatedNotes)) {
      try {
        concept.result = parseConceptResult(JSON.stringify(concept.result), concept.input);
        if (concept.savedNote && (!concept.savedNote.path.startsWith(`${ROOT}/概念/`) ||
            concept.savedNote.path.includes('..') || typeof concept.savedNote.content !== 'string')) {
          delete concept.savedNote;
        }
        this.conceptDraft = concept;
      } catch { this.status = '上次整理草稿无法读取，原会话仍可使用。'; }
    }
    const draft = this.app.loadLocalStorage(DRAFT) as Message | null;
    if (draft?.schemaVersion === 1 && /^[0-9a-f-]{36}$/.test(draft.id) &&
        /^[0-9a-f-]{36}$/.test(draft.sessionId) && draft.role === 'assistant' &&
        typeof draft.content === 'string') {
      const path = `${ROOT}/会话/${draft.sessionId}/消息/${draft.id}.json`;
      if (!await this.app.vault.adapter.exists(path)) {
        await this.store.saveMessage(draft.status === 'streaming'
          ? { ...draft, status: 'interrupted', error: '上次会话中断，已恢复本机草稿。' }
          : draft);
      }
      this.app.saveLocalStorage(DRAFT, null);
      this.status = '已恢复上次中断的回复。';
    }
    const sessions = await this.store.sessions();
    const active = this.app.loadLocalStorage(ACTIVE) as { sessionId?: string; leafId?: string } | null;
    const selected = sessions.find(session => session.id === active?.sessionId) ?? sessions[0];
    if (selected) await this.loadSession(selected, active?.leafId);
    this.emit();
    void this.updateAutomaticTitle().catch(() => undefined);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { if (!this.unloading) this.listeners.forEach(listener => listener()); }

  chain(): Message[] {
    return this.activeLeaf ? messageChain(this.messages, this.activeLeaf) : [];
  }

  async openChat(popout: boolean): Promise<void> {
    try {
      await this.ready;
      let leaf: WorkspaceLeaf;
      if (popout && Platform.isDesktopApp) leaf = this.app.workspace.openPopoutLeaf();
      else leaf = this.app.workspace.getLeavesOfType(VIEW)[0] ??
        (Platform.isMobileApp ? this.app.workspace.getLeaf('tab') :
          this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab'));
      await leaf.setViewState({ type: VIEW, active: true });
      await this.app.workspace.revealLeaf(leaf);
      if (popout) new Notice('可在此窗口的命令面板使用“切换窗口置顶 / Toggle always on top”。', 8000);
    } catch (error) { new Notice(this.safeError(error)); }
  }

  async openNote(path: string): Promise<void> {
    try { await this.ready; await this.app.workspace.openLinkText(path, '', true); }
    catch (error) { new Notice(this.safeError(error)); }
  }

  async newSession(): Promise<void> {
    await this.ready;
    if (this.state !== 'idle') throw new Error('请等待回复保存完成，再创建新会话。');
    if (this.pending) throw new Error('请先重试保存当前回复。');
    const session: Session = { schemaVersion: 1, id: newId(), title: '新的探索', createdAt: new Date().toISOString() };
    await this.store.createSession(session);
    this.session = session;
    this.messages = [];
    this.activeLeaf = null;
    this.saveActive();
    this.status = '新的会话已建立。';
    this.emit();
  }

  private saveActive(): void {
    this.app.saveLocalStorage(ACTIVE, { sessionId: this.session?.id, leafId: this.activeLeaf });
  }

  private async loadSession(session: Session, preferredLeaf?: string): Promise<void> {
    const messages = await this.store.messages(session.id);
    const leaves = leafMessages(messages).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    let activeLeaf: string | null = null;
    if (preferredLeaf && leaves.some(leaf => leaf.id === preferredLeaf)) activeLeaf = preferredLeaf;
    else if (leaves.length === 1) activeLeaf = leaves[0].id;
    else if (leaves.length > 1) this.status = '此会话有多个分支，请选择一个分支继续。';
    if (activeLeaf) messageChain(messages, activeLeaf);
    this.session = session;
    this.messages = messages;
    this.activeLeaf = activeLeaf;
    this.saveActive();
  }

  async chooseSession(): Promise<void> {
    await this.ready;
    if (this.state !== 'idle') throw new Error('请等待回复保存完成，再切换会话。');
    if (this.pending) throw new Error('请先重试保存当前回复。');
    const sessions = await this.store.sessions();
    if (!sessions.length) { new Notice('还没有保存的会话。'); return; }
    new Picker(this.app, sessions,
      session => `${session.title} · ${new Date(session.createdAt).toLocaleString()}`,
      async session => {
        try { await this.loadSession(session); this.emit(); void this.updateAutomaticTitle().catch(() => undefined); }
        catch (error) { new Notice(this.safeError(error)); }
      }).open();
  }

  async chooseBranch(): Promise<void> {
    if (this.state !== 'idle' || !this.session) return;
    if (this.pending) throw new Error('请先重试保存当前回复。');
    this.messages = await this.store.messages(this.session.id);
    const leaves = leafMessages(this.messages);
    if (!leaves.length) return;
    new Picker(this.app, leaves,
      message => `${message.role === 'user' ? '我' : 'AI'}：${message.content.slice(0, 55)} · ${STATUS[message.status]}`,
      message => {
        try { messageChain(this.messages, message.id); this.activeLeaf = message.id; this.saveActive(); this.emit(); }
        catch (error) { new Notice(this.safeError(error)); }
      }).open();
  }

  stop(): void {
    if (this.controller && (this.state === 'connecting' || this.state === 'streaming')) {
      this.status = this.pending ? '正在停止网络请求并保存已收到的回复…' : '正在停止当前请求…';
      this.controller.abort();
      this.emit();
    }
  }

  async send(content: string): Promise<boolean> {
    await this.ready;
    const text = content.trim();
    if (!text || this.state !== 'idle') return false;
    const key = this.app.secretStorage?.getSecret(this.settings.secretName);
    if (!key) throw new Error('请先在“设置 → 概念漫游”中选择 DeepSeek API Key。');
    if (!this.settings.model.trim()) throw new Error('请先填写模型名称。');
    if (text.length > 20_000) throw new Error('本验证版单条输入限 20,000 字符。');
    if (this.session && this.messages.length && !this.activeLeaf) throw new Error('请先选择会话分支。');
    if (this.pending) throw new Error('有尚未保存的回复，请先点击“重试保存”。');

    const controller = new AbortController();
    this.controller = controller;
    this.state = 'connecting';
    this.status = '准备上下文…';
    this.emit();
    let accepted = false;
    let timedOut = false;
    let timer: number | undefined;
    let savedCompleteReply = false;
    try {
      const [persona, memory] = await Promise.all([this.store.text(PERSONA), this.store.text(MEMORY)]);
      if (controller.signal.aborted) throw abortError();
      if (persona.length > 8_000 || memory.length > 8_000) {
        throw new Error('人格或记忆超过验证版的 8,000 字符限制，请精简后再发送。');
      }
      if (!this.session) {
        const session: Session = { schemaVersion: 1, id: newId(), title: provisionalTitle(text), createdAt: new Date().toISOString() };
        await this.store.createSession(session);
        this.session = session;
        this.messages = [];
        this.activeLeaf = null;
      }
      const history = contextMessages(this.chain());
      if (history.reduce((sum, message) => sum + message.content.length, text.length) > 80_000) {
        throw new Error('此会话超过验证版的上下文预算，请新建会话。自动摘要将在下一阶段加入。');
      }
      const user: Message = {
        schemaVersion: 1, id: newId(), sessionId: this.session.id, parentId: this.activeLeaf,
        role: 'user', content: text, status: 'complete', createdAt: new Date().toISOString(),
      };
      await this.store.saveMessage(user);
      accepted = true;
      this.messages.push(user);
      if (this.session.title === '新的探索' && !this.session.titleRevisionId) this.session.title = provisionalTitle(text);
      this.activeLeaf = user.id;
      this.saveActive();
      const assistant: Message = {
        schemaVersion: 1, id: newId(), sessionId: this.session.id, parentId: user.id,
        role: 'assistant', content: '', status: 'streaming', createdAt: new Date().toISOString(),
        model: this.settings.model.trim(),
      };
      this.pending = assistant;
      this.messages.push(assistant);
      this.activeLeaf = assistant.id;
      this.saveActive();
      this.saveDraft(true);
      timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 300_000);
      const desktop = Platform.isDesktopApp && this.settings.transport === 'auto';
      this.status = `连接 DeepSeek · ${desktop ? '桌面流式传输' : 'Web 流式传输'}`;
      this.emit();
      let finishReason: string | undefined;
      const input = {
        url: 'https://api.deepseek.com/chat/completions', apiKey: key,
        signal: controller.signal,
        payload: {
          model: this.settings.model.trim(),
          messages: [
            { role: 'system', content: `${persona}\n\n用户明确保存的背景与偏好：\n${memory}` },
            ...history, { role: 'user', content: text },
          ],
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 8192,
          thinking: { type: this.settings.thinking ? 'enabled' : 'disabled' },
        },
        onDelta: (delta: import('./sse').StreamDelta) => {
          this.state = 'streaming';
          if (delta.content) assistant.content += delta.content;
          if (delta.usage) assistant.usage = delta.usage;
          if (delta.finishReason) finishReason = delta.finishReason;
          this.status = delta.reasoning && !assistant.content ? '正在思考…' : '正在接收回复…';
          this.saveDraft(false);
          this.emit();
        },
      };
      try {
        await this.streamRequest(input);
        if (finishReason === 'length') assistant.status = 'truncated';
        else if (finishReason !== 'stop') {
          assistant.status = 'error';
          assistant.error = `回复未正常完成：${finishReason ?? '缺少结束状态'}。`;
        } else if (!assistant.content.trim()) {
          assistant.status = 'error';
          assistant.error = '服务返回了空回复。';
        } else assistant.status = 'complete';
      } catch (error) {
        const aborted = controller.signal.aborted;
        assistant.status = aborted && !timedOut ? 'stopped' : 'error';
        assistant.error = timedOut ? '请求超过 5 分钟，已停止并保留文字。' :
          aborted ? '已停止生成。' : this.safeError(error);
      }
      // A newly loaded plugin will recover the local draft; the old instance must
      // not race that recovery by writing a different status for the same ID.
      if (this.unloading) {
        this.saveDraft(true);
        return accepted;
      }
      if (timer) window.clearTimeout(timer);
      this.controller = null;
      this.state = 'saving';
      this.saveDraft(true);
      this.status = '保存回复…';
      this.emit();
      await this.store.saveMessage(assistant);
      this.pending = null;
      savedCompleteReply = assistant.status === 'complete';
      this.app.saveLocalStorage(DRAFT, null);
      this.status = assistant.error ?? (assistant.status === 'truncated' ? '回复达到输出限制，已保留。' : '回复已保存。');
    } catch (error) {
      this.status = this.safeError(error);
      if (!accepted) throw error;
      new Notice(`保存遇到问题：${this.status}。可点击“重试保存”。`, 10000);
    } finally {
      if (timer) window.clearTimeout(timer);
      this.controller = null;
      this.state = 'idle';
      this.emit();
      if (savedCompleteReply && !this.unloading) void this.updateAutomaticTitle().catch(() => undefined);
    }
    return accepted;
  }

  private saveDraft(force: boolean): void {
    if (!this.pending) return;
    const now = Date.now();
    if (force || now - this.draftAt > 500) {
      this.app.saveLocalStorage(DRAFT, this.pending);
      this.draftAt = now;
    }
  }

  async retrySave(): Promise<void> {
    if (!this.pending || this.state !== 'idle') return;
    if (this.pending.status === 'streaming') this.pending.status = 'interrupted';
    const savedCompleteReply = this.pending.status === 'complete';
    await this.store.saveMessage(this.pending);
    this.pending = null;
    this.app.saveLocalStorage(DRAFT, null);
    this.status = '回复已保存。';
    this.emit();
    if (savedCompleteReply && !this.unloading) void this.updateAutomaticTitle().catch(() => undefined);
  }

  async updateAutomaticTitle(): Promise<void> {
    await this.ready;
    if (!this.settings.automaticTitles || this.unloading || !this.session || this.pending) return;
    const session = { ...this.session };
    const chain = this.chain().map(message => ({ ...message }));
    const last = chain[chain.length - 1];
    if (last?.role !== 'assistant' || last.status !== 'complete') return;
    const existing = this.titleJobs.get(session.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.generateTitle(session, chain, controller).catch(() => {
      // Naming failures must not turn a saved reply into an error or block chat.
    }).finally(() => { if (this.titleJobs.get(session.id)?.controller === controller) this.titleJobs.delete(session.id); });
    this.titleJobs.set(session.id, { controller, promise });
    return promise;
  }

  private async generateTitle(session: Session, chain: Message[], controller: AbortController): Promise<void> {
    const current = await this.store.sessionTitle(session);
    const turns = chain.filter(message => message.role === 'assistant' && message.status === 'complete').length;
    if (current.titleMode === 'manual' || (current.titleCompletedTurns !== undefined &&
        (current.titleLeafId === chain[chain.length - 1].id || turns < current.titleCompletedTurns + 3))) return;
    const key = this.app.secretStorage?.getSecret(this.settings.secretName);
    if (!key || controller.signal.aborted || !this.settings.automaticTitles) return;
    let raw = '';
    let finishReason: string | undefined;
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      await this.streamRequest({
        url: 'https://api.deepseek.com/chat/completions', apiKey: key, signal: controller.signal,
        payload: { model: this.settings.model.trim(), messages: titleMessages(chain, current.title),
          stream: true, response_format: { type: 'json_object' }, max_tokens: 128,
          thinking: { type: 'disabled' } },
        onDelta: delta => {
          if (delta.content) raw += delta.content;
          if (raw.length > 2000) controller.abort();
          if (delta.finishReason) finishReason = delta.finishReason;
        },
      });
      if (controller.signal.aborted || this.unloading || !this.settings.automaticTitles || finishReason !== 'stop') return;
      const title = parseConversationTitle(raw);
      const latest = await this.store.sessionTitle(session);
      if (controller.signal.aborted || latest.titleMode === 'manual' || latest.titleRevisionId !== current.titleRevisionId) return;
      const updated = await this.store.saveTitle(latest, title, 'auto', 'model', turns, chain[chain.length - 1].id);
      if (!this.unloading && this.session?.id === session.id) { this.session = updated; this.emit(); }
    } finally { window.clearTimeout(timer); }
  }

  async setAutomaticTitles(enabled: boolean): Promise<void> {
    this.settings.automaticTitles = enabled;
    if (!enabled) this.titleJobs.forEach(job => job.controller.abort());
    await this.saveData(this.settings);
  }

  async renameSession(title: string, automatic: boolean, expectedId = this.session?.id): Promise<void> {
    await this.ready;
    if (!this.session || this.session.id !== expectedId) throw new Error('会话已切换，请重新打开标题编辑。');
    title = conversationTitle(title);
    const session = await this.store.sessionTitle(this.session);
    this.titleJobs.get(session.id)?.controller.abort();
    const chain = this.chain();
    const turns = chain.filter(message => message.role === 'assistant' && message.status === 'complete').length;
    const updated = await this.store.saveTitle(session, title, automatic ? 'auto' : 'manual', 'user',
      automatic ? 0 : turns, automatic ? null : this.activeLeaf);
    if (this.session?.id === session.id) { this.session = updated; this.emit(); }
  }

  async openTitleEditor(): Promise<void> {
    try {
      await this.ready;
      if (!this.session) throw new Error('请先开始一个会话。');
      new TitleModal(this.app, this, this.session).open();
    } catch (error) { new Notice(this.safeError(error)); }
  }

  hasPendingSave(): boolean { return !!this.pending && this.state === 'idle'; }

  private async streamRequest(input: StreamRequest): Promise<void> {
    if (Platform.isDesktop && Platform.isDesktopApp && this.settings.transport === 'auto') {
      const https = await import('https');
      await streamNode(input, https.request);
    } else await streamBrowser(input);
  }

  async openOrganizer(): Promise<void> {
    try {
      await this.ready;
      if (this.state !== 'idle' || this.pending) throw new Error('请先等待当前回复保存完成。');
      if (!this.session || !this.chain().some(message => message.role === 'assistant' && message.status === 'complete')) {
        throw new Error('请先完成一次概念讨论，再整理笔记。');
      }
      new ConceptModal(this.app, this).open();
    } catch (error) { new Notice(this.safeError(error)); }
  }

  private async relatedNotes(query: string): Promise<RelatedNote[]> {
    const ranked = this.app.vault.getMarkdownFiles().filter(file =>
      !file.path.split('/').some(part => part.startsWith('.')) && !/[[\]|#^]/.test(file.path) &&
      !file.path.startsWith(`${ROOT}/会话/`) && !file.path.startsWith(`${ROOT}/导出/`) &&
      file.path !== PERSONA && file.path !== MEMORY)
      .map(file => {
        const title = file.basename ?? file.name.replace(/\.md$/, '');
        const rawAliases: unknown = this.app.metadataCache?.getFileCache(file)?.frontmatter?.aliases;
        const aliases = Array.isArray(rawAliases) ? rawAliases.filter((value): value is string => typeof value === 'string') :
          typeof rawAliases === 'string' ? [rawAliases] : [];
        return { file, title, score: noteScore(title, aliases, query) };
      }).filter(item => item.score >= 2).sort((a, b) => b.score - a.score).slice(0, 8);
    const notes = await Promise.all(ranked.map(async item => {
      try { return { path: item.file.path, title: item.title, excerpt: (await this.store.text(item.file.path)).slice(0, 900) }; }
      catch { return null; }
    }));
    return notes.filter((note): note is RelatedNote => note !== null);
  }

  async generateConcept(focus = '', onProgress?: (characters: number) => void): Promise<ConceptDraft> {
    await this.ready;
    if (this.state !== 'idle' || this.pending) throw new Error('请先等待当前回复保存完成。');
    if (this.conceptDraft?.savedNote) throw new Error('请先继续保存上一份笔记的摘要，再开始新的整理。');
    if (!this.session || !this.activeLeaf) throw new Error('请先选择一个完整的会话分支。');
    const messages = this.chain().filter(message => message.role === 'user' || message.status === 'complete')
      .map(message => ({ ...message }));
    if (!messages.some(message => message.role === 'assistant')) throw new Error('请先完成一次概念讨论。');
    if (messages.reduce((sum, message) => sum + message.content.length, 0) > 100_000) {
      throw new Error('本次讨论超过整理预算，请选择较短的会话分支。');
    }
    if (focus.length > 300) throw new Error('请用简短的概念名称指定整理主题。');
    const key = this.app.secretStorage?.getSecret(this.settings.secretName);
    if (!key) throw new Error('请先配置 DeepSeek API Key。');
    if (!this.settings.model.trim()) throw new Error('请先填写模型名称。');
    const controller = new AbortController();
    this.controller = controller;
    this.state = 'connecting';
    this.status = '寻找相关笔记，准备整理…';
    this.emit();
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 300_000);
    let raw = '';
    let finishReason: string | undefined;
    try {
      const query = `${focus}\n${messages.filter(message => message.role === 'user').map(message => message.content).join('\n').slice(-5000)}`;
      const input: OrganizationInput = {
        sessionId: this.session.id, leafId: this.activeLeaf, messages,
        focus: focus.trim(), relatedNotes: await this.relatedNotes(query),
      };
      if (controller.signal.aborted) throw abortError();
      const model = this.settings.model.trim();
      await this.streamRequest({
        url: 'https://api.deepseek.com/chat/completions', apiKey: key, signal: controller.signal,
        payload: {
          model, messages: organizationMessages(input), stream: true, stream_options: { include_usage: true },
          max_tokens: 8192, thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
        },
        onDelta: delta => {
          this.state = 'streaming';
          raw += delta.content ?? '';
          if (raw.length > 200_000) throw new Error('整理结果超过大小限制，已停止读取。');
          if (delta.finishReason) finishReason = delta.finishReason;
          this.status = '正在整理概念笔记…';
          onProgress?.(raw.length);
          this.emit();
        },
      });
      if (controller.signal.aborted || this.unloading) throw abortError();
      if (finishReason !== 'stop') throw new Error('整理结果未完整生成，请重新整理。');
      const result = parseConceptResult(raw, input);
      const draft: ConceptDraft = { schemaVersion: 1, id: newId(), createdAt: new Date().toISOString(), model, input, result };
      this.conceptDraft = draft;
      this.app.saveLocalStorage(CONCEPT_DRAFT, draft);
      this.status = '整理完成，请预览并保存概念笔记。';
      return draft;
    } catch (error) {
      this.status = timedOut ? '整理超过 5 分钟，已停止。' : controller.signal.aborted ? '整理已停止。' : this.safeError(error);
      throw new Error(this.status);
    } finally {
      window.clearTimeout(timer);
      this.controller = null;
      this.state = 'idle';
      this.emit();
    }
  }

  async saveConcept(draft: ConceptDraft, title: string, body: string): Promise<string> {
    if (this.state !== 'idle' || this.pending) throw new Error('请先等待当前操作完成。');
    title = safeNoteTitle(title);
    if (!body.trim() || body.length > 150_000) throw new Error('笔记内容为空或超过保存限制。');
    this.state = 'saving';
    this.status = '保存概念笔记与讨论摘要…';
    this.emit();
    try {
      if (!draft.savedNote) {
        const content = conceptMarkdown(draft, title, body);
        const path = await this.store.createConcept(title, draft.id, content);
        draft.savedNote = { path, content };
        this.conceptDraft = draft;
        this.app.saveLocalStorage(CONCEPT_DRAFT, draft);
      }
      await this.store.writeSnapshot(summaryPath(draft), summaryMarkdown(draft, draft.savedNote.path));
      const path = draft.savedNote.path;
      if (this.conceptDraft?.id === draft.id) {
        this.conceptDraft = null;
        this.app.saveLocalStorage(CONCEPT_DRAFT, null);
      }
      this.status = '概念笔记与讨论摘要已保存。';
      return path;
    } catch (error) {
      this.status = draft.savedNote ? '概念笔记已保存，摘要保存失败。请重试保存。' : this.safeError(error);
      throw new Error(this.status);
    } finally { this.state = 'idle'; this.emit(); }
  }

  async exportTranscript(): Promise<void> {
    if (this.state !== 'idle' || !this.session) throw new Error('请在回复保存完成后导出。');
    const chain = this.chain();
    if (!chain.length) throw new Error('请先选择一个有内容的会话分支。');
    const title = this.session.title;
    const content = [
      '---', 'tags: [ai-session]', `session_id: ${this.session.id}`, '---', '',
      `# ${title}`, '', '> 原始对话记录。概念笔记请通过“整理并保存”生成。', '',
      ...chain.flatMap(message => [
        `## ${message.role === 'user' ? '我' : 'AI'} · ${STATUS[message.status]}`, '',
        message.content || '（未收到正文）', '',
        ...(message.error ? [`> 状态：${message.error}`, ''] : []),
      ]),
    ].join('\n');
    const path = `${ROOT}/导出/${this.session.id}-${newId().slice(0, 8)}.md`;
    await this.app.vault.create(path, content);
    await this.app.workspace.openLinkText(path, '', true);
    new Notice('已导出当前分支的 Markdown 对话。');
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error
      ? `${error instanceof TypeError ? '插件运行错误：' : ''}${error.message}` : '操作失败，请重试。';
    // Avoid retaining an API key even if a platform error echoes it.
    const key = this.app.secretStorage?.getSecret(this.settings.secretName);
    return (key ? message.split(key).join('[密钥已隐藏]') : message).slice(0, 500);
  }
}

class ChatView extends ItemView {
  private list!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private saveButton!: HTMLButtonElement;
  private status!: HTMLElement;
  private branchButton!: HTMLButtonElement;
  private latestButton!: HTMLButtonElement;
  private conversationHeading!: HTMLElement;
  private titleButton!: HTMLButtonElement;
  private unsubscribe: (() => void) | undefined;
  private rows = new Map<string, { bubble: HTMLElement; text: HTMLElement; label?: HTMLElement; component: Component; rendered?: string }>();
  private updateTimer: number | undefined;
  private tailSpace!: HTMLElement;
  private pinnedReply: string | null = null;
  private followLatest = false;
  private userScrollUntil = 0;
  private scrollDirection = 0;
  private previousScrollTop = 0;
  private programmaticScrollTop: number | null = null;
  private resizeObserver: ResizeObserver | undefined;

  constructor(leaf: WorkspaceLeaf, private plugin: ConceptRoamer) { super(leaf); }
  getViewType(): string { return VIEW; }
  getDisplayText(): string { return '概念漫游'; }
  getIcon(): string { return 'messages-square'; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('concept-roamer');
    const header = root.createDiv({ cls: 'cr-header' });
    const title = header.createDiv();
    title.createEl('strong', { text: '概念漫游' });
    this.conversationHeading = title.createDiv({ text: '从一个问题，聊到一个新概念', cls: 'cr-subtitle' });
    const tools = root.createDiv({ cls: 'cr-tools' });
    this.button(tools, '新会话', () => this.plugin.newSession());
    this.button(tools, '历史', () => this.plugin.chooseSession());
    this.titleButton = this.button(tools, '标题', () => this.plugin.openTitleEditor());
    this.branchButton = this.button(tools, '分支', () => this.plugin.chooseBranch());
    this.button(tools, '人格', () => this.plugin.openNote(PERSONA));
    this.button(tools, '记忆', () => this.plugin.openNote(MEMORY));
    this.button(tools, '整理并保存', () => this.plugin.openOrganizer()).addClass('mod-cta');
    this.button(tools, '导出原文', () => this.plugin.exportTranscript());
    this.list = root.createDiv({ cls: 'cr-messages' });
    this.tailSpace = this.list.createDiv({ cls: 'cr-tail-space', attr: { 'aria-hidden': 'true' } });
    const readingGesture = () => {
      this.followLatest = false;
      this.userScrollUntil = Date.now() + 1200;
      this.programmaticScrollTop = null;
      this.previousScrollTop = this.list.scrollTop;
      this.scrollDirection = 0;
    };
    this.registerDomEvent(this.list, 'wheel', event => {
      readingGesture();
      this.scrollDirection = Math.sign(event.deltaY);
    }, { passive: true });
    let touchY: number | null = null;
    this.registerDomEvent(this.list, 'touchstart', event => {
      readingGesture(); touchY = event.touches[0]?.clientY ?? null;
    }, { passive: true });
    this.registerDomEvent(this.list, 'touchmove', event => {
      readingGesture();
      const next = event.touches[0]?.clientY ?? null;
      if (touchY !== null && next !== null) this.scrollDirection = Math.sign(touchY - next);
      touchY = next;
    }, { passive: true });
    this.registerDomEvent(this.list, 'pointerdown', readingGesture);
    this.registerDomEvent(this.list, 'keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        readingGesture();
        this.scrollDirection = ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) ? 1 : -1;
      }
    });
    this.registerDomEvent(this.list, 'scroll', () => {
      const position = this.list.scrollTop;
      if (this.programmaticScrollTop !== null && Math.abs(position - this.programmaticScrollTop) < 2) {
        this.programmaticScrollTop = null;
      } else if (Date.now() < this.userScrollUntil) {
        const movingDown = position > this.previousScrollTop;
        const bottom = this.list.scrollHeight - position - this.list.clientHeight < 24;
        // Hiding the jump button enlarges the viewport and can decrease scrollTop.
        // Preserve opt-in at the bottom for that layout event; a fresh reading
        // gesture already clears followLatest before an actual upward scroll.
        this.followLatest = bottom && (this.scrollDirection > 0 || movingDown || this.followLatest);
        if (this.followLatest) {
          this.pinnedReply = null;
          this.tailSpace.setCssProps({ '--cr-tail-height': '0px' });
        }
      }
      this.previousScrollTop = position;
      this.updateLatestButton();
    }, { passive: true });
    const Observer = (this.list.win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) {
      const observer = new Observer(() => { this.updateTailSpace(); this.updateLatestButton(); });
      this.resizeObserver = observer;
      observer.observe(this.list);
    }
    const footer = root.createDiv({ cls: 'cr-footer' });
    this.latestButton = this.button(footer, '查看最新', async () => {
      this.followLatest = true;
      this.pinnedReply = null;
      this.userScrollUntil = 0;
      this.tailSpace.setCssProps({ '--cr-tail-height': '0px' });
      this.scrollTo(this.list.scrollHeight);
      this.updateLatestButton();
    });
    this.latestButton.addClass('cr-jump');
    this.latestButton.hide();
    this.status = footer.createDiv({ cls: 'cr-status' });
    this.status.setAttr('aria-live', 'polite');
    this.input = footer.createEl('textarea', {
      cls: 'cr-input', attr: { placeholder: '你最近对什么感到好奇？', rows: '3', 'aria-label': '聊天输入' },
    });
    const actions = footer.createDiv({ cls: 'cr-actions' });
    actions.createSpan({ text: 'Enter 发送 · Shift + Enter 换行', cls: 'cr-hint' });
    this.saveButton = this.button(actions, '重试保存', () => this.plugin.retrySave());
    this.stopButton = this.button(actions, '停止', async () => this.plugin.stop());
    this.sendButton = this.button(actions, '发送', () => this.submit());
    this.sendButton.addClass('mod-cta');
    this.registerDomEvent(this.input, 'keydown', event => {
      // Enter used to confirm an IME candidate must not send the message.
      // keyCode 229 covers WebViews that do not report isComposing reliably.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        void this.submit().catch(error => new Notice(error instanceof Error ? error.message : '发送失败。'));
      }
    });
    this.unsubscribe = this.plugin.subscribe(() => {
      if (this.updateTimer) return;
      this.updateTimer = this.contentEl.win.setTimeout(() => { this.updateTimer = undefined; this.update(); }, 32);
    });
    // Workspace restoration may await onOpen. Do not block it on layout readiness.
    this.status.setText('等待知识库加载…');
    void this.plugin.ready.then(() => {
      if (root.isConnected) this.update();
    }).catch(() => {
      if (root.isConnected) this.status.setText(this.plugin.status);
    });
  }

  private button(parent: HTMLElement, label: string, action: () => Promise<void>): HTMLButtonElement {
    const button = parent.createEl('button', { text: label, attr: { type: 'button' } });
    this.registerDomEvent(button, 'click', () => {
      void action().catch(error => new Notice(error instanceof Error ? error.message : '操作失败。'));
    });
    return button;
  }

  private async submit(): Promise<void> {
    if (this.plugin.state !== 'idle') return;
    const text = this.input.value;
    // Keep a recoverable input until the user message has been saved.
    this.input.value = '';
    try {
      const accepted = await this.plugin.send(text);
      if (!accepted && !this.input.value) this.input.value = text;
    } catch (error) {
      if (!this.input.value) this.input.value = text;
      throw error;
    }
  }

  private update(): void {
    if (!this.list) return;
    const busy = this.plugin.state !== 'idle';
    this.sendButton.disabled = busy;
    this.stopButton.disabled = !['connecting', 'streaming'].includes(this.plugin.state);
    this.saveButton.toggleVisibility(this.plugin.hasPendingSave());
    this.status.setText(this.plugin.status);
    const title = this.plugin.session?.title ?? '从一个问题，聊到一个新概念';
    this.conversationHeading.setText(title);
    this.conversationHeading.setAttr('title', title);
    this.titleButton.disabled = !this.plugin.session;
    this.branchButton.disabled = busy || !this.plugin.session;
    let chain: Message[];
    try { chain = this.plugin.chain(); }
    catch (error) { this.status.setText(error instanceof Error ? error.message : '会话加载失败。'); return; }
    const latest = chain[chain.length - 1];
    const newReply = latest?.role === 'assistant' && latest.status === 'streaming' && !this.rows.has(latest.id);
    const openingHistory = chain.length > 0 && !newReply && !chain.some(message => this.rows.has(message.id));
    if (newReply) {
      this.followLatest = false;
      this.pinnedReply = latest.id;
      this.userScrollUntil = 0;
    } else if (openingHistory || !chain.length) {
      this.pinnedReply = null;
      this.followLatest = openingHistory;
    }
    const keep = new Set(chain.map(message => message.id));
    for (const [id, row] of this.rows) {
      if (!keep.has(id)) {
        row.bubble.remove();
        this.removeChild(row.component);
        this.rows.delete(id);
      }
    }
    this.list.find('.cr-empty')?.remove();
    if (!chain.length) {
      const empty = this.list.createDiv({ cls: 'cr-empty' });
      empty.createEl('h3', { text: '把好奇心放在这里' });
      empty.createEl('p', { text: this.plugin.messages.length ? '请选择一个会话分支。' : '先在插件设置中配置 API Key，再开始讨论。' });
      empty.createEl('p', { text: '人格和记忆都可以在知识库中直接编辑。' });
    }
    for (const message of chain) {
      let row = this.rows.get(message.id);
      if (!row) {
        const bubble = this.list.createDiv({ cls: `cr-bubble cr-${message.role}` });
        this.list.insertBefore(bubble, this.tailSpace);
        const component = new Component();
        this.addChild(component);
        row = {
          bubble, label: message.role === 'user' ? bubble.createDiv({ cls: 'cr-label' }) : undefined,
          text: bubble.createDiv({ cls: 'cr-text' }), component,
        };
        this.rows.set(message.id, row);
      }
      row.label?.setText('我');
      if (message.status === 'streaming' || message.role === 'user') {
        row.text.setText(message.content || '等待回复…');
        row.text.addClass('cr-plain');
        row.rendered = undefined;
      } else if (row.rendered !== message.content) {
        row.rendered = message.content;
        // Render into a detached container so async renders cannot overwrite a newer row.
        const fragment = row.text.doc.createElement('div');
        const target = row;
        void MarkdownRenderer.render(this.app, message.content || '（未收到正文）', fragment, ROOT, row.component)
          .then(() => {
            if (target.rendered === message.content && target.text.isConnected) {
              const readingTop = this.list.scrollTop;
              target.text.removeClass('cr-plain');
              target.text.replaceChildren(...Array.from(fragment.childNodes));
              this.updateTailSpace();
              this.scrollTo(this.followLatest ? this.list.scrollHeight : readingTop);
              this.updateLatestButton();
            }
          }).catch(() => target.text.setText(message.content));
      }
    }
    this.updateTailSpace();
    if (newReply) {
      const bubble = this.rows.get(latest.id)?.bubble;
      if (bubble) this.scrollTo(this.list.scrollTop + bubble.getBoundingClientRect().top -
        this.list.getBoundingClientRect().top - 8);
    } else if (this.followLatest) this.scrollTo(this.list.scrollHeight);
    this.updateLatestButton();
  }

  private scrollTo(top: number): void {
    this.list.scrollTop = top;
    this.programmaticScrollTop = this.list.scrollTop;
    this.previousScrollTop = this.list.scrollTop;
  }

  private updateTailSpace(): void {
    const bubble = this.pinnedReply ? this.rows.get(this.pinnedReply)?.bubble : null;
    this.tailSpace.setCssProps({ '--cr-tail-height': `${bubble ? Math.max(0, this.list.clientHeight - bubble.offsetHeight - 16) : 0}px` });
  }

  private updateLatestButton(): void {
    if (!this.latestButton) return;
    const newest = Array.from(this.rows.values()).pop()?.bubble;
    const below = newest ? newest.getBoundingClientRect().bottom > this.list.getBoundingClientRect().bottom : false;
    this.latestButton.toggleVisibility(!this.followLatest && below);
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.updateTimer) this.contentEl.win.clearTimeout(this.updateTimer);
    this.resizeObserver?.disconnect();
    for (const row of this.rows.values()) this.removeChild(row.component);
    this.rows.clear();
  }
}

class ConceptModal extends Modal {
  private draft: ConceptDraft | null = null;
  private focusInput!: HTMLInputElement;
  private titleInput!: HTMLInputElement;
  private bodyInput!: HTMLTextAreaElement;
  private preview!: HTMLElement;
  private statusEl!: HTMLElement;
  private generateButton!: HTMLButtonElement;
  private saveButton!: HTMLButtonElement;
  private editor!: HTMLElement;
  private renderer = new Component();
  private generating = false;
  private closed = false;
  private renderVersion = 0;

  constructor(app: App, private plugin: ConceptRoamer) { super(app); }

  onOpen(): void {
    this.closed = false;
    this.renderer.load();
    this.modalEl.addClass('cr-organize-modal');
    const root = this.contentEl;
    root.empty();
    root.createEl('h2', { text: '整理成概念笔记' });
    root.createEl('p', { text: '根据当前讨论生成笔记，可修改标题和内容后保存。整理会调用一次 DeepSeek，并使用少量相关笔记片段。' });
    const focusRow = root.createDiv({ cls: 'cr-organize-focus' });
    this.focusInput = focusRow.createEl('input', {
      attr: { type: 'text', placeholder: '要整理的概念（可选，留空则自动识别）', 'aria-label': '整理主题' },
    });
    this.generateButton = focusRow.createEl('button', { text: '开始整理', cls: 'mod-cta' });
    this.generateButton.addEventListener('click', () => { void this.generate(); });
    this.statusEl = root.createDiv({ cls: 'cr-organize-status' });
    this.statusEl.setAttr('aria-live', 'polite');
    this.editor = root.createDiv({ cls: 'cr-organize-editor' });
    this.editor.createEl('label', { text: '笔记标题' });
    this.titleInput = this.editor.createEl('input', { attr: { type: 'text', 'aria-label': '笔记标题' } });
    const tabs = this.editor.createDiv({ cls: 'cr-organize-tabs' });
    const previewButton = tabs.createEl('button', { text: '预览' });
    const editButton = tabs.createEl('button', { text: '编辑 Markdown' });
    this.preview = this.editor.createDiv({ cls: 'cr-organize-preview markdown-rendered' });
    this.bodyInput = this.editor.createEl('textarea', { cls: 'cr-organize-body', attr: { 'aria-label': '概念笔记内容' } });
    this.bodyInput.hide();
    previewButton.addEventListener('click', () => {
      this.bodyInput.hide(); this.preview.show(); void this.renderPreview();
    });
    editButton.addEventListener('click', () => { this.preview.hide(); this.bodyInput.show(); });
    const persist = () => {
      if (!this.draft || this.draft.savedNote) return;
      this.draft.editedTitle = this.titleInput.value;
      this.draft.editedBody = this.bodyInput.value;
      this.plugin.conceptDraft = this.draft;
      this.app.saveLocalStorage(CONCEPT_DRAFT, this.draft);
    };
    this.titleInput.addEventListener('input', persist);
    this.bodyInput.addEventListener('input', persist);
    this.editor.createEl('p', {
      text: '保存到“概念漫游/概念”，同时保存会话摘要。同名文件会新建副本。关联和来源可以在编辑页修改。',
      cls: 'cr-organize-hint',
    });
    const actions = root.createDiv({ cls: 'cr-organize-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    this.saveButton = actions.createEl('button', { text: '保存到知识库', cls: 'mod-cta' });
    this.saveButton.addEventListener('click', () => { void this.save(); });
    this.saveButton.disabled = true;
    this.editor.hide();
    const previous = this.plugin.conceptDraft;
    if (previous && previous.input.sessionId === this.plugin.session?.id) {
      this.applyDraft(previous);
      this.statusEl.setText(previous.savedNote ? '笔记已保存，可以继续重试保存摘要。' : '已恢复上次整理草稿，可继续编辑或重新整理。');
    } else this.statusEl.setText('点击“开始整理”，生成可独立阅读的概念笔记。');
  }

  private applyDraft(draft: ConceptDraft): void {
    this.draft = draft;
    this.focusInput.value = draft.input.focus;
    this.titleInput.value = draft.editedTitle ?? draft.result.title;
    this.bodyInput.value = draft.editedBody ?? conceptBody(draft);
    this.titleInput.disabled = !!draft.savedNote;
    this.bodyInput.disabled = !!draft.savedNote;
    this.editor.show();
    this.saveButton.disabled = false;
    this.saveButton.setText(draft.savedNote ? '继续保存摘要' : '保存到知识库');
    this.generateButton.setText('重新整理');
    this.generateButton.disabled = !!draft.savedNote;
    void this.renderPreview();
  }

  private async renderPreview(): Promise<void> {
    if (!this.draft) return;
    const version = ++this.renderVersion;
    const fragment = this.preview.doc.createElement('div');
    try {
      await MarkdownRenderer.render(this.app,
        `# ${this.titleInput.value}\n\n${this.bodyInput.value}`, fragment, `${ROOT}/概念`, this.renderer);
      if (!this.closed && version === this.renderVersion) this.preview.replaceChildren(...Array.from(fragment.childNodes));
    } catch { if (!this.closed) this.preview.setText(this.bodyInput.value); }
  }

  private async generate(): Promise<void> {
    if (this.generating) return;
    this.generating = true;
    this.generateButton.disabled = true;
    this.saveButton.disabled = true;
    this.focusInput.disabled = true;
    this.titleInput.disabled = true;
    this.bodyInput.disabled = true;
    this.statusEl.setText('正在整理…');
    try {
      const draft = await this.plugin.generateConcept(this.focusInput.value, characters => {
        if (!this.closed) this.statusEl.setText(`正在整理，已接收 ${characters} 个字符…`);
      });
      if (!this.closed) {
        this.applyDraft(draft);
        this.statusEl.setText(`整理完成，找到 ${draft.result.related.length} 条关联。请检查内容后保存。`);
      }
    } catch (error) {
      if (!this.closed) this.statusEl.setText(error instanceof Error ? error.message : '整理失败，请重试。');
    } finally {
      this.generating = false;
      if (!this.closed) {
        this.generateButton.disabled = !!this.draft?.savedNote;
        this.focusInput.disabled = false;
        this.saveButton.disabled = !this.draft;
        this.titleInput.disabled = !!this.draft?.savedNote;
        this.bodyInput.disabled = !!this.draft?.savedNote;
      }
    }
  }

  private async save(): Promise<void> {
    if (!this.draft || this.generating) return;
    this.saveButton.disabled = true;
    this.generateButton.disabled = true;
    try {
      const path = await this.plugin.saveConcept(this.draft, this.titleInput.value, this.bodyInput.value);
      this.close();
      new Notice('概念笔记和讨论摘要已保存。');
      void this.app.workspace.openLinkText(path, '', true).catch(() => new Notice(`笔记已保存：${path}`));
    } catch (error) {
      this.statusEl.setText(error instanceof Error ? error.message : '保存失败，请重试。');
      this.saveButton.disabled = false;
      this.generateButton.disabled = false;
      if (this.draft.savedNote) this.applyDraft(this.draft);
    }
  }

  onClose(): void {
    this.closed = true;
    if (this.generating) this.plugin.stop();
    this.renderer.unload();
    this.contentEl.empty();
  }
}

class TitleModal extends Modal {
  constructor(app: App, private plugin: ConceptRoamer, private session: Session) { super(app); }
  onOpen(): void {
    const root = this.contentEl;
    root.createEl('h2', { text: '会话标题' });
    root.createEl('p', { text: '手动改名后默认保留这个标题。开启下方选项，可让后续讨论自动更新标题。' });
    const input = root.createEl('input', { cls: 'cr-title-input',
      attr: { type: 'text', 'aria-label': '会话标题', maxlength: '80' } });
    input.value = this.session.title;
    const label = root.createEl('label', { cls: 'cr-title-toggle' });
    const automatic = label.createEl('input', { attr: { type: 'checkbox' } });
    automatic.checked = false;
    label.createSpan({ text: '允许自动更新这个会话标题' });
    const status = root.createDiv({ cls: 'cr-status', attr: { 'aria-live': 'polite' } });
    const save = root.createEl('button', { text: '保存标题', cls: 'mod-cta', attr: { type: 'button' } });
    save.addEventListener('click', () => {
      save.disabled = true;
      void this.plugin.renameSession(input.value, automatic.checked, this.session.id).then(() => this.close())
        .catch(error => { status.setText(error instanceof Error ? error.message : '标题保存失败。'); save.disabled = false; });
    });
    input.focus();
  }
  onClose(): void { this.contentEl.empty(); }
}

class Picker<T> extends SuggestModal<T> {
  constructor(app: App, private items: T[], private label: (item: T) => string,
    private selected: (item: T) => void | Promise<void>) { super(app); this.setPlaceholder('搜索并选择…'); }
  getSuggestions(query: string): T[] { return this.items.filter(item => this.label(item).toLowerCase().includes(query.toLowerCase())); }
  renderSuggestion(item: T, element: HTMLElement): void { element.setText(this.label(item)); }
  onChooseSuggestion(item: T): void { void this.selected(item); }
}

class RoamerSettings extends PluginSettingTab {
  constructor(app: App, private plugin: ConceptRoamer) { super(app, plugin); }
  display(): void {
    const root = this.containerEl;
    root.empty();
    new Setting(root).setName('连接与记忆').setHeading();
    root.createEl('p', { text: '聊天直接连接 DeepSeek。人格、全局记忆和当前分支的历史会随请求发送。' });
    new Setting(root).setName('DeepSeek API Key').setDesc('选择或创建本机密钥，插件配置只保存密钥名称。')
      .addComponent(element => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.secretName)
        .onChange(value => { this.plugin.settings.secretName = value; void this.plugin.saveData(this.plugin.settings); }));
    new Setting(root).setName('模型').setDesc('默认 deepseek-flash，可填写账户支持的模型名称。')
      .addText(input => input.setValue(this.plugin.settings.model).onChange(value => {
        this.plugin.settings.model = value.trim(); void this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(root).setName('开启思考模式').setDesc('关闭时更快开始输出。开启后，思考阶段显示状态，正文仍逐步输出。')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.thinking).onChange(value => {
        this.plugin.settings.thinking = value; void this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(root).setName('自动更新会话标题')
      .setDesc('首轮完整回复后命名，之后每增加三轮完整回复更新。每次会额外调用 DeepSeek，发送开头和近期对话片段，产生少量 API 费用。手动固定的标题不会更改。')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.automaticTitles).onChange(value => {
        void this.plugin.setAutomaticTitles(value);
      }));
    new Setting(root).setName('流式传输').setDesc('自动：Windows 使用桌面传输，Android 使用 Web 传输。Web 可用于验证移动端路径。')
      .addDropdown(dropdown => dropdown.addOption('auto', '自动选择').addOption('browser', 'Web 流式传输')
        .setValue(this.plugin.settings.transport).onChange(value => {
          this.plugin.settings.transport = value as Settings['transport']; void this.plugin.saveData(this.plugin.settings);
        }));
    new Setting(root).setName('人格').setDesc('编辑后，下一次发送生效。')
      .addButton(button => button.setButtonText('打开人格').onClick(() => { void this.plugin.openNote(PERSONA); }));
    new Setting(root).setName('全局记忆').setDesc('此版本使用手动维护的记忆，跨会话读取。')
      .addButton(button => button.setButtonText('打开记忆').onClick(() => { void this.plugin.openNote(MEMORY); }));
    root.createEl('p', { text: '窗口置顶使用 Obsidian 自带命令。跨设备同步消息 JSON 需要启用“同步其他文件类型”。' });
  }
}
