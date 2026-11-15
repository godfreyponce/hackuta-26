import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// Load env files (later files do NOT override earlier ones; real env wins over both).
const here = dirname(fileURLToPath(import.meta.url));
for (const f of [resolve(here, '../.env.local'), resolve(here, '../../../.env.local'), resolve(here, '../../../.env')]) {
  if (existsSync(f)) process.loadEnvFile(f);
}

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const str = () => z.preprocess(blankToUndef, z.string().optional());
const num = (d: number) => z.preprocess(blankToUndef, z.coerce.number().default(d));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: num(8787),
  PUBLIC_BASE_URL: z.preprocess(blankToUndef, z.string().default('http://localhost:8787')),
  MONGODB_URI: str(),
  MONGODB_DB: z.preprocess(blankToUndef, z.string().default('ithaca')),
  AGENT_SHARED_SECRET: str(),
  CORS_ORIGIN: z.preprocess(blankToUndef, z.string().default('http://localhost:5173')),

  VISION_PROVIDER: z.preprocess(blankToUndef, z.enum(['claude', 'gemini', 'mock']).default('mock')),
  ANTHROPIC_API_KEY: str(),
  VISION_MODEL: str(),
  GEMINI_API_KEY: str(),
  GEMINI_VISION_MODEL: str(),

  MODEL3D_PROVIDER: z.preprocess(blankToUndef, z.enum(['stability', 'prefab']).default('prefab')),
  STABILITY_API_KEY: str(),
  SF3D_TEXTURE_RES: z.preprocess(blankToUndef, z.enum(['512', '1024', '2048']).default('512')),
  SF3D_TIMEOUT_MS: num(15000),
  FORGE_CLEAN_IMAGE: z.preprocess(blankToUndef, z.enum(['0', '1', 'cutout']).default('0')),
  FORGE_3D_MODEL: z.preprocess(blankToUndef, z.enum(['fast', 'spar']).default('fast')),

  LIVEKIT_URL: str(),
  LIVEKIT_API_KEY: str(),
  LIVEKIT_API_SECRET: str(),
});

export const env = schema.parse(process.env);
export const isDev = env.NODE_ENV !== 'production';
