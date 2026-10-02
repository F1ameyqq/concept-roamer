const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { webcrypto } = require('node:crypto');
const bundle = fs.readFileSync(process.env.CONCEPT_ROAMER_TEST_BUNDLE ??
  path.join(__dirname, '../dist/concept-roamer/main.js'), 'utf8');

class TFile {
  constructor(path) {
    this.path = path; this.name = path.split('/').at(-1); this.extension = this.name.split('.').at(-1);
    this.basename = this.name.slice(0, -this.extension.length - 1);
  }
}
class TFolder { constructor(path) { this.path = path; } }
class BasePlugin {
  constructor(app) { this.app = app; this.commands = new Map(); this.registeredEvents = []; this.cleanups = []; }
  async loadData() { return null; }
  async saveData() {}
  registerView() {}
  addSettingTab() {}
  addRibbonIcon() {}
  addCommand(command) { this.commands.set(command.id, command); }
  registerEvent(event) { this.registeredEvents.push(event); }
  register(callback) { this.cleanups.push(callback); }
  registerDomEvent(element, name, callback, options) {
    element.addEventListener(name, callback, options);
    this.register(() => element.removeEventListener(name, callback, options));
  }
}
class Empty {}

function fakeHost({ storage = new Map(), records = new Map(), apiKey = 'local-test-key', responder,
  indexVisible = true, layoutInitiallyReady = true, raceFolderPath, automaticTitles = false,
  useCompressedContext = true, automaticCompression = true,
  platform = { isDesktop: false, isDesktopApp: false, isMobileApp: true }, transport = 'auto', httpsRequest } = {}) {
  const calls = [];
  const fetchCalls = [];
  const moduleLoads = [];
  const nativeRequests = [];
  const createAttempts = [];
  const layoutCallbacks = [];
  const workspaceEvents = new Map();
  const shownMenus = [];
  const leaves = [];
  const leafOperations = [];
  const reads = [];
  let layoutReady = layoutInitiallyReady;
  let failAssistantSave = false;
  let failUserSave = false;
  let activeNoteView = null;
  const makeLeaf = kind => {
    const leaf = {
      kind, states: [], view: { focusComposer: () => leafOperations.push({ action: 'focus', leaf }) },
      setViewState: async state => { leaf.states.push(state); leaf.viewType = state.type; },
    };
    leaves.push(leaf);
    leafOperations.push({ action: 'create', kind, leaf });
    return leaf;
  };
  const obsidian = {
    Plugin: BasePlugin, ItemView: Empty, PluginSettingTab: Empty, SuggestModal: Empty,
    Component: Empty, Modal: Empty, SecretComponent: Empty, Setting: Empty, Notice: Empty,
    MarkdownView: Empty,
    Menu: { forEvent: () => {
      const menu = selectionMenu();
      menu.showAtMouseEvent = event => shownMenus.push({ menu, event });
      return menu;
    } },
    TFile, TFolder, normalizePath: path => path,
    Platform: platform,
  };
  const app = {
    workspace: {
      onLayoutReady: callback => layoutReady ? callback() : layoutCallbacks.push(callback),
      on: (name, callback) => {
        const handlers = workspaceEvents.get(name) ?? [];
        handlers.push(callback); workspaceEvents.set(name, handlers);
        return { name, callback };
      },
      iterateAllLeaves: callback => leaves.forEach(callback),
      getLeavesOfType: type => leaves.filter(leaf => leaf.viewType === type),
      openPopoutLeaf: () => makeLeaf('popout'),
      getLeaf: kind => makeLeaf(kind),
      getRightLeaf: () => makeLeaf('right'),
      revealLeaf: async leaf => { leafOperations.push({ action: 'reveal', leaf }); },
      getActiveViewOfType: () => activeNoteView,
    },
    secretStorage: { getSecret: () => apiKey },
    saveLocalStorage: (key, value) => value === null ? storage.delete(key) : storage.set(key, JSON.parse(JSON.stringify(value))),
    loadLocalStorage: key => storage.get(key) ?? null,
    vault: {
      getAbstractFileByPath: path => indexVisible ? records.get(path)?.file ?? null : null,
      getFiles: () => indexVisible ? [...records.values()].map(record => record.file).filter(file => file instanceof TFile) : [],
      getMarkdownFiles: () => [...records.values()].map(record => record.file).filter(file => file instanceof TFile && file.extension === 'md'),
      adapter: {
        exists: async path => records.has(path),
        stat: async path => {
          const file = records.get(path)?.file;
          return file ? { type: file instanceof TFolder ? 'folder' : 'file' } : null;
        },
        read: async path => {
          reads.push(path);
          const record = records.get(path);
          if (!record || !(record.file instanceof TFile)) throw new Error('File not found');
          return record.text;
        },
        list: async folder => {
          const prefix = `${folder}/`;
          const children = [...records.values()].filter(record => record.file.path.startsWith(prefix) &&
            !record.file.path.slice(prefix.length).includes('/'));
          return {
            files: children.filter(record => record.file instanceof TFile).map(record => record.file.path),
            folders: children.filter(record => record.file instanceof TFolder).map(record => record.file.path),
          };
        },
      },
      createFolder: async path => {
        createAttempts.push(path);
        if (path === raceFolderPath) records.set(path, { file: new TFolder(path) });
        if (records.has(path)) throw new Error('Folder already exists.');
        records.set(path, { file: new TFolder(path) });
      },
      create: async (path, text) => {
        if (path.endsWith('.json') && JSON.parse(text).role === 'user' && failUserSave) throw new Error('user disk write failed');
        if (path.endsWith('.json') && JSON.parse(text).role === 'assistant' && failAssistantSave) throw new Error('disk write failed');
        if (records.has(path)) throw new Error('already exists');
        const file = new TFile(path); records.set(path, { file, text }); return file;
      },
      read: async file => { reads.push(file.path); return records.get(file.path).text; },
    },
  };
  const respond = options => responder ? responder(options) : new Response(
    'data: {"choices":[{"delta":{"content":"回答"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  const nativeRequest = (url, options, callback) => {
    nativeRequests.push({ url, options });
    if (httpsRequest) return httpsRequest(url, options, callback);
    const request = new EventEmitter();
    request.destroy = () => { request.destroyed = true; return request; };
    request.end = body => {
      calls.push(JSON.parse(body));
      void Promise.resolve().then(async () => {
        const result = await respond({ body });
        const response = new EventEmitter();
        response.statusCode = result.status;
        response.headers = Object.fromEntries(result.headers);
        response.destroy = () => { response.destroyed = true; return response; };
        callback(response);
        const bytes = new Uint8Array(await result.arrayBuffer());
        if (!response.destroyed) response.emit('data', bytes);
        if (!response.destroyed) response.emit('end');
      }).catch(error => request.emit('error', error));
      return request;
    };
    return request;
  };
  const module = { exports: {} };
  // Expose the bundled formatter only inside this test VM so the complete
  // organizer flow can verify generated links without hand-building Markdown.
  vm.runInNewContext(`${bundle}\nmodule.exports.__testConceptBody = conceptBody;`, {
    module, exports: module.exports,
    require: name => {
      moduleLoads.push(name);
      if (name === 'obsidian') return obsidian;
      if (name === 'https') return { request: nativeRequest };
      throw new Error(`Unexpected module ${name}`);
    },
    crypto: webcrypto, TextDecoder, TextEncoder, AbortController, Error, TypeError,
    setTimeout, clearTimeout, console, window: { setTimeout, clearTimeout },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push(payload);
      fetchCalls.push(payload);
      return respond(options);
    },
  }, { filename: 'concept-roamer/main.js' });
  const plugin = new module.exports.default(app);
  plugin.loadData = async () => ({ automaticTitles, transport, useCompressedContext, automaticCompression });
  return {
    plugin, app, records, storage, calls, fetchCalls, moduleLoads, nativeRequests, createAttempts,
    leaves, leafOperations, reads, shownMenus, conceptBody: module.exports.__testConceptBody,
    emitWorkspace: (name, ...args) => (workspaceEvents.get(name) ?? []).forEach(callback => callback(...args)),
    setActiveNoteView: view => { activeNoteView = view; app.workspace.activeEditor = view; },
    addReadingLeaf: (doc, filePath, nodes) => {
      const view = new Empty();
      view.file = new TFile(filePath);
      view.getMode = () => 'preview';
      view.contentEl = { ownerDocument: doc };
      view.previewMode = { containerEl: { ownerDocument: doc, contains: node => nodes.includes(node) } };
      const leaf = { view, viewType: 'markdown' };
      leaves.push(leaf);
      return view;
    },
    failSave: value => { failAssistantSave = value; },
    failUserSave: value => { failUserSave = value; },
    finishLayout: () => { layoutReady = true; layoutCallbacks.splice(0).forEach(callback => callback()); },
  };
}

async function ready(options) {
  const host = fakeHost(options);
  await host.plugin.onload();
  await host.plugin.ready;
  return host;
}

function selectionMenu() {
  const items = [];
  return {
    items,
    addItem: configure => {
      const item = {
        setTitle(value) { this.title = value; return this; },
        setIcon(value) { this.icon = value; return this; },
        onClick(callback) { this.callback = callback; return this; },
      };
      configure(item); items.push(item);
    },
  };
}

const selectedPassage = { path: '阅读/路径依赖.md', title: '路径依赖', text: '早期的选择会改变后续选择的成本。' };
const plain = value => JSON.parse(JSON.stringify(value));

