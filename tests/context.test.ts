import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { type Message, contextMessages } from '../src/model';
import {
  AUTO_CONTEXT_CHARS, MAX_CONTEXT_CHARS, type CompressionPlan, type ContextResult, type ContextSummary,
  contextSize, planCompression, createContextSummary, selectContextSummary,
  summaryMessages, summaryHistory, validateContextSummary,
} from '../src/context';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const uuid = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const sessionId = uuid(900000);
function chain(turns: number, size = 30): Message[] {
  return Array.from({ length: turns * 2 }, (_, index) => ({ schemaVersion: 1, id: uuid(index + 1), sessionId,
    parentId: index ? uuid(index) : null, role: index % 2 ? 'assistant' : 'user', status: 'complete',
    content: `${index % 2 ? '解释' : '问题'} ${index}：` + '内容'.repeat(Math.ceil(size / 2)).slice(0, size),
    createdAt: '2026-10-02T00:00:00Z' }));
}
function result(overrides: Partial<ContextResult> = {}): ContextResult {
  return { topic: '概念与机制', summary: '讨论了概念的机制、反例和仍未解决的问题。',
    userStatements: [], openQuestions: ['如何验证这个机制？'], disagreements: ['这个解释的适用范围仍有分歧。'], ...overrides };
}
async function summary(messages: Message[], overrides: Partial<ContextResult> = {}): Promise<ContextSummary> {
  return createContextSummary(planCompression(messages, null)!, JSON.stringify(result(overrides)), 'deepseek-chat');
}

test('context size counts the actual serialized history content, including selected note material', () => {
  assert.equal(AUTO_CONTEXT_CHARS, 32000);
  assert.equal(MAX_CONTEXT_CHARS, 80000);
  assert.equal(contextSize([{ content: '中文' }, { content: '😀' }]), 4);
  const messages = chain(1);
  messages[0].noteQuote = { path: '概念/反馈.md', title: '反馈', text: '引用材料'.repeat(20) };
  assert.equal(contextSize(contextMessages(messages)), contextMessages(messages).reduce((size, entry) => size + entry.content.length, 0));
  assert.ok(contextSize(contextMessages(messages)) > messages.reduce((size, entry) => size + entry.content.length, 0));
});

test('compression retains the last four complete turns and never consumes an unanswered question', () => {
  const messages = chain(9);
  const unanswered: Message = { ...messages[0], id: uuid(100), parentId: messages.at(-1)!.id, content: '最新问题还没有回答' };
  messages.push(unanswered);
  const plan = planCompression(messages, null)!;
  assert.equal(plan.prefix.length, 10);
  assert.equal(plan.messages.length, 10);
  assert.equal(plan.throughId, messages[9].id);
  assert.equal(plan.prefix.at(-1)!.role, 'assistant');
  assert.equal(messages.slice(plan.prefix.length).filter(message => message.role === 'assistant').length, 4);
  assert.equal(messages.at(-1), unanswered);
  assert.ok(!plan.prefix.some(message => message.id === unanswered.id));
});

test('short dialogue does not compress fewer than two completed turns', () => {
  for (const turns of [0, 1, 2, 3, 4, 5]) assert.equal(planCompression(chain(turns), null), null);
  assert.equal(planCompression(chain(6), null)!.prefix.filter(message => message.role === 'assistant').length, 2);
});

test('oversized recent dialogue can reduce retained turns without dropping the latest turn or pending user', () => {
  const messages = chain(8, 8000);
  const unanswered: Message = { ...messages[0], id: uuid(100), parentId: messages.at(-1)!.id, content: '最新未回答的字'.repeat(500) };
  messages.push(unanswered);
  let previous: ContextSummary | null = null;
  const first = planCompression(messages, previous)!;
  assert.ok(first.prefix.length <= 4, 'bounded batch must first consume only the oldest source');
  assert.ok(!first.prefix.includes(unanswered));
  assert.equal(first.prefix.at(-1)!.status, 'complete');
});

