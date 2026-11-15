import { serverToWebSchema, type ServerToWeb } from '@ithaca/shared';
import type { Hub, HubStatus, Outgoing } from './types';

const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];
const MAX_QUEUE = 300;

/** Real hub client: reconnecting WebSocket with an outbound queue (game.events must arrive). */
export function createWsHub(): Hub {
  let ws: WebSocket | null = null;
  let sessionId = '';
  let st: HubStatus = 'idle';
  let attempt = 0;
  let closedByUser = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: string[] = [];
  const subs = new Set<(m: ServerToWeb) => void>();
  const statusSubs = new Set<(s: HubStatus) => void>();
  let warnedInvalid = 0;

  const setStatus = (s: HubStatus) => { st = s; statusSubs.forEach((cb) => cb(s)); };

  const frame = (m: Outgoing) => JSON.stringify({ v: 1, sessionId, ts: Date.now(), ...m });

  function open() {
    if (!sessionId) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?role=web&sessionId=${encodeURIComponent(sessionId)}`;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      setStatus('open');
      ws?.send(frame({ type: 'hello', role: 'web' }));
      while (queue.length && ws?.readyState === WebSocket.OPEN) ws.send(queue.shift()!);
    };
    ws.onmessage = (ev) => {
      let raw: unknown;
      try { raw = JSON.parse(String(ev.data)); } catch { return; }
      const parsed = serverToWebSchema.safeParse(raw);
      if (!parsed.success) {
        if (warnedInvalid++ < 3) console.warn('[hub] dropped invalid message', (raw as { type?: string })?.type);
        return;
      }
      const msg = parsed.data as ServerToWeb;
      subs.forEach((cb) => { try { cb(msg); } catch (err) { console.warn('[hub] subscriber', err); } });
    };
    ws.onclose = () => {
      ws = null;
      if (closedByUser) { setStatus('closed'); return; }
      scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function scheduleRetry() {
    if (closedByUser) return;
    setStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(open, delay);
  }

  return {
    mode: 'live',
    connect(sid) {
      if (sid === sessionId && ws) return;
      closedByUser = false;
      sessionId = sid;
      attempt = 0;
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      open();
    },
    send(m) {
      const data = frame(m);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
      else {
        queue.push(data);
        if (queue.length > MAX_QUEUE) queue.shift();
      }
    },
    on(cb) { subs.add(cb); return () => subs.delete(cb); },
    onStatus(cb) { statusSubs.add(cb); cb(st); return () => statusSubs.delete(cb); },
    status: () => st,
    close() {
      closedByUser = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      ws = null;
      setStatus('closed');
    },
  };
}
