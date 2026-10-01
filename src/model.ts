export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'interrupted' | 'truncated' | 'error';
export interface Message {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  createdAt: string;
  model?: string;
  usage?: Record<string, unknown>;
  error?: string;
}
export interface Session {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
}

export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Follow IDs rather than timestamps; synced concurrent branches remain separate. */
export function messageChain(all: Message[], leafId: string): Message[] {
  const byId = new Map(all.map(message => [message.id, message]));
  const seen = new Set<string>();
  const chain: Message[] = [];
  let id: string | null = leafId;
  while (id) {
    if (seen.has(id)) throw new Error('会话消息出现循环关联。');
    seen.add(id);
    const message = byId.get(id);
    if (!message) throw new Error('会话尚未同步完整，请等待同步后再继续。');
    chain.unshift(message);
    id = message.parentId;
  }
  return chain;
}

export function leafMessages(all: Message[]): Message[] {
  const parents = new Set(all.map(message => message.parentId).filter(Boolean));
  return all.filter(message => !parents.has(message.id));
}

export function contextMessages(chain: Message[]): { role: 'user' | 'assistant'; content: string }[] {
  return chain.filter(message => message.role === 'user' || message.status === 'complete')
    .map(message => ({ role: message.role, content: message.content }));
}