test('summary creation hashes a stable canonical original prefix and keeps all message files untouched', async () => {
  const messages = chain(8);
  messages[0].noteQuote = { path: '概念/反馈.md', title: '反馈', text: '这是选中的来源材料。' };
  const before = JSON.stringify(messages);
  const plan = planCompression(messages, null)!;
  const created = await createContextSummary(plan, JSON.stringify(result({ userStatements: [{ messageId: messages[0].id, quote: '问题 0' }] })), 'deepseek-chat');
  const canonical = JSON.stringify(plan.prefix.map(message => ({ id: message.id, parentId: message.parentId,
    role: message.role, status: message.status, content: message.content,
    noteQuote: message.noteQuote ? { path: message.noteQuote.path, title: message.noteQuote.title, text: message.noteQuote.text } : null })));
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).toString('hex');
  assert.equal(created.sourceHash, expected);
  assert.equal(created.sessionId, sessionId);
  assert.equal(created.throughId, plan.throughId);
  assert.deepEqual(created.coveredIds, plan.prefix.map(message => message.id));
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(await selectContextSummary(messages, [created]), created);
});

test('selection ignores summaries for forks, missing synced parents, different sessions or modified source', async () => {
  const messages = chain(9);
  const created = await summary(messages);
  assert.equal(await selectContextSummary(messages.slice(1), [created]), null, 'missing root source');
  assert.equal(await selectContextSummary(messages.slice(0, 4), [created]), null, 'not-yet-synced source');
  const fork = structuredClone(messages);
  fork[6].id = uuid(100);
  fork[7].parentId = fork[6].id;
  assert.equal(await selectContextSummary(fork, [created]), null);
  assert.equal(await selectContextSummary(messages.map(message => ({ ...message, sessionId: uuid(999) })), [created]), null);
  for (const mutate of [
    (source: Message[]) => { source[2].content += '修改过'; },
    (source: Message[]) => { source[3].status = 'stopped'; },
    (source: Message[]) => { source[2].role = 'assistant'; },
    (source: Message[]) => { source[2].noteQuote = { path: '笔记.md', title: '笔记', text: '新引用' }; },
    (source: Message[]) => { source[2].parentId = uuid(444); },
  ]) {
    const source = structuredClone(messages);
    mutate(source);
    assert.equal(await selectContextSummary(source, [created]), null);
  }
});

test('hash excludes non-semantic dates and note property order but binds every quote field', async () => {
  const messages = chain(8);
  messages[0].noteQuote = { path: '原文.md', title: '原文', text: '来源文本' };
  const created = await summary(messages);
  const reordered = structuredClone(messages);
  reordered[0].noteQuote = { text: '来源文本', title: '原文', path: '原文.md' };
  reordered[0].createdAt = '2020-01-01T00:00:00Z';
  assert.ok(await selectContextSummary(reordered, [created]));
  for (const field of ['path', 'title', 'text'] as const) {
    const changed = structuredClone(messages);
    changed[0].noteQuote![field] = field === 'path' ? '不同原文.md' : `不同${field}`;
    assert.equal(await selectContextSummary(changed, [created]), null);
  }
});

test('selection deterministically picks the furthest valid summary and falls back from invalid newer files', async () => {
  const messages = chain(12);
  const first = await summary(messages.slice(0, 16));
  const nextPlan = planCompression(messages, first)!;
  const latest = await createContextSummary(nextPlan, JSON.stringify(result()), 'deepseek-chat');
  assert.ok(latest.coveredIds.length > first.coveredIds.length);
  const corrupted = { ...latest, sourceHash: 'f'.repeat(64) };
  for (const candidates of [[latest, first], [first, latest]]) {
    assert.equal((await selectContextSummary(messages, candidates))!.id, latest.id);
  }
  assert.equal((await selectContextSummary(messages, [corrupted, first]))!.id, first.id);
  const tieA = { ...latest, id: uuid(9901), createdAt: '2026-10-02T01:00:00Z' };
  const tieB = { ...latest, id: uuid(9902), createdAt: '2026-10-02T01:00:00Z' };
  assert.equal((await selectContextSummary(messages, [tieA, tieB]))!.id, tieB.id);
  assert.equal((await selectContextSummary(messages, [tieB, tieA]))!.id, tieB.id);
});

test('unattributed user claims, paraphrases and quotations from assistant or note material are rejected', async () => {
  const messages = chain(8);
  messages[0].content = '我想检验这个机制，尚未认同。';
  messages[0].noteQuote = { path: '材料.md', title: '材料', text: '用户肯定赞成引用材料。' };
  messages[1].content = 'AI 说用户肯定赞成。';
  const plan = planCompression(messages, null)!;
  for (const statement of [
    { messageId: messages[0].id, quote: '用户肯定赞成引用材料。' },
    { messageId: messages[1].id, quote: 'AI 说用户肯定赞成。' },
    { messageId: messages[0].id, quote: '我认同这个机制。' },
    { messageId: uuid(999), quote: '我想检验这个机制' },
    { messageId: messages.at(-2)!.id, quote: messages.at(-2)!.content },
  ]) {
    await assert.rejects(createContextSummary(plan, JSON.stringify(result({ userStatements: [statement] })), 'deepseek-chat'), /原话/);
  }
  const valid = await createContextSummary(plan, JSON.stringify(result({ userStatements: [{ messageId: messages[0].id, quote: '尚未认同。' }] })), 'deepseek-chat');
  assert.equal(valid.result.userStatements[0].quote, '尚未认同。');
  const poisoned = { ...valid, result: result({ userStatements: [{ messageId: messages[0].id, quote: messages[0].noteQuote.text }] }) };
  assert.equal(await selectContextSummary(messages, [poisoned]), null);
});