test('selection discussion: editor menu appears only for text and captures the original note and passage', async () => {
  const host = await ready();
  let selection = '   \n';
  const editor = { getSelection: () => selection };
  const info = { file: new TFile(selectedPassage.path) };
  const empty = selectionMenu();
  host.emitWorkspace('editor-menu', empty, editor, info);
  assert.equal(empty.items.length, 0);

  selection = selectedPassage.text;
  const menu = selectionMenu();
  host.emitWorkspace('editor-menu', menu, editor, info);
  const discuss = menu.items.find(item => item.title === '在漫游中讨论');
  assert.ok(discuss, 'selection context menu should offer a discussion action');
  selection = '随后在其他笔记中选择的文字';
  info.file = new TFile('别的笔记.md');
  discuss.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
  assert.equal(host.calls.length, 0, 'opening discussion must not send text to the model');
  assert.ok(host.plugin.session, 'default discussion creates a durable empty conversation');
  assert.equal(host.plugin.messages.length, 0);
});

test('selection discussion: reuses the existing chat window and otherwise opens a desktop popout or mobile tab', async () => {
  const desktop = { isDesktop: true, isDesktopApp: true, isMobileApp: false };
  for (const [platform, expectedKind] of [[desktop, 'popout'], [undefined, 'tab']]) {
    const host = await ready({ platform });
    await host.plugin.prepareNoteDiscussion(selectedPassage);
    assert.equal(host.leaves.length, 1);
    assert.equal(host.leaves[0].kind, expectedKind);
    assert.equal(host.leaves[0].viewType, 'concept-roamer-chat');
    const original = host.leaves[0];
    const originalSessionId = host.plugin.session.id;
    await host.plugin.prepareNoteDiscussion({ ...selectedPassage, text: '新的选段' });
    assert.equal(host.leaves.length, 1, 'each selection should not create another chat window');
    assert.equal(host.leafOperations.filter(operation => operation.action === 'reveal').at(-1).leaf, original);
    assert.equal(host.calls.length, 0);
    assert.equal(host.plugin.messages.length, 0);
    assert.equal(host.plugin.selectedQuote.text, '新的选段');
    assert.notEqual(host.plugin.session.id, originalSessionId, 'reusing the window must still start a fresh conversation');
  }
});

test('selection discussion: concurrent selections open one desktop window and retain the newest passage', async () => {
  const host = await ready({ platform: { isDesktop: true, isDesktopApp: true, isMobileApp: false } });
  const latest = { path: '阅读/新的选择.md', title: '新的选择', text: '这是第二次选中的段落。' };
  await Promise.all([
    host.plugin.prepareNoteDiscussion(selectedPassage),
    host.plugin.prepareNoteDiscussion(latest),
  ]);
  assert.equal(host.leaves.length, 1);
  assert.equal(host.leaves[0].kind, 'popout');
  assert.deepEqual(plain(host.plugin.selectedQuote), latest);
  assert.equal(host.calls.length, 0);
  assert.equal([...host.records.keys()].filter(name => name.endsWith('/会话.json')).length, 1,
    'overlapping selections must create one conversation');
});

test('selection discussion: default starts fresh and keeps previous messages in history without sending them to the model', async () => {
  const host = await ready();
  await host.plugin.send('旧会话独有的正文-不要带入选段讨论');
  const previous = plain(host.plugin.session);
  const previousMessages = plain(host.plugin.messages);
  const previousFiles = [...host.records].filter(([name]) => name.startsWith(`概念漫游/会话/${previous.id}/`))
    .map(([name, record]) => [name, record.text]);
  await host.plugin.openChat();
  const originalWindow = host.leaves[0];

  await host.plugin.prepareNoteDiscussion(selectedPassage);
  assert.notEqual(host.plugin.session.id, previous.id);
  assert.equal(host.plugin.messages.length, 0);
  assert.equal(host.plugin.chain().length, 0);
  assert.equal(host.plugin.activeLeaf, null);
  assert.equal(host.calls.length, 1, 'preparing a passage must not issue a model request');
  assert.equal(host.leaves.length, 1);
  assert.equal(host.leaves[0], originalWindow, 'the existing chat window should display the new conversation');
  assert.deepEqual(plain(await host.plugin.store.messages(previous.id)), previousMessages);
  assert.ok((await host.plugin.store.sessions()).some(session => session.id === previous.id));
  assert.deepEqual(previousFiles.map(([name]) => [name, host.records.get(name).text]), previousFiles);

  await host.plugin.send('解释新的选段', host.plugin.selectedQuote);
  assert.equal(host.calls.length, 2);
  assert.equal(host.calls[1].messages.length, 2, 'fresh payload contains the system prompt and the new user question');
  assert.equal(JSON.stringify(host.calls[1]).includes('旧会话独有的正文'), false);
  assert.ok(host.calls[1].messages.at(-1).content.includes(selectedPassage.text));
  assert.deepEqual(plain(await host.plugin.store.messages(previous.id)), previousMessages);
});

test('selection discussion: editor menu offers fresh discussion and explicit continuation with distinct session behavior', async () => {
  const host = await ready();
  await host.plugin.send('上一个话题');
  const originalId = host.plugin.session.id;
  const originalMessages = plain(host.plugin.messages);
  const menu = selectionMenu();
  host.emitWorkspace('editor-menu', menu, { getSelection: () => selectedPassage.text }, { file: new TFile(selectedPassage.path) });
  const discuss = menu.items.find(item => item.title === '在漫游中讨论');
  const continueCurrent = menu.items.find(item => item.title === '在当前漫游中继续');
  assert.ok(discuss);
  assert.ok(continueCurrent);

  continueCurrent.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.plugin.session.id, originalId);
  assert.deepEqual(plain(host.plugin.messages), originalMessages);
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);

  discuss.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(host.plugin.session.id, originalId);
  assert.equal(host.plugin.messages.length, 0);
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
  assert.equal(host.calls.length, 1);
});

test('selection discussion: continuation command preserves the current conversation and checking availability changes nothing', async () => {
  const host = await ready();
  await host.plugin.send('已有问题');
  const originalId = host.plugin.session.id;
  const originalMessages = plain(host.plugin.messages);
  const command = host.plugin.commands.get('continue-selection');
  assert.ok(command);
  assert.equal(command.checkCallback(true), false);
  host.setActiveNoteView({ getMode: () => 'source', file: new TFile(selectedPassage.path),
    editor: { getSelection: () => selectedPassage.text } });
  assert.equal(command.checkCallback(true), true);
  assert.equal(host.plugin.selectedQuote, null);
  assert.equal(host.plugin.session.id, originalId);
  assert.equal(command.checkCallback(false), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.plugin.session.id, originalId);
  assert.deepEqual(plain(host.plugin.messages), originalMessages);
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
  assert.equal(host.calls.length, 1);
});

test('selection discussion: busy or unsaved reply rejects a fresh discussion before changing conversation or attachment', async () => {
  for (const reason of ['busy', 'unsaved']) {
    const host = await ready();
    await host.plugin.send('已有会话');
    await host.plugin.prepareNoteDiscussion(selectedPassage, true);
    if (reason === 'busy') host.plugin.state = 'connecting';
    else {
      host.failSave(true);
      await host.plugin.send('尚未保存的回复');
      assert.equal(host.plugin.hasPendingSave(), true);
    }
    const originalId = host.plugin.session.id;
    const originalMessages = plain(host.plugin.messages);
    const originalQuote = host.plugin.selectedQuote;
    const originalLeaf = host.plugin.activeLeaf;
    const originalSessionCount = [...host.records.keys()].filter(name => name.endsWith('/会话.json')).length;
    await assert.rejects(host.plugin.prepareNoteDiscussion({ ...selectedPassage, text: '不能替换的选段' }),
      reason === 'busy' ? /等待/ : /重试保存/);
    assert.equal(host.plugin.session.id, originalId);
    assert.equal(host.plugin.selectedQuote, originalQuote);
    assert.equal(host.plugin.activeLeaf, originalLeaf);
    assert.deepEqual(plain(host.plugin.messages), originalMessages);
    assert.equal([...host.records.keys()].filter(name => name.endsWith('/会话.json')).length, originalSessionCount);
    assert.equal(host.plugin.state, reason === 'busy' ? 'connecting' : 'idle');
    if (reason === 'busy') host.plugin.state = 'idle';
    host.plugin.onunload();
  }
});

test('selection discussion: failed fresh-session creation preserves the previous conversation and selection', async () => {
  const host = await ready();
  await host.plugin.send('已有会话');
  await host.plugin.prepareNoteDiscussion(selectedPassage, true);
  const previous = host.plugin.session;
  const previousMessages = host.plugin.messages;
  const previousLeaf = host.plugin.activeLeaf;
  const previousQuote = host.plugin.selectedQuote;
  const activeBefore = plain(host.storage.get('concept-roamer:active-v1'));
  const create = host.app.vault.create;
  host.app.vault.create = async (name, text) => {
    if (name.endsWith('/会话.json')) throw new Error('new session disk write failed');
    return create(name, text);
  };
  await assert.rejects(host.plugin.prepareNoteDiscussion({ ...selectedPassage, text: '新的选段' }), /new session disk write failed/);
  assert.equal(host.plugin.session, previous);
  assert.equal(host.plugin.messages, previousMessages);
  assert.equal(host.plugin.activeLeaf, previousLeaf);
  assert.equal(host.plugin.selectedQuote, previousQuote);
  assert.equal(host.plugin.state, 'idle');
  assert.deepEqual(plain(host.storage.get('concept-roamer:active-v1')), activeBefore);
  assert.equal(host.calls.length, 1);
});

test('selection discussion: creating a fresh session blocks send and another new session until durable creation completes', async () => {
  const host = await ready();
  await host.plugin.send('旧的会话');
  const oldId = host.plugin.session.id;
  let reachedCreate;
  let releaseCreate;
  const reached = new Promise(resolve => { reachedCreate = resolve; });
  const blocked = new Promise(resolve => { releaseCreate = resolve; });
  const create = host.app.vault.create;
  host.app.vault.create = async (name, text) => {
    if (name.endsWith('/会话.json')) { reachedCreate(); await blocked; }
    return create(name, text);
  };
  const preparing = host.plugin.prepareNoteDiscussion(selectedPassage);
  await reached;
  assert.equal(host.plugin.state, 'saving');
  assert.equal(host.plugin.session.id, oldId);
  assert.equal(await host.plugin.send('不能发往旧会话'), false);
  await assert.rejects(host.plugin.newSession(), /等待/);
  assert.equal(host.calls.length, 1);
  releaseCreate();
  await preparing;
  assert.equal(host.plugin.state, 'idle');
  assert.notEqual(host.plugin.session.id, oldId);
  assert.equal(host.plugin.messages.length, 0);
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
});

