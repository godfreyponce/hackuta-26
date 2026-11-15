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
  bbox: [number, number, number, number];
  confidence: number;
  quip: string;
  rejected?: 'person_only' | 'no_object' | 'unsafe' | 'screen_or_ui';
}
export interface VisionProvider { readonly name: string; readonly model: string; analyze(jpeg: Buffer): Promise<VisionResult> }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export const visionResultSchema = z.object({
  is_object: z.boolean(),
  object_name: z.string().default(''),
  display_name: z.string().default(''),
  weapon_class: z.enum(['spear', 'sword', 'blunt', 'throwable', 'shield', 'bomb', 'potion']).catch('blunt'),
  bbox: z.array(z.number()).length(4).catch([0, 0, 1, 1]),
  confidence: z.number().catch(0),
  quip: z.string().default(''),
  rejected: z.enum(['person_only', 'no_object', 'unsafe', 'screen_or_ui']).optional().catch(undefined),
}).transform((r): VisionResult => {
  const [a = 0, b = 0, c = 1, d = 1] = r.bbox.map(clamp01);
  const x0 = Math.min(a, c), x1 = Math.max(a, c), y0 = Math.min(b, d), y1 = Math.max(b, d);
  const out: VisionResult = {
    is_object: r.is_object,
    object_name: r.object_name.trim().toLowerCase().slice(0, 60),
    display_name: r.display_name.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 60),
    weapon_class: r.weapon_class,
    bbox: [x0, y0, x1, y1],
    confidence: clamp01(r.confidence),
    quip: r.quip.trim().slice(0, 140),
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
          { text: VISION_PROMPT.replace('by calling the report_object tool exactly once', 'as a single JSON object') },
        ],
      }],
      config: { responseMimeType: 'application/json', responseJsonSchema: VISION_JSON_SCHEMA, maxOutputTokens: 400 },
    }), 8000, 'gemini vision');
    const text = res.text;
    if (!text) throw new Error('gemini returned no text');
    return visionResultSchema.parse(JSON.parse(text));
  }
}

class MockVision implements VisionProvider {
  readonly name = 'mock';
  readonly model = 'mock';
  async analyze(): Promise<VisionResult> {
    await new Promise((r) => setTimeout(r, 400));
    return {
      is_object: true, object_name: 'frying pan', display_name: 'The Pan of Ithaca', weapon_class: 'blunt',
      bbox: [0.25, 0.2, 0.75, 0.8], confidence: 0.95, quip: 'A frying pan? Bold. I like it. Forging now.',
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