test('incremental compression includes prior summary and only new source; no advance makes no plan', async () => {
  const messages = chain(10);
  const first = await summary(messages, { userStatements: [{ messageId: messages[0].id, quote: '问题 0' }] });
  assert.equal(planCompression(messages, first), null);
  const extended = chain(13);
  const plan = planCompression(extended, first)!;
  assert.deepEqual(plan.messages.map(message => message.id), extended.slice(first.coveredIds.length, plan.prefix.length).map(message => message.id));
  const payload = summaryMessages(plan);
  assert.match(payload[0].content, /上下文摘要/);
  const input = JSON.parse(payload[1].content);
  assert.equal(input.previous.id, first.id);
  assert.equal(input.previous.throughId, first.throughId);
  assert.deepEqual(input.previous.result, first.result);
  assert.ok(input.messages.every((message: { messageId: string }) => !first.coveredIds.includes(message.messageId)));
  const merged = await createContextSummary(plan, JSON.stringify(result()), 'deepseek-chat');
  assert.deepEqual(merged.result.userStatements, first.result.userStatements, 'model cannot silently erase prior exact quotes');
  const deduped = await createContextSummary(plan, JSON.stringify(result({ userStatements: first.result.userStatements })), 'deepseek-chat');
  assert.deepEqual(deduped.result.userStatements, first.result.userStatements);
});

test('incremental creation verifies the previous hash again before publishing a new summary', async () => {
  const messages = chain(10);
  const first = await summary(messages);
  const extended = chain(13);
  extended[0].content += '发生原文改动';
  const plan = planCompression(extended, first)!;
  await assert.rejects(createContextSummary(plan, JSON.stringify(result()), 'deepseek-chat'), /格式/);
});

test('large historical source is processed through advancing complete batches without omission', async () => {
  const messages = chain(100, 1000);
  let previous: ContextSummary | null = null;
  let batches = 0;
  while (true) {
    const plan = planCompression(messages, previous);
    if (!plan) break;
    const input = JSON.parse(summaryMessages(plan)[1].content);
    assert.ok(JSON.stringify(input.messages).length <= 40000);
    assert.equal(plan.messages[0].id, messages[plan.previous?.coveredIds.length ?? 0].id);
    assert.equal(plan.prefix.at(-1)!.role, 'assistant');
    previous = await createContextSummary(plan, JSON.stringify(result()), 'deepseek-chat');
    batches++;
    assert.ok(batches < 20, 'planner must eventually stop advancing');
  }
  assert.ok(batches > 1);
  assert.equal(previous!.coveredIds.length, 192, 'retain eight messages from the last four complete turns');
  assert.deepEqual(previous!.coveredIds, messages.slice(0, 192).map(message => message.id));
  assert.equal(summaryHistory(messages, previous).length, 9);
});

test('a source turn exceeding request capacity fails explicitly without skipping or truncating', () => {
  const messages = chain(10, 1000);
  messages[0].content = '首轮超长问题'.repeat(8000);
  const before = JSON.stringify(messages);
  assert.throws(() => planCompression(messages, null), /停止截断或跳过/);
  assert.equal(JSON.stringify(messages), before);
});

test('unfinished assistants remain raw records but cannot enter compression or model history', async () => {
  const messages = chain(10);
  messages[1].status = 'interrupted';
  messages[1].content = '这段被中断的敏感输出不能作为上下文';
  messages[3].status = 'truncated';
  messages[3].content = '这个超限回复不能被补全';
  const plan = planCompression(messages, null)!;
  assert.ok(plan.prefix.some(message => message.id === messages[1].id), 'hash coverage still binds interrupted original');
  const prompt = summaryMessages(plan);
  const inputs = JSON.parse(prompt[1].content).messages;
  assert.ok(!inputs.some((message: { messageId: string }) => [messages[1].id, messages[3].id].includes(message.messageId)));
  assert.ok(!prompt[1].content.includes('敏感输出'));
  const generated = await createContextSummary(plan, JSON.stringify(result()), 'deepseek-chat');
  const projected = summaryHistory(messages, generated);
  assert.ok(!JSON.stringify(projected).includes('敏感输出'));
  assert.equal(messages[1].content, '这段被中断的敏感输出不能作为上下文');
});