test('selection discussion: sending while the chat window is being revealed does not reattach the accepted quotation', async () => {
  const host = await ready();
  let reachedReveal;
  let releaseReveal;
  const reached = new Promise(resolve => { reachedReveal = resolve; });
  const blocked = new Promise(resolve => { releaseReveal = resolve; });
  host.app.workspace.revealLeaf = async () => { reachedReveal(); await blocked; };
  const preparing = host.plugin.prepareNoteDiscussion(selectedPassage);
  await reached;
  const quote = host.plugin.selectedQuote;
  assert.deepEqual(plain(quote), selectedPassage);
  assert.equal(await host.plugin.send('解释选中的文字', quote), true);
  assert.equal(host.plugin.selectedQuote, null);
  releaseReveal();
  await preparing;
  assert.equal(host.plugin.selectedQuote, null, 'finishing window reveal must not restore an already-sent attachment');
  assert.deepEqual(plain(host.plugin.messages[0].noteQuote), selectedPassage);
  assert.equal(host.calls.length, 1);
});

test('selection discussion: staged quotations follow their conversation when switching back through history', async () => {
  const host = await ready();
  await host.plugin.send('旧会话的问题');
  await host.plugin.prepareNoteDiscussion(selectedPassage, true);
  const previous = plain(host.plugin.session);
  const nextPassage = { path: '阅读/新主题.md', title: '新主题', text: '新会话中选中的原文。' };
  await host.plugin.prepareNoteDiscussion(nextPassage);
  const next = plain(host.plugin.session);
  assert.deepEqual(plain(host.plugin.selectedQuote), nextPassage);
  await host.plugin.loadSession(previous);
  assert.equal(host.plugin.session.id, previous.id);
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
  await host.plugin.loadSession(next);
  assert.equal(host.plugin.session.id, next.id);
  assert.deepEqual(plain(host.plugin.selectedQuote), nextPassage);
  assert.equal(host.calls.length, 1);
});

