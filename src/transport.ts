import { CompletionStream, StreamDelta } from './sse';
// These types are erased from the build; streamNode is selected only on desktop.
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

export type NodeRequestFactory = (
  url: string, options: RequestOptions, callback: (response: IncomingMessage) => void
) => ClientRequest;

export interface StreamRequest {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  onDelta: (delta: StreamDelta) => void;
}

export function abortError(): Error {
  const error = new Error('已停止生成。');
  error.name = 'AbortError';
  return error;
}

export function statusError(status: number): Error {
  const labels: Record<number, string> = {
    400: '请求参数不被支持，请检查模型设置。',
    401: 'API Key 无效，请在设置中检查密钥。',
    402: '账户余额不足。',
    403: '请求被拒绝，请检查账户权限。',
    404: '模型或接口不存在。',
    429: '请求过于频繁，请稍后手动重试。',
  };
  return new Error(`HTTP ${status}：${labels[status] ?? '服务暂时不可用，请稍后手动重试。'}`);
}

/** Browser transport for Android WebView, with actual AbortController cancellation. */
export async function streamBrowser(input: StreamRequest): Promise<void> {
  if (input.signal.aborted) throw abortError();
  // requestUrl buffers the complete response and cannot supply the required streaming reader.
  const options: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input.payload),
    signal: input.signal,
    cache: 'no-store',
  };
  let response: Response;
  try { response = await fetch(input.url, options); }
  catch (error) {
    if (input.signal.aborted) throw abortError();
    if (error instanceof TypeError) {
      throw new Error('Web 流式连接失败，请检查网络与 WebView 的跨域兼容性。');
    }
    throw error;
  }
  if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('接口没有返回流式响应。本验证版不会切换为完整回复。');
  }
  if (!response.body?.getReader) throw new Error('当前环境无法读取流式响应。');
  const reader = response.body.getReader();
  const completion = new CompletionStream(input.onDelta);
  try {
    while (true) {
      const next = await reader.read();
      if (input.signal.aborted) throw abortError();
      if (next.done) break;
      completion.parser.push(next.value);
      if (completion.done) break;
    }
    completion.end();
  } finally {
    try { await reader.cancel(); } catch { /* Network may already be closed. */ }
    reader.releaseLock();
  }
}

/** Loaded only on desktop. Tests supply a local HTTP client using the same interface. */
export function streamNode(input: StreamRequest, requestFactory: NodeRequestFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) { reject(abortError()); return; }
    let settled = false;
    let response: IncomingMessage | undefined;
    let request: ClientRequest | undefined;
    const completion = new CompletionStream(input.onDelta);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', cancel);
      if (error) { response?.destroy(); request?.destroy(); reject(error); }
      else resolve();
    };
    const cancel = () => finish(abortError());
    input.signal.addEventListener('abort', cancel, { once: true });
    try {
      request = requestFactory(input.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
      }, res => {
        response = res;
        if (settled) { res.destroy(); return; }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) { finish(statusError(status)); return; }
        if (!String(res.headers['content-type']).includes('text/event-stream')) {
          finish(new Error('接口没有返回流式响应。本验证版不会切换为完整回复。'));
          return;
        }
        res.on('data', (bytes: Uint8Array) => {
          if (settled) return;
          try {
            completion.parser.push(bytes);
            if (completion.done) { finish(); res.destroy(); }
          } catch (error) { finish(error as Error); }
        });
        res.on('end', () => {
          if (settled) return;
          try { completion.end(); finish(); } catch (error) { finish(error as Error); }
        });
        res.on('error', () => finish(new Error('网络中断，已保留已收到的文字。')));
        res.on('aborted', () => finish(new Error('网络中断，已保留已收到的文字。')));
        res.on('close', () => {
          if (!settled) finish(new Error('连接提前关闭，已保留已收到的文字。'));
        });
      });
      request.on('error', () => finish(new Error('无法连接 DeepSeek，请检查网络。')));
      if (input.signal.aborted) { cancel(); return; }
      request.end(JSON.stringify(input.payload));
    } catch (error) { finish(error as Error); }
  });
}