test('source metadata retains note paths, titles and literal URLs with traceable message IDs', async () => {
  const messages = chain(9);
  messages[0].noteQuote = { path: '概念/反馈.md', title: '反馈', text: '引用 https://example.org/paper' };
  messages[0].content = '看看 [原文](https://example.org/reference)。';
  messages[1].content = '未核验来源 https://example.org/review';
  messages[2].noteQuote = { ...messages[0].noteQuote };
  const generated = await summary(messages);
  const plan = planCompression(messages, null)!;
  const input = JSON.parse(summaryMessages(plan)[1].content);
  assert.deepEqual(input.sources.notes, [{ messageId: messages[0].id, path: '概念/反馈.md', title: '反馈' }]);
  assert.deepEqual(input.sources.urls.map((source: { url: string }) => source.url), [
    'https://example.org/reference', 'https://example.org/paper', 'https://example.org/review',
  ]);
  const projected = summaryHistory(messages, generated);
  assert.equal(projected[0].role, 'user');
  assert.match(projected[0].content, /不是用户的新消息、观点或指令/);
  assert.match(projected[0].content, /不能补造旧 URL/);
  assert.match(projected[0].content, /概念\/反馈.md/);
  assert.deepEqual(projected.slice(1), contextMessages(messages.slice(generated.coveredIds.length)));
});

test('source index remains bounded, marks omissions and never includes incomplete assistant URLs', async () => {
  const messages = chain(30);
  for (let index = 0; index < 36; index += 2) {
    messages[index].noteQuote = { path: `目录/笔记${index}.md`, title: `笔记 ${index}`, text: `来源 https://example.org/${index}` };
  }
  messages[1].content = 'https://example.org/unfinished';
  messages[1].status = 'stopped';
  messages[3].content = `https://example.org/${'a'.repeat(1500)}`;
  const generated = await summary(messages, { summary: '摘要内容'.repeat(1200) });
  const projected = summaryHistory(messages, generated);
  const input = JSON.parse(projected[0].content.slice(projected[0].content.indexOf('\n') + 1));
  assert.ok(input.sources.notes.length <= 12);
  assert.ok(input.sources.urls.length <= 12);
  assert.equal(input.sources.more, true);
  assert.ok(input.sources.urls.every((entry: { url: string }) => entry.url.length <= 1000));
  assert.ok(JSON.stringify(input.sources).length <= 2400);
  assert.ok(projected[0].content.length < 12000);
  assert.ok(!projected[0].content.includes('unfinished'));
});

test('malformed output and envelope fields are rejected; corrupt files do not hide the raw history', async () => {
  const messages = chain(8);
  const generated = await summary(messages);
  const invalidResults: unknown[] = [null, [], {}, { ...result(), extra: true },
    result({ topic: '字'.repeat(161) }), result({ summary: '字'.repeat(6001) }),
    result({ userStatements: [{ messageId: '../路径', quote: '假' }] }),
    result({ userStatements: [{ messageId: messages[0].id, quote: ' ' }] }),
    result({ openQuestions: Array.from({ length: 21 }, () => '问题') }),
    result({ disagreements: ['字'.repeat(501)] }),
    result({ summary: '字'.repeat(6000), openQuestions: ['字'.repeat(500), '字'.repeat(500), '字'.repeat(500), '字'.repeat(500)] }),
  ];
  const plan = planCompression(messages, null)!;
  for (const invalidResult of invalidResults) {
    await assert.rejects(createContextSummary(plan, JSON.stringify(invalidResult), 'deepseek-chat'));
  }
  await assert.rejects(createContextSummary(plan, '{"topic":', 'deepseek-chat'), /完整 JSON/);
  for (const corrupt of [
    { ...generated, schemaVersion: 2 }, { ...generated, id: '../../会话' },
    { ...generated, sessionId: '/absolute' }, { ...generated, throughId: uuid(9999) },
    { ...generated, coveredIds: [...generated.coveredIds, generated.coveredIds[0]] },
    { ...generated, sourceHash: '0' }, { ...generated, createdAt: 'invalid date' },
    { ...generated, model: 'DeepSeek\n注入' }, { ...generated, unknown: true },
    { ...generated, result: { ...generated.result, userStatements: [{ messageId: uuid(777), quote: '未知' }] } },
  ]) {
    assert.equal(await selectContextSummary(messages, [corrupt as ContextSummary]), null);
    assert.deepEqual(summaryHistory(messages, corrupt as ContextSummary), contextMessages(messages));
  }
  assert.deepEqual(validateContextSummary(generated), generated);
});

