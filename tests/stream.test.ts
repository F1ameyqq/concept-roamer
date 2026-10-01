import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { CompletionStream, SseParser } from '../src/sse';
import { streamBrowser, streamNode, StreamRequest } from '../src/transport';
import { Message, contextMessages, leafMessages, messageChain } from '../src/model';

const encoder = new TextEncoder();
const content = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
const final = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 12 } })}\n\ndata: [DONE]\n\n`;

test('SSE: UTF-8 Chinese, emoji, CRLF and all possible two-part packet splits', () => {
  const wire = encoder.encode(`: keepalive\r\n\r\n${content('知识🧠与概念').replace(/\n/g, '\r\n')}${final.replace(/\n/g, '\r\n')}`);
  for (let split = 0; split <= wire.length; split++) {
    let text = '';
    const stream = new CompletionStream(delta => { text += delta.content ?? ''; });
    stream.parser.push(wire.slice(0, split));
    stream.parser.push(wire.slice(split));
    stream.end();
    assert.equal(text, '知识🧠与概念');
    assert.equal(stream.finishReason, 'stop');
  }
});

test('SSE: one byte per packet, comments and multiline data', () => {
  const frames: string[] = [];
  const parser = new SseParser(data => frames.push(data));
  const wire = encoder.encode(': ping\r\n\r\ndata: 中文\r\ndata: 第二行\r\n\r\n');
  for (const byte of wire) parser.push(new Uint8Array([byte]));
  parser.end();
  assert.deepEqual(frames, ['中文\n第二行']);
});

test('SSE: no DONE or malformed JSON cannot count as successful completion', () => {
  const stream = new CompletionStream(() => undefined);
  stream.parser.push(encoder.encode(content('partial')));
  assert.throws(() => stream.end(), /提前结束/);
  const malformed = new CompletionStream(() => undefined);
  assert.throws(() => malformed.parser.push(encoder.encode('data: {broken}\n\n')), /无法解析/);
});

test('SSE: truncated unterminated frame is not emitted', () => {
  const frames: string[] = [];
  const parser = new SseParser(data => frames.push(data));
  parser.push(encoder.encode('data: incomplete'));
  parser.end();
  assert.deepEqual(frames, []);
});

test('SSE: null, primitive and array event roots are rejected', () => {
  for (const invalid of ['null', '42', '[]', '"text"']) {
    const stream = new CompletionStream(() => undefined);
    assert.throws(() => stream.parser.push(encoder.encode(`data: ${invalid}\n\n`)), /无效的流事件/);
    assert.equal(stream.done, false);
  }
});

test('SSE: reasoning and usage are distinct from final answer', () => {
  let answer = '';
  let reasoning = '';
  let tokens = 0;
  const stream = new CompletionStream(delta => {
    answer += delta.content ?? '';
    reasoning += delta.reasoning ?? '';
    tokens = Number(delta.usage?.total_tokens ?? tokens);
  });
  stream.parser.push(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n' + content('回答') + final));
  stream.end();
  assert.equal(answer, '回答');
  assert.equal(reasoning, '思考');
  assert.equal(tokens, 12);
});

for (const transport of ['browser', 'node'] as const) {
  const run = (input: StreamRequest) => transport === 'browser' ? streamBrowser(input) : streamNode(input, request);

  test(`${transport}: actual socket emits first fragment before request completion`, async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* Consume POST body. */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(content('第一段'));
      await gate;
      res.end(content('第二段') + final);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    let first!: () => void;
    const received = new Promise<void>(resolve => { first = resolve; });
    let completed = false;
    let answer = '';
    try {
      const result = run({
        url: `http://127.0.0.1:${port}`, apiKey: 'local-test-key', payload: { stream: true },
        signal: new AbortController().signal,
        onDelta: delta => { answer += delta.content ?? ''; if (delta.content) first(); },
      }).then(() => { completed = true; });
      await received;
      assert.equal(answer, '第一段');
      assert.equal(completed, false);
      release();
      await result;
      assert.equal(answer, '第一段第二段');
    } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test(`${transport}: abort really closes the network connection`, async () => {
    let connectionClosed!: () => void;
    const closed = new Promise<void>(resolve => { connectionClosed = resolve; });
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* Consume request. */ }
      res.on('close', connectionClosed);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(content('已收到'));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    let partial = '';
    try {
      await assert.rejects(run({
        url: `http://127.0.0.1:${port}`, apiKey: 'local-test-key', payload: {}, signal: controller.signal,
        onDelta: delta => { partial += delta.content ?? ''; controller.abort(); },
      }), error => error instanceof Error && error.name === 'AbortError');
      await closed;
      assert.equal(partial, '已收到');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test(`${transport}: connection end without DONE preserves text and rejects`, async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(content('尚未完成'));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let partial = '';
    try {
      await assert.rejects(run({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        apiKey: 'local-test-key', payload: {}, signal: new AbortController().signal,
        onDelta: delta => { partial += delta.content ?? ''; },
      }), /提前/);
      assert.equal(partial, '尚未完成');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test(`${transport}: HTTP 401 does not expose server body or key`, async () => {
    const server = createServer((_req, res) => { res.writeHead(401); res.end('secret-in-server-error'); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await assert.rejects(run({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        apiKey: 'local-test-key', payload: {}, signal: new AbortController().signal, onDelta: () => undefined,
      }), error => error instanceof Error && error.message.includes('401') && !error.message.includes('secret-in-server-error'));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test(`${transport}: full JSON response is refused rather than fake-streamed`, async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"choices":[]}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await assert.rejects(run({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        apiKey: 'local-test-key', payload: {}, signal: new AbortController().signal, onDelta: () => undefined,
      }), /没有返回流式/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

function message(id: string, parentId: string | null, role: Message['role'] = 'user', status: Message['status'] = 'complete'): Message {
  return { schemaVersion: 1, id, parentId, sessionId: 'session', role, status, content: id, createdAt: '2026-10-01T00:00:00Z' };
}

test('offline branch merge does not reorder or combine two continuations', () => {
  const all = [message('root', null), message('phone', 'root'), message('pc', 'root')];
  assert.deepEqual(leafMessages(all).map(item => item.id), ['phone', 'pc']);
  assert.deepEqual(messageChain(all, 'phone').map(item => item.id), ['root', 'phone']);
  assert.deepEqual(messageChain(all, 'pc').map(item => item.id), ['root', 'pc']);
});

test('missing parent or cycle stops context reconstruction', () => {
  assert.throws(() => messageChain([message('a', 'missing')], 'a'), /未同步完整/);
  assert.throws(() => messageChain([message('a', 'b'), message('b', 'a')], 'a'), /循环/);
});

test('interrupted, stopped and truncated AI replies are excluded from valid history', () => {
  const all = [message('u', null), message('ok', 'u', 'assistant'),
    message('stop', 'ok', 'assistant', 'stopped'), message('short', 'stop', 'assistant', 'truncated')];
  assert.deepEqual(contextMessages(all), [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'ok' }]);
});
