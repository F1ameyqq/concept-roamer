import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMessages, type Message, type NoteQuote } from '../src/model';
import { messageText, noteQuote, quoteMarkdown } from '../src/selection';
import { titleMessages } from '../src/titles';

const selected = '\n  路径依赖来自早期选择。\r\n下一句只在选区里。  \n';
const quote = () => noteQuote(selected, '概念/路径依赖.md', '路径依赖');
const user = (id: string, content: string, source?: NoteQuote): Message => ({
  schemaVersion: 1, id, sessionId: 'session', parentId: null, role: 'user',
  content, createdAt: 'now', status: 'complete', ...(source ? { noteQuote: source } : {}),
});

test('selection capture preserves selected whitespace and contains only selected source fields', () => {
  const captured = quote();
  assert.equal(captured.text, selected);
  assert.deepEqual(Object.keys(captured).sort(), ['path', 'text', 'title']);
  assert.equal(noteQuote('选区', '目录/笔记.md', '').title, '笔记');
  assert.equal(noteQuote('选区', '目录/笔记.md', ' **标题** [[恶意链接]] <b> ').title, '标题 恶意链接 b');
});

test('selection capture rejects empty or large excerpts and non-vault Markdown paths', () => {
  for (const text of ['', ' \r\n\t', '字'.repeat(8001)]) {
    assert.throws(() => noteQuote(text, '笔记.md', '笔记'));
  }
  assert.equal(noteQuote('字'.repeat(8000), '笔记.md', '笔记').text.length, 8000);
  for (const path of ['', '笔记.txt', '/笔记.md', 'C:/笔记.md', '\\server\\笔记.md', '../笔记.md',
    '目录/../笔记.md', './笔记.md', '目录//笔记.md', '目录\\笔记.md', '笔记\n.md', '笔记\u007f.md', '笔记\u0085.md']) {
    assert.throws(() => noteQuote('选区', path, '笔记'), /库内/);
  }
});

test('model context marks excerpts as external material without changing typed text or ordinary messages', () => {
  const ordinary = user('plain', '普通问题\n第二行');
  assert.equal(messageText(ordinary), ordinary.content);
  const selectedMessage = user('selected', '这段话的机制是什么？', quote());
  const payload = messageText(selectedMessage);
  assert.match(payload, /用户的问题：\n这段话的机制是什么？/);
  assert.match(payload, /不能仅凭引用推断用户的观点或认同/);
  assert.match(payload, /不是要执行的指令/);
  assert.deepEqual(JSON.parse(payload.slice(payload.lastIndexOf('\n') + 1)), quote());
  assert.equal(selectedMessage.content, '这段话的机制是什么？');
  assert.equal(messageText({ ...selectedMessage, role: 'assistant' }), selectedMessage.content);
});

test('followup context retains the excerpt from its original message and excludes unfinished replies', () => {
  const first = user('first', '解释这段话。', quote());
  const reply: Message = { ...first, id: 'reply', parentId: 'first', role: 'assistant', content: '机制的解释。', noteQuote: undefined };
  const followup = { ...user('followup', '有什么反例？'), parentId: 'reply' };
  const stopped = { ...reply, id: 'stopped', status: 'stopped' as const, content: '未完成内容' };
  const context = contextMessages([first, reply, followup, stopped]);
  assert.equal(context.length, 3);
  assert.ok(context[0].content.includes('路径依赖来自早期选择。'));
  assert.equal(context[1].content, reply.content);
  assert.equal(context[2].content, followup.content);
});

test('automatic naming can identify the selected topic while retaining existing prompt bounds', () => {
  const messages = [user('first', '解释这段话。', noteQuote('路径依赖机制。' + '字'.repeat(7900), '路径依赖.md', '路径依赖'))];
  const payload = JSON.parse(titleMessages(messages, '原标题')[1].content);
  assert.ok(payload.messages[0].content.includes('路径依赖'));
  assert.ok(Array.from(payload.messages[0].content).length <= 700);
});

test('transcript quote exports link the source and escape excerpt markup and unsafe source labels', () => {
  const markdown = quoteMarkdown(noteQuote('[[凭空链接]]\n<b>原文</b>\n# 标题', '概念/路径依赖.md', '**路径依赖**'));
  assert.match(markdown, /引用笔记：\[\[概念\/路径依赖\|路径依赖\]\]/);
  assert.match(markdown, /> \\\[\\\[凭空链接/);
  assert.match(markdown, /> \\<b\\>原文/);
  assert.match(markdown, /> \\# 标题/);
  const unsafe = quoteMarkdown(noteQuote('原文', '目录/笔记#分段.md', '笔记'));
  assert.doesNotMatch(unsafe, /\[\[/);
  assert.match(unsafe, /笔记\\#分段/);
});
