import type { WebSocket, RawData } from 'ws';
import {
  agentToServerSchema, webToServerSchema,
  type ServerToAgent, type ServerToWeb, type WeaponSpawn, type CallState,
} from '@ithaca/shared';
import { getStore, toOid } from './db/mongo';
import { log } from './log';
import { errMsg } from './util';

type Alive = WebSocket & { __alive?: boolean; __count?: number; __window?: number; __warned?: boolean };

// Distributive Omit so each union member keeps its own fields.
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OutWeb = DistOmit<ServerToWeb, 'v' | 'ts' | 'sessionId'>;
type OutAgent = DistOmit<ServerToAgent, 'v' | 'ts' | 'sessionId'>;

const MAX_MSGS_PER_SEC = 50;
const MAX_MSG_BYTES = 64 * 1024;

class Hub {
  private web = new Map<string, Set<Alive>>();
  private agent: Alive | null = null;
  /** sessions that currently have a call in a non-terminal state (for agent_offline notices) */
  private activeCalls = new Set<string>();
  private heartbeat: NodeJS.Timeout | null = null;

  get agentConnected(): boolean { return this.agent !== null && this.agent.readyState === 1; }

  start(): void {
    this.heartbeat = setInterval(() => {
      const all: Alive[] = [...[...this.web.values()].flatMap((s) => [...s])];
      if (this.agent) all.push(this.agent);
      for (const ws of all) {
        if (ws.__alive === false) { ws.terminate(); continue; }
        ws.__alive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, 15_000);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.web.values()) for (const ws of set) ws.close(1001, 'server shutdown');
    this.agent?.close(1001, 'server shutdown');
  }

  // ── Send helpers ───────────────────────────────────────────
  sendWeb(sessionId: string, msg: OutWeb): void {
    const set = this.web.get(sessionId);
    if (!set?.size) return;
    const raw = JSON.stringify({ v: 1, ts: Date.now(), sessionId, ...msg });
    for (const ws of set) if (ws.readyState === 1) ws.send(raw);
  }

  broadcastWeb(msg: OutWeb): void {
    for (const sid of this.web.keys()) this.sendWeb(sid, msg);
  }

  sendAgent(sessionId: string, msg: OutAgent): boolean {
    if (!this.agentConnected || !this.agent) return false;
    this.agent.send(JSON.stringify({ v: 1, ts: Date.now(), sessionId, ...msg }));
    return true;
  }

  spawnWeapon(sessionId: string, weapon: WeaponSpawn): void {
    this.sendWeb(sessionId, { type: 'weapon.spawn', weapon });
    this.sendAgent(sessionId, { type: 'weapon.spawn', weapon });
  }

  // ── Connections ────────────────────────────────────────────
  attachWeb(ws: Alive, sessionId: string): void {
    this.prep(ws);
    let set = this.web.get(sessionId);
    if (!set) { set = new Set(); this.web.set(sessionId, set); }
    set.add(ws);
    log.info({ sessionId, sockets: set.size }, 'web connected');
    ws.on('message', (data) => this.onWeb(ws, sessionId, data));
    ws.on('close', () => {
      set.delete(ws);
      if (set.size === 0) this.web.delete(sessionId);
      log.info({ sessionId }, 'web disconnected');
    });
  }

  attachAgent(ws: Alive): void {
    this.prep(ws);
    if (this.agent && this.agent !== ws) {
      log.warn('a new agent connected; replacing the previous agent socket');
      this.agent.close(4000, 'replaced');
    }
    this.agent = ws;
    log.info('agent connected');
    ws.on('message', (data) => this.onAgent(ws, data));
    ws.on('close', () => {
      if (this.agent !== ws) return;
      this.agent = null;
      log.warn({ activeCalls: this.activeCalls.size }, 'agent disconnected');
      for (const sid of this.activeCalls) {
        this.sendWeb(sid, { type: 'call.status', state: 'failed', reason: 'agent_offline' });
        void this.persistCall(sid, 'failed', 'agent_offline');
      }
      this.activeCalls.clear();
    });
  }

  private prep(ws: Alive): void {
    ws.__alive = true;
    ws.on('pong', () => { ws.__alive = true; });
    ws.on('error', (e) => log.warn({ err: errMsg(e) }, 'ws error'));
  }

  /** Returns parsed JSON or null (and replies with an error) if rate-limited/oversized/invalid JSON. */
  private parse(ws: Alive, data: RawData, sessionId: string): unknown {
    const now = Date.now();
    if (!ws.__window || now - ws.__window >= 1000) { ws.__window = now; ws.__count = 0; }
    ws.__count = (ws.__count ?? 0) + 1;
    if (ws.__count > MAX_MSGS_PER_SEC) {
      if (!ws.__warned) { log.warn({ sessionId }, 'ws rate limit exceeded; dropping'); ws.__warned = true; }
      return null;
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (buf.length > MAX_MSG_BYTES) { this.reject(ws, sessionId, 'too_large', 'message too large'); return null; }
    try { return JSON.parse(buf.toString('utf8')); } catch {
      this.reject(ws, sessionId, 'bad_json', 'invalid JSON'); return null;
    }
  }

  private reject(ws: Alive, sessionId: string, code: string, message: string): void {
    if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, ts: Date.now(), sessionId, type: 'error', code, message }));
  }

  // ── Routing: web → server ──────────────────────────────────
  private onWeb(ws: Alive, sessionId: string, data: RawData): void {
    const json = this.parse(ws, data, sessionId);
    if (json === null) return;
    const r = webToServerSchema.safeParse(json);
    if (!r.success) { this.reject(ws, sessionId, 'invalid_message', r.error.issues[0]?.message ?? 'invalid'); return; }
    const msg = r.data;
    if (msg.sessionId !== sessionId) { this.reject(ws, sessionId, 'session_mismatch', 'sessionId does not match socket'); return; }

    switch (msg.type) {
      case 'hello': return;
      case 'call.request': void this.onCallRequest(sessionId, msg.friendId); return;
      case 'call.end':
        if (!this.sendAgent(sessionId, { type: 'call.end', reason: 'web_request' })) {
          this.sendWeb(sessionId, { type: 'call.status', state: 'ended', reason: 'agent_offline' });
        }
        return;
      case 'game.event': this.sendAgent(sessionId, { type: 'game.event', event: msg.event }); return;
      case 'scan.request':
        if (!this.sendAgent(sessionId, { type: 'scan.request' })) {
          this.sendWeb(sessionId, { type: 'scan.status', state: 'failed', reason: 'agent_offline' });
        }
        return;
    }
  }

  private async onCallRequest(sessionId: string, friendId: string): Promise<void> {
    const fail = (reason: string) => this.sendWeb(sessionId, { type: 'call.status', state: 'failed', reason });
    if (!this.agentConnected) { fail('agent_offline'); return; }
    const s = getStore();
    if (!s) { fail('db_offline'); return; }
    const fid = toOid(friendId);
    if (!fid) { fail('friend_not_found'); return; }
    try {
      const friend = await s.friends.findOne({ _id: fid, consent: true });
      if (!friend) { fail('friend_not_found'); return; }
      const sid = toOid(sessionId);
      if (sid) await s.sessions.updateOne({ _id: sid }, { $set: { friendId: fid } });
      this.activeCalls.add(sessionId);
      const ok = this.sendAgent(sessionId, {
        type: 'call.start',
        friend: { id: friend._id.toHexString(), name: friend.name, phoneE164: friend.phoneE164 },
        gameRoom: `game-${sessionId}`,
      });
      if (!ok) { this.activeCalls.delete(sessionId); fail('agent_offline'); return; }
      log.info({ sessionId, friendId, phone: friend.phoneMasked }, 'call.start → agent');
    } catch (e) {
      log.error({ err: errMsg(e) }, 'call.request failed');
      fail('server_error');
    }
  }

  // ── Routing: agent → server ────────────────────────────────
  private onAgent(ws: Alive, data: RawData): void {
    const json = this.parse(ws, data, '*');
    if (json === null) return;
    const r = agentToServerSchema.safeParse(json);
    if (!r.success) { this.reject(ws, '*', 'invalid_message', r.error.issues[0]?.message ?? 'invalid'); return; }
    const msg = r.data;
    switch (msg.type) {
      case 'hello': log.info('agent hello'); return;
      case 'call.status': {
        const out: OutWeb = { type: 'call.status', state: msg.state };
        if (msg.reason !== undefined) out.reason = msg.reason;
        if (msg.elapsedMs !== undefined) out.elapsedMs = msg.elapsedMs;
        this.sendWeb(msg.sessionId, out);
        if (msg.state === 'ended' || msg.state === 'failed' || msg.state === 'idle') this.activeCalls.delete(msg.sessionId);
        else this.activeCalls.add(msg.sessionId);
        void this.persistCall(msg.sessionId, msg.state, msg.reason, msg.callId);
        return;
      }
      case 'scan.status': {
        const { v: _v, ts: _ts, sessionId, ...rest } = msg;
        this.sendWeb(sessionId, rest);
        return;
      }
      case 'narration':
        this.sendWeb(msg.sessionId, { type: 'narration', text: msg.text, priority: msg.priority });
        return;
    }
  }

  private async persistCall(sessionId: string, state: CallState, reason?: string, callId?: string): Promise<void> {
    const s = getStore();
    const sid = toOid(sessionId);
    if (!s || !sid) return;
    const set: Record<string, unknown> = { 'call.state': state };
    if (reason) set['call.reason'] = reason;
    if (callId) set['call.callId'] = callId;
    if (state === 'connected') set['call.startedAt'] = new Date();
    if (state === 'ended' || state === 'failed') set['call.endedAt'] = new Date();
    try { await s.sessions.updateOne({ _id: sid }, { $set: set }); } catch (e) {
      log.warn({ err: errMsg(e) }, 'persist call.status failed');
    }
  }
}

export const hub = new Hub();