test('merging prior exact user quotes fails rather than silently dropping them at capacity', async () => {
  const messages = chain(40);
  const statements = messages.filter(message => message.role === 'user').slice(0, 24)
    .map(message => ({ messageId: message.id, quote: message.content }));
  const first = await summary(messages.slice(0, 64), { userStatements: statements });
  const plan = planCompression(messages, first)!;
  const nextUser = plan.messages.find(message => message.role === 'user')!;
  await assert.rejects(createContextSummary(plan, JSON.stringify(result({ userStatements: [{ messageId: nextUser.id, quote: nextUser.content }] })), 'deepseek-chat'), /格式/);
  assert.equal(first.result.userStatements.length, 24);
});

test('tampered plans cannot summarize different messages than the immutable covered prefix', async () => {
  const messages = chain(8);
  const plan = planCompression(messages, null)!;
  const mismatched = { ...plan, messages: plan.messages.map(message => ({ ...message, content: '替换的内容' })) };
  assert.throws(() => summaryMessages(mismatched), /格式/);
  await assert.rejects(createContextSummary(mismatched, JSON.stringify(result()), 'deepseek-chat'), /格式/);
  assert.throws(() => summaryMessages({ ...plan, throughId: messages.at(-1)!.id }), /格式/);
});

test('a partial original-source rebuild survives restoration and advances in its own generation', async () => {
  const messages = chain(100, 1000);
  const raw = JSON.stringify(result());
  let legacy: ContextSummary | null = null;
  while (true) {
    const plan = planCompression(messages, legacy);
    if (!plan) break;
    legacy = await createContextSummary(plan, raw, 'deepseek-chat');
  }
  assert.equal(legacy!.coveredIds.length, 192);
  const legacyBefore = JSON.stringify(legacy);
  const rebuildId = uuid(700000);
  const rebuildCreatedAt = '2026-10-02T02:00:00Z';
  let rebuilt: ContextSummary | null = null;
  for (let batch = 0; batch < 4; batch++) {
    const plan: CompressionPlan = planCompression(messages, rebuilt)!;
    assert.equal(plan.messages[0].id, messages[plan.previous?.coveredIds.length ?? 0].id);
    rebuilt = await createContextSummary(plan, raw, 'deepseek-chat');
    if (batch === 0) rebuilt = validateContextSummary({ ...rebuilt, rebuildId, rebuildCreatedAt });
    assert.equal(rebuilt.rebuildId, rebuildId);
    assert.equal(rebuilt.rebuildCreatedAt, rebuildCreatedAt);
  }
  assert.ok(rebuilt!.coveredIds.length < legacy!.coveredIds.length, 'the four-batch rebuild is intentionally partial');
  const restored = await selectContextSummary(messages, JSON.parse(JSON.stringify([legacy, rebuilt])));
  assert.equal(restored!.id, rebuilt!.id, 'restoration must retain the explicit rebuild instead of reverting to the longer legacy summary');
  assert.ok(contextSize(summaryHistory(messages, restored)) > AUTO_CONTEXT_CHARS, 'this history still needs another compression attempt');
  let continued = restored!;
  while (true) {
    const plan = planCompression(messages, continued);
    if (!plan) break;
    assert.equal(plan.previous!.id, continued.id);
    assert.equal(plan.messages[0].id, messages[continued.coveredIds.length].id);
    continued = await createContextSummary(plan, raw, 'deepseek-chat');
    assert.equal(continued.rebuildId, rebuildId);
    assert.equal(continued.rebuildCreatedAt, rebuildCreatedAt);
    assert.equal((await selectContextSummary(messages, [legacy!, rebuilt!, continued]))!.id, continued.id);
  }
  assert.equal(continued.coveredIds.length, 192);
  assert.deepEqual(continued.coveredIds, messages.slice(0, 192).map(message => message.id));
  assert.equal(JSON.stringify(legacy), legacyBefore, 'rebuilding keeps older immutable files unchanged');
});