test('selection discussion: the command supports the current editor selection without sending a model request', async () => {
  const host = await ready();
  const command = host.plugin.commands.get('discuss-selection');
  assert.ok(command);
  assert.equal(command.checkCallback(true), false);
  let selection = selectedPassage.text;
  host.setActiveNoteView({ getMode: () => 'source', file: new TFile(selectedPassage.path), editor: { getSelection: () => selection } });
  assert.equal(command.checkCallback(true), true);
  assert.equal(host.plugin.selectedQuote, null, 'checking command availability must have no side effects');
  assert.equal(command.checkCallback(false), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
  assert.equal(host.calls.length, 0);
  selection = '';
  assert.equal(command.checkCallback(true), false);
});

test('selection discussion: persists source attribution separately and restores the excerpt in follow-up context', async () => {
  const host = await ready();
  host.records.set(selectedPassage.path, { file: new TFile(selectedPassage.path),
    text: `${selectedPassage.text}\n全篇未选中文本-不应发送-测试标记` });
  await host.plugin.prepareNoteDiscussion(selectedPassage);
  const quote = host.plugin.selectedQuote;
  assert.equal(await host.plugin.send('这是什么意思？', quote), true);
  assert.equal(host.plugin.selectedQuote, null);
  const user = host.plugin.messages[0];
  assert.equal(user.content, '这是什么意思？');
  assert.deepEqual(plain(user.noteQuote), selectedPassage);
  assert.equal(host.calls[0].messages.at(-1).role, 'user');
  const input = host.calls[0].messages.at(-1).content;
  assert.match(input, /这是什么意思/);
  assert.ok(input.includes(selectedPassage.text));
  assert.ok(input.includes(selectedPassage.path));
  assert.ok(input.includes(selectedPassage.title));
  assert.equal(JSON.stringify(host.calls).includes('全篇未选中文本-不应发送-测试标记'), false);
  assert.equal(host.reads.includes(selectedPassage.path), false, 'quoted discussion should not read the full source note');
  const saved = [...host.records.values()].find(record => {
    if (!record.file.path.endsWith('.json')) return false;
    return JSON.parse(record.text).id === user.id;
  });
  assert.deepEqual(JSON.parse(saved.text).noteQuote, selectedPassage);
  host.plugin.onunload();
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.equal(restored.plugin.messages[0].content, '这是什么意思？');
  assert.deepEqual(plain(restored.plugin.messages[0].noteQuote), selectedPassage);
  await restored.plugin.send('举一个生活中的例子');
  assert.equal(restored.calls[0].messages[1].content, input);
  assert.equal(restored.calls[0].messages.at(-1).content, '举一个生活中的例子');
  assert.equal(JSON.stringify(restored.calls).includes('全篇未选中文本-不应发送-测试标记'), false);
});

test('selection discussion: an explicitly created session retains a source-aware provisional title after reload', async () => {
  const host = await ready();
  await host.plugin.newSession();
  await host.plugin.prepareNoteDiscussion(selectedPassage, true);
  assert.equal(await host.plugin.send('', host.plugin.selectedQuote), true);
  const title = host.plugin.session.title;
  assert.ok(title.includes(selectedPassage.title));
  assert.match(title, /理解/);
  assert.notEqual(title, '新的探索');
  assert.equal(host.plugin.messages[0].content, '请帮我理解这段文字，并指出值得进一步讨论的问题。');
  const originalMetadata = [...host.records].find(([name]) => name.endsWith('/会话.json'))[1].text;
  assert.equal(JSON.parse(originalMetadata).title, '新的探索', 'initial session metadata remains immutable');
  host.plugin.onunload();
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.equal(restored.plugin.session.title, title);
  assert.equal(restored.calls.length, 0);
});

test('selection discussion: concept organization uses only the selected source excerpt and generates a valid note link', async () => {
  const passage = { ...selectedPassage, text: selectedPassage.text.repeat(50) };
  const sentinel = '源笔记未选中的正文-不应读取或发送-测试标记';
  let organizationInput;
  const host = await ready({ responder: options => {
    const payload = JSON.parse(options.body);
    if (!payload.response_format) return streamedText('这段材料讨论了早期选择如何影响后续决策。');
    organizationInput = JSON.parse(payload.messages[1].content);
    return streamedText(JSON.stringify({
      title: '路径依赖', definition: '早期选择会影响后续选择空间。', mechanism: '既有投入与切换成本。',
      examples: ['长期使用某种工作流程。'], boundaries: ['规则变化可能打破旧路径。'], applications: ['理解转变成本。'],
      userStatements: [], openQuestions: ['如何降低转变成本？'],
      related: [{ path: passage.path, reason: '原始选段展示了选择成本如何延续。' }], sources: [],
      summary: '从选中的笔记原文讨论了路径依赖的含义及边界。',
    }));
  } });
  const originalSource = `${passage.text}\n\n${sentinel}`;
  host.records.set(passage.path, { file: new TFile(passage.path), text: originalSource });
  await host.plugin.prepareNoteDiscussion(passage);
  await host.plugin.send('请解释这段材料', host.plugin.selectedQuote);
  const draft = await host.plugin.generateConcept();
  assert.equal(host.calls.length, 2);
  assert.deepEqual(plain(draft.input.relatedNotes[0]), {
    path: passage.path, title: passage.title, excerpt: passage.text.slice(0, 900),
  });
  assert.deepEqual(organizationInput.relatedNotes[0], plain(draft.input.relatedNotes[0]));
  assert.equal(organizationInput.messages[0].content, '请解释这段材料');
  assert.deepEqual(organizationInput.messages[0].noteQuote, passage);
  assert.equal(host.reads.includes(passage.path), false);
  assert.equal(JSON.stringify(host.calls).includes(sentinel), false);
  const body = host.conceptBody(draft);
  assert.ok(body.includes('[[阅读/路径依赖|路径依赖]]：原始选段展示了选择成本如何延续。'));
  const savedPath = await host.plugin.saveConcept(draft, '路径依赖', body);
  assert.ok(host.records.get(savedPath).text.includes('[[阅读/路径依赖|路径依赖]]'));
  assert.equal(host.records.get(passage.path).text, originalSource);
  assert.equal(host.reads.includes(passage.path), false);
});

test('selection discussion: after acceptance a network failure preserves the saved quote and clears only its composer attachment', async () => {
  const host = await ready({ responder: () => { throw new TypeError('Failed to fetch'); } });
  await host.plugin.prepareNoteDiscussion(selectedPassage);
  assert.equal(await host.plugin.send('解释这段话', host.plugin.selectedQuote), true);
  assert.equal(host.plugin.selectedQuote, null);
  assert.equal(host.plugin.messages[0].content, '解释这段话');
  assert.deepEqual(plain(host.plugin.messages[0].noteQuote), selectedPassage);
  assert.equal(host.plugin.messages[1].status, 'error');
  assert.equal(host.calls.length, 1);
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.deepEqual(plain(restored.plugin.messages[0].noteQuote), selectedPassage);
});

test('selection discussion: missing key, busy state or user-save failure retains the selected passage before acceptance', async () => {
  for (const failure of ['missing-key', 'busy', 'save']) {
    const host = await ready({ apiKey: failure === 'missing-key' ? null : 'local-test-key' });
    await host.plugin.prepareNoteDiscussion(selectedPassage);
    const quote = host.plugin.selectedQuote;
    if (failure === 'busy') {
      host.plugin.state = 'connecting';
      assert.equal(await host.plugin.send('解释这段话', quote), false);
      host.plugin.state = 'idle';
    } else {
      if (failure === 'save') host.failUserSave(true);
      await assert.rejects(host.plugin.send('解释这段话', quote), failure === 'save' ? /user disk write failed/ : /API Key/);
    }
    assert.equal(host.plugin.selectedQuote, quote);
    assert.equal(host.calls.length, 0);
    assert.equal(host.plugin.messages.length, 0);
    host.plugin.onunload();
  }
});

test('selection discussion: accepting an older attachment does not clear a newer selection', async () => {
  const host = await ready();
  await host.plugin.prepareNoteDiscussion(selectedPassage);
  const originalQuote = host.plugin.selectedQuote;
  let reachedUserSave;
  let releaseUserSave;
  const reached = new Promise(resolve => { reachedUserSave = resolve; });
  const blocked = new Promise(resolve => { releaseUserSave = resolve; });
  const originalCreate = host.app.vault.create;
  host.app.vault.create = async (name, text) => {
    if (name.endsWith('.json') && JSON.parse(text).role === 'user') { reachedUserSave(); await blocked; }
    return originalCreate(name, text);
  };
  const sending = host.plugin.send('解释旧的选段', originalQuote);
  await reached;
  await host.plugin.prepareNoteDiscussion({ path: '阅读/新概念.md', title: '新概念', text: '这是后来选中的文字。' }, true);
  const newerQuote = host.plugin.selectedQuote;
  host.plugin.clearSelectedQuote(originalQuote);
  assert.equal(host.plugin.selectedQuote, newerQuote);
  releaseUserSave();
  assert.equal(await sending, true);
  assert.equal(host.plugin.selectedQuote, newerQuote);
  assert.deepEqual(plain(host.plugin.messages[0].noteQuote), selectedPassage);
  assert.equal(host.calls[0].messages.at(-1).content.includes(newerQuote.text), false);
  host.plugin.clearSelectedQuote(newerQuote);
  assert.equal(host.plugin.selectedQuote, null);
});

test('selection discussion: excerpt and encoded combined-input limits reject before any message is accepted', async () => {
  const host = await ready();
  await host.plugin.prepareNoteDiscussion(selectedPassage);
  const staged = host.plugin.selectedQuote;
  const stagedSession = host.plugin.session;
  await assert.rejects(host.plugin.send('解释', { ...selectedPassage, text: '段'.repeat(8_001) }));
  await assert.rejects(host.plugin.send('问'.repeat(12_000), { ...selectedPassage, text: '段'.repeat(8_000) }));
  assert.equal(host.plugin.selectedQuote, staged);
  assert.equal(host.calls.length, 0);
  assert.equal(host.plugin.session, stagedSession, 'invalid input keeps the already-created empty conversation');
  assert.equal(host.plugin.messages.length, 0);
});

test('selection discussion: reading menu captures a passage in its own window and leaves unrelated menus alone', async () => {
  const host = await ready();
  const listeners = new Map();
  let currentText = selectedPassage.text;
  const start = {}, end = {}, outside = {};
  let range = { startContainer: start, endContainer: end };
  const selection = { isCollapsed: false, rangeCount: 1, toString: () => currentText, getRangeAt: () => range };
  const doc = {
    defaultView: { getSelection: () => selection, navigator: {} },
    addEventListener: (name, callback) => {
      const handlers = listeners.get(name) ?? []; handlers.push(callback); listeners.set(name, handlers);
    },
    removeEventListener: (name, callback) => listeners.set(name, (listeners.get(name) ?? []).filter(handler => handler !== callback)),
  };
  const view = host.addReadingLeaf(doc, selectedPassage.path, [start, end]);
  host.emitWorkspace('window-open', {}, { document: doc });
  host.emitWorkspace('window-open', {}, { document: doc });
  assert.equal(listeners.get('contextmenu').length, 1, 'each document should have one context menu listener');
  let prevented = 0;
  let stopped = 0;
  const trigger = target => listeners.get('contextmenu')[0]({
    target, preventDefault: () => prevented++, stopPropagation: () => stopped++,
  });
  trigger(outside);
  assert.equal(prevented, 0);
  assert.equal(host.shownMenus.length, 0);
  range = { startContainer: start, endContainer: outside };
  trigger(start);
  assert.equal(prevented, 0, 'a range extending outside the note must not become a note quote');
  range = { startContainer: start, endContainer: end };
  trigger(start);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(host.shownMenus.length, 1);
  const discuss = host.shownMenus[0].menu.items.find(item => item.title === '在漫游中讨论');
  assert.ok(discuss);
  assert.ok(host.shownMenus[0].menu.items.some(item => item.title === '在当前漫游中继续'),
    'reading-mode menus should expose the same explicit continuation choice');
  currentText = '打开菜单后选择变化';
  view.file = new TFile('阅读/另一篇笔记.md');
  discuss.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
  assert.equal(host.calls.length, 0);
});

test('selection discussion: reading command validates selection boundaries across notes and window documents', async () => {
  const host = await ready();
  const aStart = {}, aEnd = {}, bStart = {};
  let range = { startContainer: aStart, endContainer: aEnd };
  let collapsed = false;
  const docA = { defaultView: { getSelection: () => ({
    isCollapsed: collapsed, rangeCount: 1, toString: () => selectedPassage.text, getRangeAt: () => range,
  }) } };
  const docB = { defaultView: { getSelection: () => null } };
  const viewA = host.addReadingLeaf(docA, selectedPassage.path, [aStart, aEnd]);
  const viewB = host.addReadingLeaf(docB, '阅读/其他窗口.md', [bStart]);
  host.setActiveNoteView(viewA);
  const command = host.plugin.commands.get('discuss-selection');
  assert.equal(command.checkCallback(true), true);
  range = { startContainer: aStart, endContainer: bStart };
  assert.equal(command.checkCallback(true), false);
  range = { startContainer: aStart, endContainer: aEnd };
  host.setActiveNoteView(viewB);
  assert.equal(command.checkCallback(true), false, 'selection from another window is not the active note selection');
  host.setActiveNoteView(viewA);
  collapsed = true;
  assert.equal(command.checkCallback(true), false);
  collapsed = false;
  assert.equal(command.checkCallback(false), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(host.plugin.selectedQuote), selectedPassage);
  assert.equal(host.calls.length, 0);
});

test('selection discussion: malformed persisted attribution is rejected without rewriting chat data', async () => {
  const original = await ready();
  await original.plugin.send('普通聊天');
  const user = original.plugin.messages[0];
  const userRecord = [...original.records.values()].find(record => record.file.path.endsWith(`/${user.id}.json`));
  const saved = JSON.parse(userRecord.text);
  saved.noteQuote = { text: '格式错误的同步引用', path: 'https://example.com/remote.md', title: '外部页面' };
  userRecord.text = JSON.stringify(saved);
  const before = userRecord.text;
  original.plugin.onunload();
  const restored = fakeHost({ records: original.records, storage: original.storage });
  await restored.plugin.onload();
  await assert.rejects(restored.plugin.ready, /笔记引用/);
  assert.equal(userRecord.text, before);
  assert.equal(restored.calls.length, 0);
  assert.equal(restored.plugin.messages.length, 0);
  restored.plugin.onunload();
});

test('controller: sends real streaming payload; reload recovers history and excludes credentials from saved data', async () => {
  const host = await ready();
  assert.equal(await host.plugin.send('问题'), true);
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].stream, true);
  assert.equal(host.calls[0].thinking.type, 'disabled');
  assert.equal(host.plugin.messages[1].status, 'complete');
  assert.equal(host.plugin.messages[1].content, '回答');
  assert.equal(host.storage.has('concept-roamer:pending-v1'), false);
  assert.equal(JSON.stringify([...host.records]).includes('local-test-key'), false);
  host.plugin.onunload();
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.deepEqual(JSON.parse(JSON.stringify(restored.plugin.chain().map(message => message.content))), ['问题', '回答']);
  await restored.plugin.send('继续');
  assert.equal(restored.calls[0].messages.length, 4);
});

test('controller: no key creates no session and makes no request', async () => {
  const host = await ready({ apiKey: null });
  await assert.rejects(host.plugin.send('问题'), /API Key/);
  assert.equal(host.calls.length, 0);
  assert.equal(host.plugin.session, null);
});

test('controller: save failure keeps draft and blocks new sessions until retry succeeds', async () => {
  const host = await ready();
  host.failSave(true);
  await host.plugin.send('问题');
  assert.equal(host.plugin.hasPendingSave(), true);
  assert.equal(host.storage.has('concept-roamer:pending-v1'), true);
  await assert.rejects(host.plugin.newSession(), /重试保存/);
  host.failSave(false);
  await host.plugin.retrySave();
  assert.equal(host.plugin.hasPendingSave(), false);
  assert.equal(host.storage.has('concept-roamer:pending-v1'), false);
  await host.plugin.newSession();
});

test('controller: reload of a completed but unsaved draft preserves complete status', async () => {
  const host = await ready();
  host.failSave(true);
  await host.plugin.send('问题');
  host.plugin.onunload();
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.equal(restored.plugin.messages.find(message => message.role === 'assistant').status, 'complete');
  assert.equal(restored.storage.has('concept-roamer:pending-v1'), false);
});

test('controller: updates to persona and explicit memory are read on each request', async () => {
  const host = await ready();
  host.records.get('概念漫游/人格.md').text = '用生活例子解释';
  host.records.get('概念漫游/全局记忆.md').text = '我主要使用 Windows 与 Android';
  await host.plugin.send('问题');
  assert.match(host.calls[0].messages[0].content, /用生活例子/);
  assert.match(host.calls[0].messages[0].content, /Windows 与 Android/);
});

