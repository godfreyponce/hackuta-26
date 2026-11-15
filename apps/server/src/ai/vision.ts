import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { WeaponClass } from '@ithaca/shared';
import { env } from '../env';
import { log } from '../log';
import { errMsg, withTimeout } from '../util';
import { VISION_JSON_SCHEMA, VISION_PROMPT } from './prompts/vision';

export interface VisionResult {
  is_object: boolean;
  object_name: string;
  display_name: string;
  weapon_class: WeaponClass;
  bbox: Box;
  confidence: number;
  quip: string;
  /** Real main colors and material, e.g. "black plastic and silver metal"; '' when unknown. */
  color: string;
  rejected?: 'person_only' | 'no_object' | 'unsafe' | 'screen_or_ui';
}
export interface VisionProvider { readonly name: string; readonly model: string; analyze(jpeg: Buffer): Promise<VisionResult> }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export type Box = [number, number, number, number];
export const FULL_FRAME: Box = [0, 0, 1, 1];

/**
 * Model box → [x0, y0, x1, y1] in 0..1. Gemini's native box_2d is [ymin, xmin, ymax, xmax] in 0..1000 ('yx').
 * An unusable box becomes FULL_FRAME, which cropForModel turns into the picture area without black bars.
 */
export function toUnitBox(raw: readonly number[] | undefined, order: 'xy' | 'yx'): Box {
  if (!raw || raw.length !== 4 || !raw.every(Number.isFinite)) return FULL_FRAME;
  // A 0..1 box may overshoot 1 slightly; a 0..1000 box under 2 would be a speck the 3% rule rejects anyway.
  const scale = Math.max(...raw) > 2 ? 1000 : 1;
  const [a, b, c, d] = raw.map((n) => clamp01(n / scale)) as Box;
  const [xa, ya, xb, yb] = order === 'yx' ? [b, a, d, c] : [a, b, c, d];
  const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
  // Under 0.5% a side is a few pixels on a call frame, and under 3% on both sides is a speck: neither is an object to model.
  const w = x1 - x0, h = y1 - y0;
  if (w < 0.005 || h < 0.005 || Math.max(w, h) < 0.03) return FULL_FRAME;
  return [x0, y0, x1, y1];
}

export const visionResultSchema = z.object({
  is_object: z.boolean(),
  object_name: z.string().default(''),
  display_name: z.string().default(''),
  weapon_class: z.enum(['spear', 'sword', 'blunt', 'throwable', 'shield', 'bomb', 'potion']).catch('blunt'),
  bbox: z.array(z.number()).length(4).catch([0, 0, 1, 1]),
  confidence: z.number().catch(0),
  quip: z.string().default(''),
  color: z.string().catch(''),
  rejected: z.enum(['person_only', 'no_object', 'unsafe', 'screen_or_ui']).optional().catch(undefined),
}).transform((r): VisionResult => {
  const out: VisionResult = {
    is_object: r.is_object,
    object_name: r.object_name.trim().toLowerCase().slice(0, 60),
    display_name: r.display_name.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 60),
    weapon_class: r.weapon_class,
    bbox: toUnitBox(r.bbox, 'xy'),
    confidence: clamp01(r.confidence),
    quip: r.quip.trim().slice(0, 140),
    color: (r.color ?? '').trim().toLowerCase().slice(0, 60),
  };
  if (r.rejected) out.rejected = r.rejected;
  return out;
});

class ClaudeVision implements VisionProvider {
  readonly name = 'claude';
  private client: Anthropic;
  constructor(readonly model: string, apiKey: string) { this.client = new Anthropic({ apiKey }); }
  async analyze(jpeg: Buffer): Promise<VisionResult> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 400,
      tools: [{
        name: 'report_object',
        description: 'Report the held-up object and its weapon mapping.',
        input_schema: VISION_JSON_SCHEMA as unknown as Anthropic.Tool.InputSchema,
      }],
      tool_choice: { type: 'tool', name: 'report_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    }, { timeout: 8000, maxRetries: 0 });
    const block = msg.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('claude returned no tool_use block');
    return visionResultSchema.parse(block.input);
  }
}

