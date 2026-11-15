// If the agent is killed mid-call, the Chert call and the FaceTime room outlive it.
// We note the live call on disk and clean up leftovers on the next start.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { RoomServiceClient } from 'livekit-server-sdk';
import { endCall, endConfirmed } from './chert.ts';
import { env } from './env.ts';
import { errText, log, warn } from './log.ts';

const FILE = new URL('../.cache/active-call.json', import.meta.url);

export async function noteActiveCall(callId: string, endKey: string): Promise<void> {
  await mkdir(new URL('.', FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify({ callId, endKey }));
}

export async function clearActiveCall(): Promise<void> {
  await rm(FILE, { force: true });
}

export async function recoverLeftovers(): Promise<void> {
  try {
    const { callId, endKey } = JSON.parse(await readFile(FILE, 'utf8')) as { callId: string; endKey: string };
    const status = await endCall(callId, endKey);
    log('recovered_leftover_call', { callId, status });
    if (endConfirmed(status)) await clearActiveCall();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn('recover_call_failed', { error: errText(e) });
  }
  try {
    const rs = new RoomServiceClient(env.LIVEKIT_URL.replace(/^wss:/, 'https:'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    const stale = (await rs.listRooms()).filter((r) => r.name.startsWith('ft-'));
    await Promise.allSettled(stale.map((r) => rs.deleteRoom(r.name)));
    if (stale.length) log('deleted_stale_ft_rooms', { count: stale.length });
  } catch (e) {
    warn('recover_rooms_failed', { error: errText(e) });
  }
}
