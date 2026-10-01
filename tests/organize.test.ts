import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConceptDraft, OrganizationInput, conceptBody, conceptMarkdown, organizationMessages,
  parseConceptResult, safeNoteTitle, summaryMarkdown,
} from '../src/organize';
import { noteQuote } from '../src/selection';

const input: OrganizationInput = {
  sessionId: 'session', leafId: 'reply', focus: '路径依赖',
  messages: [
    { schemaVersion: 1, id: 'user', sessionId: 'session', parentId: null, role: 'user', status: 'complete',
      content: '我觉得它和社区规则有关。参考 https://example.com/source', createdAt: 'now' },
    { schemaVersion: 1, id: 'reply', sessionId: 'session', parentId: 'user', role: 'assistant', status: 'complete',
      content: '路径依赖解释了历史选择对后续选择的影响。', createdAt: 'now' },
  ],
  relatedNotes: [{ path: '城市/社区治理.md', title: '社区治理', excerpt: '社区制度的变化。' }],
};
const result = () => ({
  title: '路径依赖', definition: '早期选择影响后续可选路径。', mechanism: '切换成本与制度惯性。',
  examples: ['早期平台形成既有使用习惯。'], boundaries: ['强外部变化可能打破原有路径。'],
  applications: ['分析社区规则的调整成本。'], userStatements: [{ messageId: 'user', quote: '我觉得它和社区规则有关。' }],
  openQuestions: ['何种条件下可以改变路径？'], related: [{ path: '城市/社区治理.md', reason: '用于分析制度调整成本。' }],
  sources: [{ url: 'https://example.com/source', title: '讨论中提供的材料' }], summary: '从社区规则的问题讨论路径依赖，仍需验证切换成本。',
});
const draft = (): ConceptDraft => ({
  schemaVersion: 1, id: 'concept', createdAt: 'now', model: 'test', input,
  result: parseConceptResult(JSON.stringify(result()), input),
});

test('organization creates an independent concept note and linked summary instead of a transcript', () => {
  const body = conceptBody(draft());
  assert.match(body, /## 定义/);
  assert.match(body, /## 核心机制/);
  assert.match(body, /## 适用边界与反例/);
  assert.match(body, /\[\[城市\/社区治理\|社区治理\]\]/);
  assert.match(body, /待核验/);
  assert.doesNotMatch(body, /## AI|## 我 ·|用户：|助手：/);
  const markdown = conceptMarkdown(draft(), '路径依赖', body);
  assert.match(markdown, /# 路径依赖/);
  assert.match(markdown, /tags: \[concept\]/);
  assert.match(summaryMarkdown(draft(), '概念漫游/概念/路径依赖.md'), /\[\[概念漫游\/概念\/路径依赖\]\]/);
});

test('assistant statements and invented quotations cannot become user views', () => {
  const data = result();
  data.userStatements = [{ messageId: 'reply', quote: input.messages[1].content }];
  assert.throws(() => parseConceptResult(JSON.stringify(data), input), /非用户原话/);
  data.userStatements = [{ messageId: 'user', quote: '我已经完全认同这个观点。' }];
  assert.throws(() => parseConceptResult(JSON.stringify(data), input), /非用户原话/);
});

test('unprovided source URLs and note paths are rejected before saving', () => {
  const data = result();
  data.sources[0].url = 'invalid-url';
  assert.throws(() => parseConceptResult(JSON.stringify(data), input), /来源链接格式/);
  data.sources[0].url = 'https://invented.example/article';
  assert.throws(() => parseConceptResult(JSON.stringify(data), input), /没有出现的来源/);
  data.sources = [];
  data.related[0].path = '不存在的笔记.md';
  assert.throws(() => parseConceptResult(JSON.stringify(data), input), /未提供的笔记路径/);
});

test('asking questions alone does not require a fabricated user-views section', () => {
  const data = result(); data.userStatements = [];
  const note = { ...draft(), result: parseConceptResult(JSON.stringify(data), input) };
  assert.doesNotMatch(conceptBody(note), /我明确表达/);
});

test('incomplete JSON and missing definition cannot be saved as a concept', () => {
  assert.throws(() => parseConceptResult('{"title":"', input), /JSON 不完整/);
  assert.throws(() => parseConceptResult(JSON.stringify({ ...result(), definition: '' }), input), /定义/);
});

test('generated wiki links outside validated relationships are rendered literally', () => {
  const note = draft(); note.result.definition += ' [[伪造节点]]';
  assert.match(conceptBody(note), /\\\[\\\[伪造节点/);
});

test('note title cannot traverse folders or use reserved Windows device names', () => {
  assert.equal(safeNoteTitle('路径/依赖:测试'), '路径 依赖 测试');
  assert.equal(safeNoteTitle('CON'), '概念 CON');
  assert.throws(() => safeNoteTitle('..'), /有效/);
});

test('organization prompt includes message IDs and excludes incomplete assistant output', () => {
  const source = { ...input, messages: [...input.messages, { ...input.messages[1], id: 'stopped', status: 'stopped' as const }] };
  const payload = JSON.parse(organizationMessages(source)[1].content);
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].id, 'user');
});

test('selected excerpts remain separate material and cannot be attributed to the user', () => {
  const quoted = noteQuote('我已经完全认同这个观点。', '材料/路径依赖.md', '路径依赖');
  const source = { ...input, messages: [{ ...input.messages[0], content: '解释这段话。', noteQuote: quoted }] };
  const prompts = organizationMessages(source);
  const payload = JSON.parse(prompts[1].content);
  assert.equal(payload.messages[0].content, '解释这段话。');
  assert.deepEqual(payload.messages[0].noteQuote, quoted);
  assert.match(prompts[0].content, /不能引用 noteQuote 来推断用户认同/);
  const data = result();
  data.sources = [];
  data.userStatements = [{ messageId: 'user', quote: quoted.text }];
  assert.throws(() => parseConceptResult(JSON.stringify(data), source), /非用户原话/);
  const explicitlyStated = { ...source, messages: [{ ...source.messages[0], content: quoted.text }] };
  assert.equal(parseConceptResult(JSON.stringify(data), explicitlyStated).userStatements[0].quote, quoted.text);
});

test('source URLs from selected material are accepted as supplied references without inventing user views', () => {
  const source = { ...input, messages: [{ ...input.messages[0], content: '这个材料说了什么？',
    noteQuote: noteQuote('材料来源 https://example.com/selected', '材料/出处.md', '出处') }] };
  const data = result();
  data.userStatements = [];
  data.sources = [{ url: 'https://example.com/selected', title: '选区中的来源' }];
  assert.equal(parseConceptResult(JSON.stringify(data), source).sources[0].url, 'https://example.com/selected');
});