test('controller: stop during an active stream preserves partial output and does not retry', async () => {
  let first;
  const received = new Promise(resolve => { first = resolve; });
  const host = await ready({ responder: options => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分回答"}}]}\n\n'));
      options.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('stopped'), { name: 'AbortError' })));
      first();
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const sending = host.plugin.send('问题');
  await received;
  await new Promise(resolve => setTimeout(resolve, 5));
  host.plugin.stop();
  await sending;
  assert.equal(host.plugin.messages[1].content, '部分回答');
  assert.equal(host.plugin.messages[1].status, 'stopped');
  assert.equal(host.calls.length, 1);
  assert.equal(host.plugin.state, 'idle');
});

test('controller: unloading during stream restores partial reply without racing another write', async () => {
  let first;
  const received = new Promise(resolve => { first = resolve; });
  const host = await ready({ responder: options => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"恢复文字"}}]}\n\n'));
      options.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      first();
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const sending = host.plugin.send('问题');
  await received;
  await new Promise(resolve => setTimeout(resolve, 5));
  host.plugin.onunload();
  await sending;
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.equal(restored.plugin.messages.find(message => message.role === 'assistant').content, '恢复文字');
  assert.equal(restored.storage.has('concept-roamer:pending-v1'), false);
});

test('startup regression: existing folders and persona work while the vault index is empty', async () => {
  const original = await ready();
  original.records.get('概念漫游/人格.md').text = '用户自定义人格，必须保留';
  await original.plugin.send('已经保存的讨论');
  original.plugin.onunload();
  const restarted = await ready({ records: original.records, storage: original.storage, indexVisible: false });
  assert.deepEqual(restarted.createAttempts, []);
  assert.equal(restarted.records.get('概念漫游/人格.md').text, '用户自定义人格，必须保留');
  assert.equal(restarted.plugin.chain().length, 2);
});

test('startup regression: initialization waits for layout without blocking plugin load', async () => {
  const host = fakeHost({ layoutInitiallyReady: false });
  await host.plugin.onload();
  assert.equal(host.records.size, 0);
  let initialized = false;
  void host.plugin.ready.then(() => { initialized = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(initialized, false);
  host.finishLayout();
  await host.plugin.ready;
  assert.equal(host.records.has('概念漫游/人格.md'), true);
});

test('startup regression: concurrent directory creation is accepted after actual disk check', async () => {
  const host = await ready({ indexVisible: false, raceFolderPath: '概念漫游' });
  assert.equal(host.records.has('概念漫游/全局记忆.md'), true);
});

test('startup regression: a file occupying the folder path still fails and is not overwritten', async () => {
  const records = new Map([['概念漫游', { file: new TFile('概念漫游'), text: 'existing content' }]]);
  const host = fakeHost({ records, indexVisible: false });
  await host.plugin.onload();
  await assert.rejects(host.plugin.ready, /目录被文件占用/);
  assert.equal(records.get('概念漫游').text, 'existing content');
});

function organizationResponder(options) {
  const payload = JSON.parse(options.body);
  let body = '回答';
  if (payload.response_format) {
    const source = JSON.parse(payload.messages[1].content);
    body = JSON.stringify({
      title: '路径依赖', definition: '早期选择会影响后续选择空间。', mechanism: '既有投入与切换成本。',
      examples: ['已经形成习惯的工作流程。'], boundaries: ['条件改变后，原路径可能被打破。'], applications: ['分析改变规则的成本。'],
      userStatements: [], openQuestions: ['怎样降低切换成本？'], related: [], sources: [],
      summary: `从“${source.messages[0].content}”讨论了路径依赖及其边界。`,
    });
  }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: body }, finish_reason: null }] })}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

function streamedText(body, finishReason = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: body }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

function titleResponder(options) {
  const payload = JSON.parse(options.body);
  return streamedText(payload.response_format ? '{"title":"路径依赖与改变的成本"}' : '完整的回答');
}

