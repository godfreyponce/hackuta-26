// Chert FaceTime REST (spec B.1). Raw fetch; every call has a timeout.
import { env } from './env.ts';
import { errText, warn } from './log.ts';

const TIMEOUT_MS = 8_000; // guess: no published latency figure

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${env.CHERT_FACETIME_TOKEN}`,
    'x-chert-project-id': env.CHERT_PROJECT_ID,
    'content-type': 'application/json',
    ...extra,
  };
}

async function req(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${env.CHERT_API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
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

/** POST /calls. Network errors retry with the same key at 0.5/1/2 s; 4xx fails at once. */
export async function createCall(c: CreateCall, idempotencyKey: string): Promise<string> {
  const body = JSON.stringify({
    direction: 'outbound', mode: 'customer_managed', line_id: env.CHERT_LINE_ID,
    destination: c.destination, destination_type: 'phone',
    media: { audio: true, video: true },
    livekit_url: c.livekitUrl, participant_token: c.participantToken,
    remote_participant_identity: c.remoteIdentity,
  });
  const delays = [500, 1_000, 2_000];
  for (let attempt = 0; ; attempt++) {
    try {
      const { status, body: res } = await req('/calls', { method: 'POST', headers: headers({ 'idempotency-key': idempotencyKey }), body });
      const r = res as { data?: { id?: string }; error?: { code?: string } | string; code?: string };
      if ((status === 201 || status === 202 || status === 200) && r.data?.id) return r.data.id;
      const code = (typeof r.error === 'object' ? r.error?.code : r.error) ?? r.code ?? 'unknown';
      if (status >= 400 && status < 500) throw new ChertError(status, code);
      throw new Error(`chert ${status} ${code}`);
    } catch (e) {
      if (e instanceof ChertError || attempt >= delays.length) throw e;
      warn('chert_create_retry', { attempt, error: errText(e) });
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

export type ChertEvent = { id: string; type: string };

/** GET /calls/<id>/events, normalized to {id, type}. The exact event shape is not documented to us, so be lenient. */
export async function getEvents(callId: string): Promise<ChertEvent[]> {
  const { body } = await req(`/calls/${callId}/events`, { headers: headers() });
  const b = body as { data?: unknown };
  const list = Array.isArray(b.data) ? b.data : Array.isArray((b.data as { events?: unknown })?.events) ? (b.data as { events: unknown[] }).events : [];
  return list.map((raw, i) => {
    const e = raw as Record<string, unknown>;
    const type = String(e.type ?? e.event_type ?? e.event ?? e.name ?? 'unknown');
    return { id: String(e.id ?? `${i}-${type}`), type };
  });
}

export async function getCallStatus(callId: string): Promise<string | undefined> {
  const { body } = await req(`/calls/${callId}`, { headers: headers() });
  const d = (body as { data?: { status?: string; state?: string } }).data;
  return d?.status ?? d?.state;
}

export async function endCall(callId: string, idempotencyKey: string): Promise<number> {
  const { status } = await req(`/calls/${callId}/end`, { method: 'POST', headers: headers({ 'idempotency-key': idempotencyKey }), body: '{}' });
  return status;
}
