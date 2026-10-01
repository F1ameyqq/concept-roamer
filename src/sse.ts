/** SSE frames may span arbitrary network packets and UTF-8 byte boundaries. */
export class SseParser {
  private decoder = new TextDecoder();
  private pending = '';
  private data: string[] = [];
  constructor(private onData: (data: string) => void) {}

  push(bytes: Uint8Array): void {
    this.consume(this.decoder.decode(bytes, { stream: true }));
  }

  end(): void {
    this.consume(this.decoder.decode());
    // A frame without its blank-line terminator is incomplete, not a valid event.
  }

  private consume(text: string): void {
    this.pending += text;
    if (this.pending.length > 4_000_000) throw new Error('流事件过大，已停止读取。');
    let offset = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const c = this.pending[i];
      if (c !== '\r' && c !== '\n') continue;
      if (c === '\r' && i === this.pending.length - 1) break;
      this.line(this.pending.slice(offset, i));
      if (c === '\r' && this.pending[i + 1] === '\n') i++;
      offset = i + 1;
    }
    this.pending = this.pending.slice(offset);
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length) this.onData(this.data.join('\n'));
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') {
      this.data.push(value);
      if (this.data.reduce((sum, entry) => sum + entry.length, 0) > 4_000_000) {
        throw new Error('流事件过大，已停止读取。');
      }
    }
  }
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  usage?: Record<string, unknown>;
  finishReason?: string;
}

export class CompletionStream {
  readonly parser: SseParser;
  done = false;
  finishReason: string | undefined;
  constructor(onDelta: (delta: StreamDelta) => void) {
    this.parser = new SseParser(data => {
      if (this.done) return;
      if (data === '[DONE]') { this.done = true; return; }
      let raw: unknown;
      try { raw = JSON.parse(data); }
      catch { throw new Error('收到无法解析的流事件，已保留已收到的文字。'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('收到无效的流事件，已保留已收到的文字。');
      }
      const parsed = raw as Record<string, unknown>;
      if (parsed.error) throw new Error('服务返回流错误，请检查模型与账户状态。');
      const first: unknown = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
      const choice = first && typeof first === 'object' ? first as Record<string, unknown> : {};
      const content = choice.delta && typeof choice.delta === 'object'
        ? choice.delta as Record<string, unknown> : {};
      const delta: StreamDelta = {};
      if (typeof content.content === 'string') delta.content = content.content;
      if (typeof content.reasoning_content === 'string') delta.reasoning = content.reasoning_content;
      if (typeof choice.finish_reason === 'string') {
        this.finishReason = choice.finish_reason;
        delta.finishReason = choice.finish_reason;
      }
      if (parsed.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage)) {
        delta.usage = parsed.usage as Record<string, unknown>;
      }
      onDelta(delta);
    });
  }
  end(): void {
    this.parser.end();
    if (!this.done) throw new Error('连接提前结束，回复未完成。已收到的文字已保留。');
  }
}