test('desktop bundle: guarded CommonJS https streams chat and automatic title without browser fetch', async () => {
  const host = await ready({
    platform: { isDesktop: true, isDesktopApp: true, isMobileApp: false },
    automaticTitles: true, responder: titleResponder,
  });
  assert.equal(host.moduleLoads.includes('https'), false, 'desktop module is not loaded during startup');
  await host.plugin.send('什么是路径依赖？');
  await host.plugin.updateAutomaticTitle();
  assert.equal(host.plugin.messages[1].status, 'complete');
  assert.equal(host.plugin.messages[1].content, '完整的回答');
  assert.equal(host.plugin.session.title, '路径依赖与改变的成本');
  assert.equal(host.nativeRequests.length, 2);
  assert.equal(host.calls.length, 2);
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(host.moduleLoads.filter(name => name === 'https').length, 2);
  assert.equal(host.nativeRequests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(host.nativeRequests[0].options.headers.Accept, 'text/event-stream');
  host.plugin.onunload();
});

for (const [label, platform, transport] of [
  ['Android', { isDesktop: false, isDesktopApp: false, isMobileApp: true }, 'auto'],
  ['desktop with Web transport', { isDesktop: true, isDesktopApp: true, isMobileApp: false }, 'browser'],
]) {
  test(`platform routing: ${label} streams chat and title without loading https`, async () => {
    const host = await ready({ platform, transport, automaticTitles: true, responder: titleResponder });
    await host.plugin.send('什么是路径依赖？');
    await host.plugin.updateAutomaticTitle();
    assert.equal(host.plugin.messages[1].status, 'complete');
    assert.equal(host.plugin.session.title, '路径依赖与改变的成本');
    assert.equal(host.fetchCalls.length, 2);
    assert.equal(host.nativeRequests.length, 0);
    assert.equal(host.moduleLoads.includes('https'), false);
    host.plugin.onunload();
  });
}

test('desktop runtime TypeError retains diagnostic detail and hides the API key in saved errors', async () => {
  const apiKey = 'sk-fake-desktop-key';
  const host = await ready({
    platform: { isDesktop: true, isDesktopApp: true, isMobileApp: false }, apiKey,
    httpsRequest: () => { throw new TypeError(`Desktop loader failed for ${apiKey}`); },
  });
  await host.plugin.send('问题');
  assert.equal(host.plugin.messages[1].status, 'error');
  assert.equal(host.plugin.messages[1].error, '插件运行错误：Desktop loader failed for [密钥已隐藏]');
  assert.equal(host.plugin.status, host.plugin.messages[1].error);
  assert.equal(host.plugin.messages[1].content, '');
  assert.equal(host.nativeRequests.length, 1);
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(JSON.stringify([...host.records]).includes(apiKey), false);
  assert.equal(JSON.stringify([...host.storage]).includes(apiKey), false);
  host.plugin.onunload();
});

test('browser fetch TypeError reports a Web connection failure instead of a plugin runtime error', async () => {
  const host = await ready({ responder: () => { throw new TypeError('Failed to fetch'); } });
  await host.plugin.send('问题');
  assert.equal(host.plugin.messages[1].status, 'error');
  assert.match(host.plugin.messages[1].error, /Web 流式连接失败/);
  assert.doesNotMatch(host.plugin.messages[1].error, /插件运行错误/);
  assert.equal(host.fetchCalls.length, 1);
  assert.equal(host.moduleLoads.includes('https'), false);
  host.plugin.onunload();
});

test('automatic title is persisted and restored without adding a chat turn or sending persona and memory', async () => {
  const host = await ready({ automaticTitles: true, responder: titleResponder });
  await host.plugin.send('什么是路径依赖？');
  await host.plugin.updateAutomaticTitle();
  assert.equal(host.plugin.session.title, '路径依赖与改变的成本');
  assert.equal(host.plugin.messages.length, 2);
  assert.equal(host.calls.length, 2);
  assert.equal(host.calls[1].thinking.type, 'disabled');
  assert.equal(host.calls[1].max_tokens, 128);
  assert.equal(host.calls[1].messages.length, 2);
  assert.equal(JSON.stringify(host.calls[1]).includes('用户明确保存的背景与偏好'), false);
  const original = [...host.records].find(([name]) => name.endsWith('/会话.json'))[1].text;
  assert.equal(JSON.parse(original).title, '什么是路径依赖？', 'original metadata remains immutable');
  host.plugin.onunload();
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.equal(restored.plugin.session.title, '路径依赖与改变的成本');
});

test('automatic naming is enabled by default for existing settings', async () => {
  const host = await ready({ automaticTitles: null, responder: titleResponder });
  assert.equal(host.plugin.settings.automaticTitles, true);
  await host.plugin.send('什么是路径依赖？');
  await host.plugin.updateAutomaticTitle();
  assert.equal(host.plugin.session.title, '路径依赖与改变的成本');
});

test('automatic titles update after three more completed turns and respect a manually fixed title', async () => {
  const host = await ready({ automaticTitles: true, responder: titleResponder });
  for (let turn = 1; turn <= 4; turn++) {
    await host.plugin.send(`第 ${turn} 个问题`);
    await host.plugin.updateAutomaticTitle();
    assert.equal(host.calls.filter(call => call.response_format).length, turn === 4 ? 2 : 1);
  }
  await host.plugin.renameSession('我保存的概念讨论', false);
  for (let turn = 0; turn < 3; turn++) {
    await host.plugin.send('继续讨论');
    await host.plugin.updateAutomaticTitle();
  }
  assert.equal(host.plugin.session.title, '我保存的概念讨论');
  assert.equal(host.calls.filter(call => call.response_format).length, 2);
  await host.plugin.renameSession('恢复自动命名', true);
  await host.plugin.send('讨论转换成本');
  await host.plugin.updateAutomaticTitle();
  assert.equal(host.plugin.session.title, '路径依赖与改变的成本');
});

test('background naming does not block chat and cannot replace the title of a different session', async () => {
  let releaseTitle;
  let titleStarted;
  const started = new Promise(resolve => { titleStarted = resolve; });
  const waiting = new Promise(resolve => { releaseTitle = resolve; });
  const host = await ready({ automaticTitles: true, responder: async options => {
    if (JSON.parse(options.body).response_format) { titleStarted(); await waiting; }
    return titleResponder(options);
  } });
  await host.plugin.send('什么是路径依赖？');
  await started;
  const previousId = host.plugin.session.id;
  const naming = host.plugin.updateAutomaticTitle();
  assert.equal(host.plugin.state, 'idle');
  assert.equal(host.plugin.hasPendingSave(), false);
  await host.plugin.newSession();
  releaseTitle();
  await naming;
  assert.equal(host.plugin.session.title, '新的探索');
  const sessions = await host.plugin.store.sessions();
  assert.equal(sessions.find(session => session.id === previousId).title, '路径依赖与改变的成本');
});

test('manual rename wins while model naming is in flight', async () => {
  let releaseTitle;
  let titleStarted;
  const started = new Promise(resolve => { titleStarted = resolve; });
  const waiting = new Promise(resolve => { releaseTitle = resolve; });
  const host = await ready({ automaticTitles: true, responder: async options => {
    if (JSON.parse(options.body).response_format) { titleStarted(); await waiting; }
    return titleResponder(options);
  } });
  await host.plugin.send('什么是路径依赖？');
  await started;
  const naming = host.plugin.updateAutomaticTitle();
  await host.plugin.renameSession('保留这个手动标题', false);
  releaseTitle();
  await naming;
  assert.equal(host.plugin.session.title, '保留这个手动标题');
  assert.equal(host.plugin.session.titleMode, 'manual');
});

test('malformed or truncated naming leaves the saved answer and title intact', async () => {
  for (const [titleBody, finishReason] of [['无效 JSON', 'stop'], ['{"title":"不完整"}', 'length']]) {
    const host = await ready({ automaticTitles: true, responder: options => JSON.parse(options.body).response_format
      ? streamedText(titleBody, finishReason) : streamedText('完整回答') });
    await host.plugin.send('什么是路径依赖？');
    await host.plugin.updateAutomaticTitle();
    assert.equal(host.plugin.session.title, '什么是路径依赖？');
    assert.equal(host.plugin.messages[1].status, 'complete');
    assert.equal(host.plugin.status, '回复已保存。');
    assert.equal(host.plugin.hasPendingSave(), false);
  }
});

test('disabling automatic titles creates no naming request; incomplete replies are not named', async () => {
  const disabled = await ready({ responder: titleResponder });
  await disabled.plugin.send('什么是路径依赖？');
  await disabled.plugin.updateAutomaticTitle();
  assert.equal(disabled.calls.length, 1);
  const incomplete = await ready({ automaticTitles: true, responder: () => streamedText('达到限制', 'length') });
  await incomplete.plugin.send('什么是路径依赖？');
  await incomplete.plugin.updateAutomaticTitle();
  assert.equal(incomplete.calls.length, 1);
});

test('a title storage failure does not change saved reply status or prevent another message', async () => {
  const host = await ready({ automaticTitles: true, responder: titleResponder });
  const originalCreate = host.app.vault.create;
  host.app.vault.create = async (name, text) => {
    if (name.includes('/标题/')) throw new Error('title storage unavailable');
    return originalCreate(name, text);
  };
  await host.plugin.send('什么是路径依赖？');
  await host.plugin.updateAutomaticTitle();
  assert.equal(host.plugin.session.title, '什么是路径依赖？');
  assert.equal(host.plugin.status, '回复已保存。');
  assert.equal(host.plugin.hasPendingSave(), false);
  assert.equal(await host.plugin.send('再举一个例子'), true);
  await host.plugin.updateAutomaticTitle();
});

test('an explicitly created chat retains a useful provisional title if naming fails', async () => {
  const host = await ready({ automaticTitles: true, responder: options => streamedText(
    JSON.parse(options.body).response_format ? '无效命名结果' : '完整回答') });
  await host.plugin.newSession();
  await host.plugin.send('为什么会产生路径依赖？');
  await host.plugin.updateAutomaticTitle();
  assert.equal(host.plugin.session.title, '为什么会产生路径依赖？');
  const restored = await ready({ records: host.records, storage: host.storage });
  assert.equal(restored.plugin.session.title, '为什么会产生路径依赖？');
});

test('opening an existing chat can name it without inserting a new message', async () => {
  const original = await ready({ responder: titleResponder });
  await original.plugin.send('什么是路径依赖？');
  original.plugin.onunload();
  const restored = await ready({ records: original.records, storage: original.storage,
    automaticTitles: true, responder: titleResponder });
  await restored.plugin.updateAutomaticTitle();
  assert.equal(restored.plugin.session.title, '路径依赖与改变的成本');
  assert.equal(restored.plugin.messages.length, 2);
  assert.equal(restored.calls.length, 1);
});

test('disabling naming or unloading discards an in-flight title response', async () => {
  for (const action of ['disable', 'unload']) {
    let releaseTitle;
    let titleStarted;
    const started = new Promise(resolve => { titleStarted = resolve; });
    const waiting = new Promise(resolve => { releaseTitle = resolve; });
    const host = await ready({ automaticTitles: true, responder: async options => {
      if (JSON.parse(options.body).response_format) { titleStarted(); await waiting; }
      return titleResponder(options);
    } });
    await host.plugin.send('什么是路径依赖？');
    await started;
    const naming = host.plugin.updateAutomaticTitle();
    if (action === 'disable') await host.plugin.setAutomaticTitles(false);
    else host.plugin.onunload();
    releaseTitle();
    await naming;
    assert.equal(host.plugin.session.title, '什么是路径依赖？');
    assert.equal([...host.records.keys()].filter(name => name.includes('/标题/')).length, 0);
  }
});

test('concept workflow: second model call organizes discussion; saving creates a note and a linked summary', async () => {
  const host = await ready({ responder: organizationResponder });
  await host.plugin.send('请解释路径依赖');
  const draft = await host.plugin.generateConcept('路径依赖');
  assert.equal(host.calls.length, 2);
  assert.equal(host.calls[1].response_format.type, 'json_object');
  assert.equal(host.plugin.messages.length, 2, 'organizer should not insert a fake chat turn');
  const body = '## 定义\n\n我在预览中编辑了定义。';
  const path = await host.plugin.saveConcept(draft, '路径依赖', body);
  assert.equal(path, '概念漫游/概念/路径依赖.md');
  assert.match(host.records.get(path).text, /我在预览中编辑了定义/);
  const summary = [...host.records].find(([path]) => path.includes('/整理摘要/') && path.endsWith('.md'));
  assert.ok(summary);
  assert.match(summary[1].text, /概念漫游\/概念\/路径依赖/);
  assert.equal(host.storage.has('concept-roamer:concept-draft-v1'), false);
});

test('concept workflow: existing note is preserved and a separate filename is used', async () => {
  const host = await ready({ responder: organizationResponder });
  await host.plugin.send('请解释路径依赖');
  host.records.set('概念漫游/概念/路径依赖.md', { file: new TFile('概念漫游/概念/路径依赖.md'), text: '用户已有笔记' });
  const draft = await host.plugin.generateConcept();
  const path = await host.plugin.saveConcept(draft, '路径依赖', '## 定义\n\n新的整理');
  assert.notEqual(path, '概念漫游/概念/路径依赖.md');
  assert.equal(host.records.get('概念漫游/概念/路径依赖.md').text, '用户已有笔记');
});

test('concept workflow: malformed organization output writes no concept file and retains original chat', async () => {
  const host = await ready();
  await host.plugin.send('请解释路径依赖');
  await assert.rejects(host.plugin.generateConcept(), /JSON 不完整/);
  assert.equal(host.plugin.messages.length, 2);
  assert.equal([...host.records.keys()].filter(path => path.startsWith('概念漫游/概念/')).length, 0);
  assert.equal(host.plugin.state, 'idle');
});

test('concept workflow: summary write failure can retry without creating a second concept note', async () => {
  const host = await ready({ responder: organizationResponder });
  await host.plugin.send('请解释路径依赖');
  const draft = await host.plugin.generateConcept();
  const originalCreate = host.app.vault.create;
  host.app.vault.create = async (path, text) => {
    if (path.includes('/整理摘要/')) throw new Error('summary write failed');
    return originalCreate(path, text);
  };
  await assert.rejects(host.plugin.saveConcept(draft, '路径依赖', '## 定义\n\n早期选择影响后续。'), /摘要保存失败/);
  assert.ok(draft.savedNote);
  assert.equal(host.storage.has('concept-roamer:concept-draft-v1'), true);
  await assert.rejects(host.plugin.generateConcept(), /继续保存上一份/);
  host.app.vault.create = originalCreate;
  const path = await host.plugin.saveConcept(draft, '路径依赖', '## 定义\n\n早期选择影响后续。');
  assert.equal(path, draft.savedNote.path);
  assert.equal([...host.records.keys()].filter(path => path.startsWith('概念漫游/概念/') && path.endsWith('.md')).length, 1);
});

const compressionPayload = payload => payload.messages?.[0]?.content.startsWith('生成会话的上下文摘要');
const compressionResult = overrides => ({
  topic: '路径依赖', summary: '保留讨论方向的上下文测试摘要。',
  userStatements: [], openQuestions: ['怎样降低切换成本？'], disagreements: [], ...overrides,
});
const compressionResponder = options => {
  const payload = JSON.parse(options.body);
  return streamedText(compressionPayload(payload) ? JSON.stringify(compressionResult()) : '新的完整回答');
};

async function seedCompressionHistory(host, { turns = 9, characters = 900, quote = selectedPassage } = {}) {
  await host.plugin.newSession();
  const messages = [];
  let parentId = null;
  for (let turn = 0; turn < turns; turn++) {
    for (const role of ['user', 'assistant']) {
      const marker = `${role === 'user' ? '原始用户问题' : '原始助手解释'}-${turn}-`;
      const message = {
        schemaVersion: 1, id: webcrypto.randomUUID(), sessionId: host.plugin.session.id,
        parentId, role, content: marker + '材料'.repeat(Math.ceil(characters / 2)), status: 'complete',
        createdAt: new Date(Date.UTC(2026, 9, 2, 0, turn, role === 'user' ? 0 : 1)).toISOString(),
        ...(turn === 0 && role === 'user' && quote ? { noteQuote: quote } : {}),
      };
      await host.plugin.store.saveMessage(message);
      messages.push(message);
      parentId = message.id;
    }
  }
  host.plugin.messages = messages;
  host.plugin.activeLeaf = parentId;
  host.plugin.saveActive();
  return messages;
}

function savedMessageTexts(host) {
  return [...host.records].filter(([name]) => name.includes('/消息/') && name.endsWith('.json'))
    .map(([name, record]) => [name, record.text]);
}

async function appendCompressionTurns(host, turns = 5) {
  const added = [];
  let parentId = host.plugin.activeLeaf;
  for (let turn = 0; turn < turns; turn++) {
    for (const role of ['user', 'assistant']) {
      const message = {
        schemaVersion: 1, id: webcrypto.randomUUID(), sessionId: host.plugin.session.id,
        parentId, role, content: `后续${role}-${turn}-` + '新增材料'.repeat(150), status: 'complete',
        createdAt: new Date(Date.UTC(2026, 9, 2, 5, turn, role === 'user' ? 0 : 1)).toISOString(),
      };
      await host.plugin.store.saveMessage(message);
      added.push(message); parentId = message.id;
    }
  }
  host.plugin.messages.push(...added);
  host.plugin.activeLeaf = parentId;
  host.plugin.saveActive();
  return added;
}

test('context compression: manual compression replaces request history while preserving every original record and transcript', async () => {
  const host = await ready({ responder: compressionResponder });
  const original = await seedCompressionHistory(host);
  const diskBefore = savedMessageTexts(host);
  const leafBefore = host.plugin.activeLeaf;
  const summary = await host.plugin.compressContext();
  assert.equal(host.plugin.contextSummary.id, summary.id);
  assert.equal(summary.sessionId, host.plugin.session.id);
  assert.equal(summary.coveredIds[0], original[0].id);
  assert.equal(summary.throughId, summary.coveredIds.at(-1));
  assert.deepEqual(savedMessageTexts(host), diskBefore, 'compression must never rewrite chat records');
  assert.equal(host.plugin.activeLeaf, leafBefore);
  assert.equal(host.plugin.messages.length, original.length);
  assert.equal(host.plugin.state, 'idle');
  assert.equal(host.calls.length, 1, 'manual compression adds no conversation message');
  assert.equal(host.calls[0].thinking.type, 'disabled');
  assert.equal(JSON.stringify(host.calls[0]).includes('用户明确保存的背景与偏好'), false);
  assert.ok(host.records.has(`概念漫游/会话/${summary.sessionId}/上下文/${summary.id}.json`));
  await host.plugin.send('根据这次讨论继续解释');
  const wire = JSON.stringify(host.calls.at(-1).messages);
  assert.match(wire, /上下文测试摘要/);
  assert.doesNotMatch(wire, /原始用户问题-0-/);
  assert.match(wire, /原始用户问题-8-/);
  host.app.workspace.openLinkText = async () => undefined;
  await host.plugin.exportTranscript();
  const transcript = [...host.records].find(([name]) => name.startsWith('概念漫游/导出/') && name.endsWith('.md'))[1].text;
  assert.match(transcript, /原始用户问题-0-/);
  assert.match(transcript, /原始助手解释-0-/);
  assert.match(transcript, /早期的选择会改变后续选择的成本/);
  assert.doesNotMatch(transcript, /上下文测试摘要/);
  host.plugin.onunload();
});

test('context compression: reloading selects the matching saved summary and disabling its use restores raw request context', async () => {
  const host = await ready({ responder: compressionResponder });
  await seedCompressionHistory(host);
  const summary = await host.plugin.compressContext();
  host.plugin.onunload();
  const restored = await ready({ records: host.records, storage: host.storage, responder: compressionResponder });
  assert.equal(restored.plugin.contextSummary.id, summary.id);
  assert.equal(restored.plugin.messages.length, 18);
  restored.plugin.settings.useCompressedContext = false;
  await restored.plugin.send('查看原始上下文');
  const wire = JSON.stringify(restored.calls[0].messages);
  assert.match(wire, /原始用户问题-0-/);
  assert.doesNotMatch(wire, /上下文测试摘要/);
  assert.equal(restored.calls.length, 1);
  assert.equal(restored.records.has(`概念漫游/会话/${summary.sessionId}/上下文/${summary.id}.json`), true);
  restored.plugin.onunload();
});

test('context compression: another branch cannot adopt an unrelated summary; a shared covered prefix remains usable', async () => {
  const host = await ready({ responder: compressionResponder });
  const original = await seedCompressionHistory(host);
  const session = host.plugin.session;
  const summary = await host.plugin.compressContext();
  const sibling = {
    ...original[2], id: webcrypto.randomUUID(), parentId: original[1].id,
    content: '分支 B 独立问题', createdAt: '2026-10-02T03:00:00.000Z',
  };
  await host.plugin.store.saveMessage(sibling);
  await host.plugin.loadSession(session, sibling.id);
  assert.equal(host.plugin.contextSummary, null);
  await host.plugin.send('继续分支 B');
  const wire = JSON.stringify(host.calls.at(-1).messages);
  assert.match(wire, /分支 B 独立问题/);
  assert.match(wire, /原始用户问题-0-/);
  assert.doesNotMatch(wire, /上下文测试摘要/);
  assert.doesNotMatch(wire, /原始用户问题-8-/);
  const sharedSibling = {
    ...sibling, id: webcrypto.randomUUID(), parentId: summary.throughId,
    content: '从已覆盖的共同前缀分叉', createdAt: '2026-10-02T04:00:00.000Z',
  };
  await host.plugin.store.saveMessage(sharedSibling);
  await host.plugin.loadSession(session, sharedSibling.id);
  assert.equal(host.plugin.contextSummary.id, summary.id);
  await host.plugin.send('继续共享前缀的分支');
  assert.match(JSON.stringify(host.calls.at(-1).messages), /上下文测试摘要/);
  assert.doesNotMatch(JSON.stringify(host.calls.at(-1).messages), /分支 B 独立问题/);
  host.plugin.onunload();
});

test('context compression: changed synced source text invalidates an otherwise matching summary', async () => {
  const host = await ready({ responder: compressionResponder });
  const original = await seedCompressionHistory(host);
  await host.plugin.compressContext();
  const path = `概念漫游/会话/${host.plugin.session.id}/消息/${original[0].id}.json`;
  const saved = JSON.parse(host.records.get(path).text);
  saved.content = '同步后原文发生了变化，旧摘要不能再代表这段对话。';
  host.records.get(path).text = JSON.stringify(saved, null, 2);
  host.plugin.onunload();
  const restored = await ready({ records: host.records, storage: host.storage, responder: compressionResponder });
  assert.equal(restored.plugin.contextSummary, null);
  assert.equal(restored.plugin.messages[0].content, saved.content);
  assert.equal(restored.calls.length, 0);
  restored.plugin.onunload();
});

test('context compression: quoting selected note text as the user opinion rejects the result without changing chat or selection', async () => {
  let userId;
  const host = await ready({ responder: options => {
    const payload = JSON.parse(options.body);
    return streamedText(compressionPayload(payload) ? JSON.stringify(compressionResult({
      userStatements: [{ messageId: userId, quote: selectedPassage.text }],
    })) : '正常回答');
  } });
  const original = await seedCompressionHistory(host);
  userId = original[0].id;
  await host.plugin.prepareNoteDiscussion(selectedPassage, true);
  const diskBefore = savedMessageTexts(host);
  const quoteBefore = host.plugin.selectedQuote;
  const leafBefore = host.plugin.activeLeaf;
  await assert.rejects(host.plugin.compressContext(), /用户|原话|引用/);
  assert.deepEqual(savedMessageTexts(host), diskBefore);
  assert.equal(host.plugin.activeLeaf, leafBefore);
  assert.equal(host.plugin.selectedQuote, quoteBefore);
  assert.equal(host.plugin.contextSummary, null);
  assert.equal(host.plugin.state, 'idle');
  assert.equal([...host.records.keys()].some(name => name.includes('/上下文/') && name.endsWith('.json')), false);
  host.plugin.onunload();
});

test('context compression: automatic compression happens before accepting a new question and keeps its selected material distinct', async () => {
  const host = await ready({ responder: compressionResponder });
  const original = await seedCompressionHistory(host, { characters: 1900 });
  const originalCount = original.length;
  let recordedDuringCompression;
  // Assert from the request boundary: the new user message must not exist while the summary is being generated.
  const originalFetch = host.calls;
  const create = host.app.vault.create;
  host.app.vault.create = async (name, text) => {
    if (name.includes('/上下文/') && name.endsWith('.json')) recordedDuringCompression = host.plugin.messages.length;
    return create(name, text);
  };
  await host.plugin.prepareNoteDiscussion(selectedPassage, true);
  assert.equal(await host.plugin.send('新的带引用问题', host.plugin.selectedQuote), true);
  assert.ok(originalFetch.some(compressionPayload));
  assert.equal(recordedDuringCompression, originalCount);
  assert.equal(host.plugin.messages.length, originalCount + 2);
  assert.equal(host.plugin.messages.at(-2).content, '新的带引用问题');
  assert.deepEqual(plain(host.plugin.messages.at(-2).noteQuote), selectedPassage);
  assert.equal(host.plugin.selectedQuote, null);
  const chat = originalFetch.filter(payload => !compressionPayload(payload));
  assert.equal(chat.length, 1);
  assert.match(JSON.stringify(chat[0].messages), /上下文测试摘要/);
  assert.match(chat[0].messages.at(-1).content, /新的带引用问题/);
  assert.match(chat[0].messages.at(-1).content, /不能仅凭引用推断用户的观点或认同/);
  host.plugin.onunload();
});

test('context compression: automatic failure falls back to full raw history only within the existing safety budget', async () => {
  for (const failure of ['invalid', 'http', 'save']) {
    const host = await ready({ responder: options => {
      const payload = JSON.parse(options.body);
      if (compressionPayload(payload)) {
        if (failure === 'http') return new Response('unavailable', { status: 503 });
        if (failure === 'invalid') return streamedText('无效摘要 JSON');
      }
      return compressionResponder(options);
    } });
    await seedCompressionHistory(host, { characters: 1900 });
    const diskBefore = savedMessageTexts(host);
    if (failure === 'save') {
      const create = host.app.vault.create;
      host.app.vault.create = async (name, text) => {
        if (name.includes('/上下文/')) throw new Error('context storage unavailable');
        return create(name, text);
      };
    }
    assert.equal(await host.plugin.send(`失败后继续 ${failure}`), true);
    const chat = host.calls.filter(payload => !compressionPayload(payload));
    assert.equal(chat.length, 1);
    assert.match(JSON.stringify(chat[0].messages), /原始用户问题-0-/);
    assert.doesNotMatch(JSON.stringify(chat[0].messages), /上下文测试摘要/);
    assert.deepEqual(savedMessageTexts(host).slice(0, diskBefore.length), diskBefore);
    assert.equal(host.plugin.contextSummary, null);
    assert.equal(host.plugin.hasPendingSave(), false);
    assert.equal(host.plugin.state, 'idle');
    host.plugin.onunload();
  }
});

test('context compression: failed automatic compression beyond the raw budget accepts no new question and keeps the quote', async () => {
  const host = await ready({ responder: options => compressionPayload(JSON.parse(options.body))
    ? streamedText('摘要格式错误') : streamedText('不应调用聊天') });
  await seedCompressionHistory(host, { turns: 24, characters: 2100 });
  await host.plugin.prepareNoteDiscussion(selectedPassage, true);
  const messagesBefore = plain(host.plugin.messages);
  const leafBefore = host.plugin.activeLeaf;
  const diskBefore = savedMessageTexts(host);
  const quoteBefore = host.plugin.selectedQuote;
  await assert.rejects(host.plugin.send('不能在预算外偷偷忽略旧内容', quoteBefore), /上下文|压缩|摘要|预算/);
  assert.equal(host.calls.filter(payload => !compressionPayload(payload)).length, 0);
  assert.deepEqual(plain(host.plugin.messages), messagesBefore);
  assert.deepEqual(savedMessageTexts(host), diskBefore);
  assert.equal(host.plugin.activeLeaf, leafBefore);
  assert.equal(host.plugin.selectedQuote, quoteBefore);
  assert.equal(host.plugin.hasPendingSave(), false);
  assert.equal(host.plugin.state, 'idle');
  host.plugin.onunload();
});

test('context compression: stop during automatic compression cancels before question acceptance and leaves original history intact', async () => {
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const host = await ready({ responder: options => {
    if (!compressionPayload(JSON.parse(options.body))) return streamedText('不应调用聊天');
    entered();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('compression stopped'), { name: 'AbortError' }));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
  } });
  await seedCompressionHistory(host, { characters: 1900 });
  await host.plugin.prepareNoteDiscussion(selectedPassage, true);
  const diskBefore = savedMessageTexts(host);
  const countBefore = host.plugin.messages.length;
  const leafBefore = host.plugin.activeLeaf;
  const quoteBefore = host.plugin.selectedQuote;
  const sending = host.plugin.send('压缩中停止的新问题', quoteBefore);
  await began;
  assert.equal(host.plugin.state, 'compressing');
  assert.equal(host.plugin.hasPendingSave(), false);
  assert.equal(await host.plugin.send('压缩中不能插入另一个问题'), false);
  await assert.rejects(host.plugin.newSession(), /等待/);
  await assert.rejects(host.plugin.prepareNoteDiscussion({ ...selectedPassage, text: '不能开启新会话' }), /等待/);
  host.plugin.stop();
  await assert.rejects(sending, /停止|取消|中止/);
  assert.deepEqual(savedMessageTexts(host), diskBefore);
  assert.equal(host.plugin.messages.length, countBefore);
  assert.equal(host.plugin.activeLeaf, leafBefore);
  assert.equal(host.plugin.selectedQuote, quoteBefore);
  assert.equal(host.plugin.contextSummary, null);
  assert.equal(host.plugin.state, 'idle');
  assert.equal(host.calls.filter(payload => !compressionPayload(payload)).length, 0);
  host.plugin.onunload();
});

