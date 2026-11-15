// Chert FaceTime REST (spec B.1). Raw fetch; every call has a timeout.
import { env } from './env.ts';
import { errText, log, maskPhone, warn } from './log.ts';

export const CHERT_TIMEOUT_MS = 8_000; // guess: no published latency figure
const RAW_LOG_MAX_CHARS = 2_000; // guess: enough to show the shape of a few events
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SECRET_KEY = /token|secret|key|authorization/i;
const PHONE = /\+?\d{7,}/g;

/** Reply shapes are partly guessed, so the first live call logs them raw, minus tokens and phone numbers. */
function logRaw(event: string, body: unknown): void {
  const text = JSON.stringify(body, (k, v: unknown) => SECRET_KEY.test(k) ? '[redacted]' : typeof v === 'string' ? v.replace(PHONE, maskPhone) : v) ?? '';
  log(event, { raw: text.slice(0, RAW_LOG_MAX_CHARS) });
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${env.CHERT_FACETIME_TOKEN}`,
    'x-chert-project-id': env.CHERT_PROJECT_ID,
    'content-type': 'application/json',
    ...extra,
  };
}

async function req(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${env.CHERT_API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(CHERT_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export type CreateCall = {
  destination: string;
  livekitUrl: string;
  participantToken: string;
  remoteIdentity: string;
};

export class ChertError extends Error {
  constructor(public status: number, public code: string) { super(`chert ${status} ${code}`); }
}

/**
 * POST /calls. 201 = allocated; 202 = queued behind another call on our shared line (when_busy queue).
 * Network errors retry with the same key at 0.5/1/2 s; 4xx fails at once. After the session ends, one more try with
 * the same key, at once: Chert may have made the call already, and a replay is the only way to learn its id to end it.
 */
const RETRY_DELAYS_MS = [500, 1_000, 2_000];
/** Longest a create can run once the session ends: a backoff wait, the try in flight, and the one extra try. */
export const CREATE_AFTER_CANCEL_MAX_MS = Math.max(...RETRY_DELAYS_MS) + 2 * CHERT_TIMEOUT_MS;

/** A busy shared line: Chert holds our place. Repeat the create with the same key once `state` is no longer waiting. */
export type QueueEntry = { id: string; state: string; position: number | null };
export type Created = { id: string; queued: boolean; status: string | undefined } | { queue: QueueEntry };

type RawQueue = { id?: unknown; state?: unknown; position?: unknown; call_id?: unknown };

/** The 202 nests the entry under data.queue; the GET reply shape is unseen, so the entry directly under data counts too. */
function rawQueue(body: unknown): RawQueue | undefined {
  const d = (body as { data?: RawQueue & { queue?: RawQueue } })?.data;
  return d?.queue ?? (typeof d?.state === 'string' ? d : undefined);
}

function queueEntry(body: unknown): QueueEntry | null {
  const q = rawQueue(body);
  if (typeof q?.id !== 'string') return null;
  return { id: q.id, state: String(q.state ?? 'unknown'), position: typeof q.position === 'number' ? q.position : null };
}

export async function createCall(c: CreateCall, idempotencyKey: string, cancelled: () => boolean = () => false): Promise<Created> {
  const body = JSON.stringify({
    direction: 'outbound', mode: 'customer_managed', line_id: env.CHERT_LINE_ID,
    destination: c.destination, destination_type: 'phone',
    media: { audio: true, video: true }, when_busy: 'queue',
    livekit_url: c.livekitUrl, participant_token: c.participantToken,
    remote_participant_identity: c.remoteIdentity,
  });
  const delays = RETRY_DELAYS_MS;
  let triedAfterCancel = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const { status, body: res } = await req('/calls', { method: 'POST', headers: headers({ 'idempotency-key': idempotencyKey }), body });
      const r = res as { data?: { id?: string; status?: string }; id?: string; status?: string; error?: { code?: string } | string; code?: string };
      logRaw('chert_create_raw', { status, body: res });
      // Only the 201 envelope (id under data) was seen in the dry run; a 202 may put the id at the top.
      const call = r.data?.id ? r.data : r;
      if ((status === 201 || status === 202 || status === 200) && call.id) return { id: call.id, queued: status === 202, status: call.status };
      const placed = status === 202 ? rawQueue(res)?.call_id : undefined;
      if (typeof placed === 'string') return { id: placed, queued: false, status: undefined };
      const queue = status === 202 ? queueEntry(res) : null;
      if (queue) return { queue };
      const code = (typeof r.error === 'object' ? r.error?.code : r.error) ?? r.code ?? 'unknown';
      if (status >= 400 && status < 500) throw new ChertError(status, code);
      throw new Error(`chert ${status} ${code}`);
    } catch (e) {
      if (e instanceof ChertError || triedAfterCancel) throw e;
      if (cancelled()) triedAfterCancel = true;
      else if (attempt >= delays.length) throw e;
      warn('chert_create_retry', { attempt, cancelled: triedAfterCancel, error: errText(e) });
      if (!triedAfterCancel) await sleep(delays[attempt]!);
    }
  }
}

/**
 * Real statuses seen in the dry run: allocating, dialing, active. The dry run never queued, so a queued call's status
 * name is unseen: the status the 202 reply reported also counts as still queued.
 */
export const isQueuedStatus = (status: string, statusAt202?: string): boolean => /queue/i.test(status) || status === statusAt202;

const RINGING = /ring|dial|alert/i;

/** The no-answer clock starts when the phone is dialed (the dry run showed `dialing`), not at the first non-queued status: a queued name may lack "queue". */
export const startsRingClock = (status: string, statusAt202?: string): boolean => !isQueuedStatus(status, statusAt202) && RINGING.test(status);

/** A 202 may carry no status. Then the first polled status is the queued name, unless the phone is already ringing. */
export const queuedNameAfter202 = (firstPolled: string): string | undefined => RINGING.test(firstPolled) ? undefined : firstPolled;

const ENDED = new Set(['ended', 'completed', 'cancelled', 'canceled']);
const FAILED = new Set(['failed', 'declined']);

/**
 * Event names are partly guessed: the spec lists bridge_ready, ended, failed; the other end words follow the statuses
 * chert/agent/outbound.mjs stops on. Whole names only (after an optional `call.`), so `remote_video_failed` is not an end.
 */
export function chertEventKind(type: string): 'ready' | 'ringing' | 'no_video' | 'ended' | 'failed' | 'other' {
  const name = type.toLowerCase().replace(/^call\./, '');
  if (name === 'bridge_ready' || name === 'started') return 'ready';
  if (name === 'remote_video_unavailable') return 'no_video';
  if (FAILED.has(name)) return 'failed';
  if (ENDED.has(name)) return 'ended';
  if (RINGING.test(type)) return 'ringing';
  return 'other';
}

const STATUS_FAILED = new Set(['failed', 'declined']);
const STATUS_ENDED = new Set(['ended', 'completed', 'cancelled', 'canceled']);

/** Call statuses that end the call: the words chert/agent/outbound.mjs stopped its loop on, as whole words, so `call_ended` ends and `suspended` does not. */
export function terminalStatus(status: string): 'ended' | 'failed' | null {
  const words = status.toLowerCase().split(/[^a-z]+/);
  if (words.some((w) => STATUS_FAILED.has(w))) return 'failed';
  if (words.some((w) => STATUS_ENDED.has(w))) return 'ended';
  return null;
}

export type ChertEvent = { id: string; type: string; reason?: string };

function eventList(body: unknown): unknown[] {
  const b = body as Record<string, unknown> | undefined;
  const d = b?.data as Record<string, unknown> | undefined;
  return [body, d, d?.events, d?.items, b?.events, b?.items].find(Array.isArray) ?? [];
}

const TEXT_MATCH_READY: ChertEvent = { id: 'text-match-bridge_ready', type: 'bridge_ready' };
const lastRawEvents = new Map<string, string>();

/**
 * GET /calls/<id>/events, normalized to {id, type}. The exact event shape is not documented to us, so be lenient:
 * the raw body is logged whenever it changes. If no event list is found at all, a "bridge_ready" string value anywhere
 * counts, as in the dry-run reference; a flag or a hint sentence does not.
 * An event with no id gets its content as id, so it keeps that id if the list shifts.
 */
export async function getEvents(callId: string): Promise<ChertEvent[]> {
  const { body } = await req(`/calls/${callId}/events`, { headers: headers() });
  // Chert sends a new request_id on every reply (live 1); without this the body logs on every poll.
  const text = JSON.stringify(body, (k, v: unknown) => (k === 'request_id' ? undefined : v)) ?? '';
  if (lastRawEvents.get(callId) !== text) { lastRawEvents.set(callId, text); logRaw('chert_events_raw', body); }
  const events: ChertEvent[] = eventList(body).map((raw) => {
    const e = raw as Record<string, unknown>;
    const type = String(e.type ?? e.event_type ?? e.event ?? e.name ?? 'unknown');
    const reason = [e, e.data, e.payload].map((o) => o as Record<string, unknown> | undefined)
      .map((o) => o?.reason ?? o?.end_reason ?? o?.failure_reason ?? o?.code).find((v) => typeof v === 'string') as string | undefined;
    return { id: String(e.id ?? e.event_id ?? JSON.stringify(raw)), type, ...(reason ? { reason } : {}) };
  });
  if (!events.length && /:\s*"(call\.)?bridge_ready"/.test(text)) events.push(TEXT_MATCH_READY);
  return events;
}

const rawStatusLogged = new Set<string>();

export async function getCallStatus(callId: string): Promise<string | undefined> {
  const { body } = await req(`/calls/${callId}`, { headers: headers() });
  if (!rawStatusLogged.has(callId)) { rawStatusLogged.add(callId); logRaw('chert_call_raw', body); }
  const d = (body as { data?: { status?: string; state?: string } }).data;
  return d?.status ?? d?.state;
}

export async function getQueueEntry(queueId: string): Promise<QueueEntry> {
  const { status, body } = await req(`/calls/queue/${queueId}`, { headers: headers() });
  const q = queueEntry(body);
  if (!q) throw new Error(`chert queue ${status} no entry`);
  return q;
}

/** DELETE /calls/queue/<id>: gives up our place on the shared line. */
export async function cancelQueueEntry(queueId: string): Promise<number> {
  return (await req(`/calls/queue/${queueId}`, { method: 'DELETE', headers: headers() })).status;
}

const END_RETRY_DELAY_MS = 500; // guess
/** Longest endCall can take: two tries and the wait between them. */
export const END_CALL_MAX_MS = 2 * CHERT_TIMEOUT_MS + END_RETRY_DELAY_MS;

/** Only these mean the call is gone, so the crash-recovery record may be deleted. 404/409: already ended. */
export const endConfirmed = (status: number): boolean => (status >= 200 && status < 300) || status === 404 || status === 409;

/** POST /end. A network error or a 5xx gets one more try with the same key; a second network error throws. */
export async function endCall(callId: string, idempotencyKey: string): Promise<number> {
  const post = async () => (await req(`/calls/${callId}/end`, { method: 'POST', headers: headers({ 'idempotency-key': idempotencyKey }), body: '{}' })).status;
  try {
    const status = await post();
    if (status < 500) return status;
    warn('chert_end_retry', { status });
  } catch (e) {
    warn('chert_end_retry', { error: errText(e) });
  }
  await sleep(END_RETRY_DELAY_MS);
  return post();
}