// Asked for x0,y0,x1,y1, gemini-3.5-flash-lite mixed axis orders between runs; its native box_2d came back in one order.
const { bbox: _bbox, ...geminiProps } = VISION_JSON_SCHEMA.properties;
const GEMINI_SCHEMA = {
  ...VISION_JSON_SCHEMA,
  properties: {
    ...geminiProps,
    box_2d: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4, description: '[ymin, xmin, ymax, xmax] of the object, each 0..1000' },
  },
  required: [...VISION_JSON_SCHEMA.required.filter((k) => k !== 'bbox'), 'box_2d'],
};
const GEMINI_PROMPT = VISION_PROMPT
  .replace('by calling the report_object tool exactly once', 'as a single JSON object')
  .replace(/^2\. Return a tight bounding box.*$/m, '2. Return box_2d, a tight 2D bounding box around only that object (not the hand holding it), as [ymin, xmin, ymax, xmax] normalized to 0-1000.');

if (!GEMINI_PROMPT.includes('box_2d')) throw new Error('GEMINI_PROMPT lost its box_2d line; update the replace to match prompts/vision.ts');

class GeminiVision implements VisionProvider {
  readonly name = 'gemini';
  private ai: GoogleGenAI;
  constructor(readonly model: string, apiKey: string) { this.ai = new GoogleGenAI({ apiKey }); }
  async analyze(jpeg: Buffer): Promise<VisionResult> {
    const res = await withTimeout(this.ai.models.generateContent({
      model: this.model,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
          { text: GEMINI_PROMPT },
        ],
      }],
      config: { responseMimeType: 'application/json', responseJsonSchema: GEMINI_SCHEMA, maxOutputTokens: 400 },
    }), 8000, 'gemini vision');
    const text = res.text;
    if (!text) throw new Error('gemini returned no text');
    const { box_2d, ...rest } = JSON.parse(text) as { box_2d?: number[] };
    return visionResultSchema.parse({ ...rest, bbox: toUnitBox(box_2d, 'yx') });
  }
}

class MockVision implements VisionProvider {
  readonly name = 'mock';
  readonly model = 'mock';
  async analyze(): Promise<VisionResult> {
    await new Promise((r) => setTimeout(r, 400));
    return {
      is_object: true, object_name: 'frying pan', display_name: 'The Pan of Ithaca', weapon_class: 'blunt',
      bbox: [0.25, 0.2, 0.75, 0.8], confidence: 0.95, quip: 'A frying pan? Bold. I like it. Forging now.', color: 'black iron',
    };
  }
}

function build(): VisionProvider {
  if (env.VISION_PROVIDER === 'claude') {
    if (env.ANTHROPIC_API_KEY && env.VISION_MODEL) return new ClaudeVision(env.VISION_MODEL, env.ANTHROPIC_API_KEY);
    log.warn('VISION_PROVIDER=claude but ANTHROPIC_API_KEY or VISION_MODEL missing — using mock vision');
  } else if (env.VISION_PROVIDER === 'gemini') {
    if (env.GEMINI_API_KEY && env.GEMINI_VISION_MODEL) return new GeminiVision(env.GEMINI_VISION_MODEL, env.GEMINI_API_KEY);
    log.warn('VISION_PROVIDER=gemini but GEMINI_API_KEY or GEMINI_VISION_MODEL missing — using mock vision');
  }
  return new MockVision();
}

export const vision: VisionProvider = build();

/** One retry on failure; total bounded by ~16 s. */
export async function analyzeWithRetry(jpeg: Buffer): Promise<VisionResult> {
  try {
    return await withTimeout(vision.analyze(jpeg), 8500, 'vision');
  } catch (e) {
    log.warn({ provider: vision.name, err: errMsg(e) }, 'vision failed, retrying once');
    return withTimeout(vision.analyze(jpeg), 8500, 'vision retry');
  }
}
