import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTitleRevisions, parseConversationTitle, titleMessages, TitleRevision } from '../src/titles';
import { Message, Session } from '../src/model';

const session: Session = { schemaVersion: 1, id: 'session', title: '旧标题', createdAt: '2026-10-01T00:00:00Z' };
function revision(id: string, parentRevisionId: string | null, origin: 'user' | 'model', title: string): TitleRevision {
  return { schemaVersion: 1, id, sessionId: session.id, parentRevisionId, title,
    mode: origin === 'user' ? 'manual' : 'auto', origin, createdAt: '2026-10-01T00:00:00Z', completedTurns: 1, leafId: null };
}

test('title revisions resolve deterministically across sync order; concurrent manual title wins', () => {
  const a = revision('a', null, 'model', 'AI 标题');
  const b = revision('b', null, 'user', '手动标题');
  const c = revision('c', 'a', 'model', '旧分支后续标题');
  for (const entries of [[a, b, c], [c, b, a], [b, a, c]]) {
    assert.equal(applyTitleRevisions(session, entries).title, '手动标题');
    assert.equal(applyTitleRevisions(session, entries).titleMode, 'manual');
  }
});

test('missing title revision parent waits for synchronization without hiding chat', () => {
  const child = revision('child', 'missing', 'model', '新标题');
  assert.equal(applyTitleRevisions(session, [child]).title, '旧标题');
  const parent = revision('missing', null, 'model', '中间标题');
  assert.equal(applyTitleRevisions(session, [child, parent]).title, '新标题');
});

test('title parser rejects truncation, multiline text, markup and overlong results', () => {
  assert.equal(parseConversationTitle('{"title":"路径依赖与改变的成本"}'), '路径依赖与改变的成本');
  for (const raw of ['null', '[]', '{"title":', '{"title":"第一行\\n第二行"}', '{"title":"[[关联]]"}', JSON.stringify({ title: '长'.repeat(41) })]) {
    assert.throws(() => parseConversationTitle(raw));
  }
});

test('naming includes bounded opening and recent dialogue, excluding unfinished assistant output', () => {
  const messages: Message[] = Array.from({ length: 40 }, (_, i) => ({ schemaVersion: 1, id: String(i),
    sessionId: session.id, parentId: i ? String(i - 1) : null, role: i % 2 ? 'assistant' : 'user',
    content: `${i}:` + '字'.repeat(2000), status: 'complete', createdAt: session.createdAt }));
  messages.push({ ...messages[0], id: 'unfinished', role: 'assistant', content: '不能用于命名的未完成内容', status: 'stopped' });
  const payload = titleMessages(messages, session.title);
  const input = JSON.parse(payload[1].content);
  assert.equal(input.messages.length, 10);
  assert.ok(input.messages[0].content.startsWith('0:'));
  assert.ok(input.messages.at(-1).content.startsWith('39:'));
  assert.ok(input.messages.every((message: { content: string }) => Array.from(message.content).length <= 700));
  assert.ok(!payload[1].content.includes('未完成'));
  const short = JSON.parse(titleMessages(messages.slice(0, 2), session.title)[1].content);
  assert.equal(short.messages.length, 2, 'short conversation should not duplicate messages');
});
