// WS client to the server hub (Part D) as role=agent. Reconnects forever.
import WebSocket from 'ws';
import { type AgentToServer, agentToServerSchema, type ServerToAgent, serverToAgentSchema } from '@ithaca/shared';
import { env } from './env.ts';
import { errText, log, warn } from './log.ts';

type Out = AgentToServer extends infer M ? M extends { type: string } ? Omit<M, 'v' | 'ts'> : never : never;

/** agentToServerSchema caps narration.text here; the server drops a longer one and the web gets no subtitle. */
const NARRATION_MAX = 400;

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '');
  const space = head.lastIndexOf(' ');
  return `${space > 0 ? head.slice(0, space).trimEnd() : head}…`;
}

/** The JSON to send, or null when @ithaca/shared would reject it. */
export function outbound(m: Out): string | null {
  const msg = m.type === 'narration' ? { ...m, text: cutAtWord(m.text, NARRATION_MAX) } : m;
  const r = agentToServerSchema.safeParse({ v: 1, ts: Date.now(), ...msg });
  if (r.success) return JSON.stringify(r.data);
  warn('hub_send_rejected', { type: m.type, issue: r.error.issues[0]?.message });
  return null;
}

export class Hub {
  private ws: WebSocket | null = null;
  private backoff = 500;
  connected = false;

  constructor(private onMessage: (m: ServerToAgent) => void) {}

  connect(): void {
    const url = new URL(env.SERVER_WS_URL);
    url.searchParams.set('role', 'agent');
    url.searchParams.set('key', env.AGENT_SHARED_SECRET);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff = 500;
      log('hub_connected', { url: env.SERVER_WS_URL });
      this.send({ type: 'hello', sessionId: '*', role: 'agent' });
    });
    ws.on('message', (raw) => {
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { return warn('hub_bad_json'); }
      const parsed = serverToAgentSchema.safeParse(json);
      if (!parsed.success) {
        const type = (json as { type?: unknown })?.type;
        if (type !== 'error') warn('hub_unknown_message', { type });
        else warn('hub_error', { message: (json as { message?: unknown }).message });
        return;
      }
      this.onMessage(parsed.data);
    });
    ws.on('close', () => {
      if (this.connected) warn('hub_disconnected');
      this.connected = false;
      this.ws = null;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5_000);
    });
    ws.on('error', (e) => { if (this.backoff <= 500) warn('hub_error', { error: errText(e) }); });
  }

  send(m: Out): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const json = outbound(m);
    if (json) this.ws.send(json);
  }
}