test('context compression: a complete turn too large for a summary request falls back to bounded raw context', async () => {
  const host = await ready({ responder: compressionResponder });
  const original = await seedCompressionHistory(host, { turns: 3, characters: 50, quote: null });
  original[0].content = '不可拆开的旧问题-' + '旧'.repeat(19000);
  original[1].content = '不可拆开的旧解释-' + '解释'.repeat(12500);
  for (const message of original.slice(0, 2)) {
    const path = `概念漫游/会话/${message.sessionId}/消息/${message.id}.json`;
    host.records.get(path).text = JSON.stringify(message, null, 2);
  }
  const before = savedMessageTexts(host);
  assert.equal(await host.plugin.send('大轮次无法压缩时仍可使用完整上下文'), true);
  assert.equal(host.calls.filter(compressionPayload).length, 0, 'the planner must not truncate a turn to fit');
  assert.equal(host.calls.length, 1);
  assert.match(JSON.stringify(host.calls[0].messages), /不可拆开的旧解释/);
  assert.deepEqual(savedMessageTexts(host).slice(0, before.length), before);
  host.plugin.onunload();
});

test('context compression: incremental summaries retain exact earlier user statements even if the model omits them', async () => {
  let firstUser;
  let summaries = 0;
  const sources = [];
  const host = await ready({ responder: options => {
    const payload = JSON.parse(options.body);
    if (!compressionPayload(payload)) return streamedText('正常回答');
    sources.push(JSON.parse(payload.messages[1].content));
    summaries++;
    return streamedText(JSON.stringify(compressionResult({
      summary: `第 ${summaries} 次上下文测试摘要`,
      userStatements: summaries === 1 ? [{ messageId: firstUser.id, quote: '原始用户问题-0-' }] : [],
    })));
  } });
  firstUser = (await seedCompressionHistory(host))[0];
  const first = await host.plugin.compressContext();
  const originalCovered = plain(first.coveredIds);
  await appendCompressionTurns(host);
  const second = await host.plugin.compressContext();
  assert.equal(sources[1].previous.id, first.id);
  assert.equal(sources[1].previous.result.userStatements[0].messageId, firstUser.id);
  assert.equal(sources[1].messages.some(message => originalCovered.includes(message.messageId)), false,
    'incremental compression supplies only the new source suffix after the earlier summary');
  assert.ok(second.coveredIds.length > first.coveredIds.length);
  assert.deepEqual(plain(second.coveredIds.slice(0, first.coveredIds.length)), originalCovered);
  assert.deepEqual(plain(second.result.userStatements), [{ messageId: firstUser.id, quote: '原始用户问题-0-' }]);
  const rebuilt = await host.plugin.compressContext(true);
  assert.equal(sources.at(-1).previous, null);
  assert.equal(sources.at(-1).messages[0].messageId, firstUser.id,
    'rebuild starts from the real source rather than another summary');
  assert.equal(rebuilt.coveredIds[0], firstUser.id);
  assert.equal([...host.records.keys()].filter(name => name.includes('/上下文/') && name.endsWith('.json')).length, 3);
  host.plugin.onunload();
});

