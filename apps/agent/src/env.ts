import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const schema = z.object({
  LIVEKIT_URL: z.string().startsWith('wss://'),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  SERVER_WS_URL: z.string().default('ws://localhost:8787/ws'),
  SERVER_HTTP_URL: z.string().default('http://localhost:8787'),
  AGENT_SHARED_SECRET: z.string().min(1),
  AGENT_MODE: z.enum(['live', 'mock-call']).default('live'),
  AGENT_HEALTH_PORT: z.coerce.number().default(8788),
  // A second agent on the same LiveKit project (a dev stack beside a live one) must not delete the live call's ft- room.
  AGENT_SKIP_ROOM_CLEANUP: z.enum(['0', '1']).default('0'),
  CHERT_API_BASE: z.string().default('https://facetime.trychert.com/api/v1'),
  CHERT_FACETIME_TOKEN: z.string().default(''),
  CHERT_PROJECT_ID: z.string().default(''),
  CHERT_LINE_ID: z.string().default(''),
  CALL_MAX_MS: z.coerce.number().default(285_000),
  // Measured on live call 1: Chert sends 1280x720 with the phone picture in the middle third, the number bar on top, and our own picture-in-picture bottom left.
  CALLER_CROP: z.string().default('0.32,0.09,0.68,0.80'),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  ELEVENLABS_MODEL_ID: z.string().default('eleven_flash_v2_5'),
  TTS_CACHE_DIR: z.string().default(fileURLToPath(new URL('../.cache/tts/', import.meta.url))),
});

const parsed = schema.parse(process.env);
if (parsed.AGENT_MODE === 'live') {
  for (const k of ['CHERT_FACETIME_TOKEN', 'CHERT_PROJECT_ID', 'CHERT_LINE_ID'] as const) {
    if (!parsed[k]) throw new Error(`${k} is required when AGENT_MODE=live`);
  }
}

const crop = parsed.CALLER_CROP.split(',').map(Number);
if (crop.length !== 4 || crop.some((n) => !(n >= 0 && n <= 1))) throw new Error('CALLER_CROP must be x0,y0,x1,y1 in 0..1');

export const env = { ...parsed, callerCrop: crop as [number, number, number, number] };
export type Env = typeof env;
