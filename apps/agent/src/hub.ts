// WS client to the server hub (Part D) as role=agent. Reconnects forever.
import WebSocket from 'ws';
import type { AgentToServer, ServerToAgent } from './contracts/protocol.ts';
import { serverToAgent } from './contracts/schemas.ts';
import { env } from './env.ts';
import { errText, log, warn } from './log.ts';

type Out = AgentToServer extends infer M ? M extends { type: string } ? Omit<M, 'v' | 'ts'> : never : never;

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
      const parsed = serverToAgent.safeParse(json);
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
    this.ws.send(JSON.stringify({ v: 1, ts: Date.now(), ...m }));
  }
}
