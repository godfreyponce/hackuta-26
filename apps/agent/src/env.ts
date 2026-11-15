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
  CHERT_API_BASE: z.string().default('https://facetime.trychert.com/api/v1'),
  CHERT_FACETIME_TOKEN: z.string().default(''),
  CHERT_PROJECT_ID: z.string().default(''),
  CHERT_LINE_ID: z.string().default(''),
  CALL_MAX_MS: z.coerce.number().default(285_000),
  CALLER_CROP: z.string().default('0.08,0.12,0.92,0.88'),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  ELEVENLABS_MODEL_ID: z.string().default('eleven_flash_v2_5'),
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