test('context compression: large old history is processed in bounded batches and preserves recent original turns', async () => {
  const host = await ready({ responder: compressionResponder });
  const original = await seedCompressionHistory(host, { turns: 24, characters: 2100 });
  const countBefore = original.length;
  const before = savedMessageTexts(host);
  assert.equal(await host.plugin.send('大历史分批压缩后继续'), true);
  const summaries = host.calls.filter(compressionPayload);
  assert.ok(summaries.length >= 2 && summaries.length <= 4);
  for (const call of summaries) {
    const source = JSON.parse(call.messages[1].content);
    assert.ok(JSON.stringify(source.messages).length <= 40000);
  }
  const chat = host.calls.filter(payload => !compressionPayload(payload));
  assert.equal(chat.length, 1);
  const wire = JSON.stringify(chat[0].messages);
  assert.match(wire, /上下文测试摘要/);
  assert.match(wire, /原始用户问题-23-/);
  assert.doesNotMatch(wire, /原始用户问题-0-/);
  assert.ok(chat[0].messages.slice(1).reduce((size, message) => size + message.content.length, 0) <= 80000);
  assert.equal(host.plugin.messages.length, countBefore + 2);
  assert.deepEqual(savedMessageTexts(host).slice(0, before.length), before);
  host.plugin.onunload();
});

test('context compression: organizing a saved conversation uses raw messages and note excerpts instead of compressed context', async () => {
  let organizationInput;
  const host = await ready({ responder: options => {
    const payload = JSON.parse(options.body);
    if (compressionPayload(payload)) return compressionResponder(options);
    if (payload.response_format) organizationInput = JSON.parse(payload.messages[1].content);
    return organizationResponder(options);
  } });
  const original = await seedCompressionHistory(host, { characters: 100 });
  await host.plugin.compressContext();
  await host.plugin.generateConcept('路径依赖');
  assert.equal(organizationInput.messages.length, original.length);
  assert.equal(organizationInput.messages[0].content, original[0].content);
  assert.deepEqual(organizationInput.messages[0].noteQuote, selectedPassage);
  assert.doesNotMatch(JSON.stringify(organizationInput), /上下文测试摘要/);
  assert.equal(host.plugin.messages.length, original.length);
  host.plugin.onunload();
});