test('valid rebuild generations take precedence over legacy length and choose deterministic checkpoints', async () => {
  const messages = chain(12);
  const shorter = await summary(messages.slice(0, 12));
  const longer = await summary(messages);
  const firstGeneration = { ...longer, rebuildId: uuid(710000), rebuildCreatedAt: '2026-10-02T01:00:00Z' };
  const latestGeneration = { ...shorter, rebuildId: uuid(710001), rebuildCreatedAt: '2026-10-02T02:00:00Z' };
  const laterLegacy = { ...longer, id: uuid(719999), createdAt: '2030-01-01T00:00:00Z' };
  for (const candidates of [[firstGeneration, laterLegacy, latestGeneration], [latestGeneration, laterLegacy, firstGeneration]]) {
    assert.equal((await selectContextSummary(messages, candidates))!.id, latestGeneration.id);
  }
  const advanced = { ...longer, rebuildId: latestGeneration.rebuildId,
    rebuildCreatedAt: latestGeneration.rebuildCreatedAt, createdAt: '2026-10-02T02:01:00Z' };
  const newerShortCheckpoint = { ...latestGeneration, id: uuid(710002), createdAt: '2026-10-02T03:00:00Z' };
  assert.equal((await selectContextSummary(messages, [newerShortCheckpoint, advanced, firstGeneration]))!.id, advanced.id,
    'within a generation, the furthest valid checkpoint is authoritative');
  const concurrentGeneration = { ...latestGeneration, id: uuid(710003), rebuildId: uuid(710010) };
  for (const candidates of [[advanced, concurrentGeneration], [concurrentGeneration, advanced]]) {
    assert.equal((await selectContextSummary(messages, candidates))!.id, concurrentGeneration.id,
      'concurrent same-time rebuilds resolve by generation ID before coverage');
  }
  assert.equal((await selectContextSummary(messages, [shorter, longer]))!.id, longer.id, 'legacy summaries retain their original selection rule');
});

test('invalid rebuild generations cannot hide valid legacy or rebuilt source', async () => {
  const messages = chain(12);
  const legacy = await summary(messages);
  const short = await summary(messages.slice(0, 12));
  const valid = { ...short, rebuildId: uuid(720000), rebuildCreatedAt: '2026-10-02T01:00:00Z' };
  const newer = { ...valid, id: uuid(720001), rebuildId: uuid(720002), rebuildCreatedAt: '2026-10-02T02:00:00Z' };
  const invalidCandidates = [
    { ...newer, sourceHash: 'f'.repeat(64) },
    { ...newer, sessionId: uuid(999999) },
    { ...newer, throughId: uuid(888888) },
    { ...newer, rebuildId: '../invalid' },
    { ...newer, rebuildCreatedAt: 'not a date' },
    { ...short, rebuildId: uuid(720003) },
    { ...short, rebuildCreatedAt: '2026-10-02T03:00:00Z' },
    { ...newer, extra: true },
  ];
  for (const invalidCandidate of invalidCandidates) {
    assert.equal((await selectContextSummary(messages, [legacy, invalidCandidate as ContextSummary]))!.id, legacy.id);
    assert.equal((await selectContextSummary(messages, [legacy, valid, invalidCandidate as ContextSummary]))!.id, valid.id);
  }
  assert.deepEqual(validateContextSummary(valid), valid);
  assert.deepEqual(validateContextSummary(legacy), legacy, 'unmarked summaries remain readable');
});

test('rebuild priority remains constrained by the exact covered branch prefix', async () => {
  const messages = chain(12);
  const sharedLegacy = await summary(messages.slice(0, 12));
  const rebuilt = { ...await summary(messages), rebuildId: uuid(730000), rebuildCreatedAt: '2026-10-02T01:00:00Z' };
  const forkBeforeCoverage = structuredClone(messages);
  forkBeforeCoverage[4].id = uuid(730001);
  forkBeforeCoverage[5].parentId = forkBeforeCoverage[4].id;
  assert.equal((await selectContextSummary(forkBeforeCoverage, [rebuilt, sharedLegacy]))!.id, sharedLegacy.id,
    'a newer rebuild on another branch must not suppress an unchanged shared prefix');
  const forkAfterCoverage = structuredClone(messages);
  forkAfterCoverage[18].id = uuid(730002);
  forkAfterCoverage[19].parentId = forkAfterCoverage[18].id;
  assert.equal((await selectContextSummary(forkAfterCoverage, [sharedLegacy, rebuilt]))!.id, rebuilt.id,
    'a branch can still reuse a rebuild of its exact shared earlier source');
});
