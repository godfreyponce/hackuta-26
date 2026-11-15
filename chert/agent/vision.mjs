// One Gemini Flash call on one frame: the held-up object's name, box, weapon class and main color.
import { GoogleGenAI, Type } from '@google/genai';

export const VISION_MODEL = process.env.VISION_MODEL || 'gemini-2.5-flash';
export const WEAPON_CLASSES = ['throw', 'bow', 'sword', 'shield'];

const genai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const visionSchema = {
  type: Type.OBJECT,
  properties: {
    object: { type: Type.STRING, nullable: true, description: 'Short name of the main object the person is holding up or showing, or null if none.' },
    box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER }, nullable: true, description: '[ymin, xmin, ymax, xmax] of that object, each 0-1000.' },
    weapon_class: { type: Type.STRING, enum: WEAPON_CLASSES, nullable: true, description: 'The game weapon this object becomes: throw (small or round things), bow (bendy or string-like things), sword (long things), shield (flat or wide things).' },
    color: { type: Type.STRING, nullable: true, description: 'Main color of the object as #rrggbb hex.' },
  },
  required: ['object', 'box_2d', 'weapon_class', 'color'],
};

/**
 * @param {Buffer} jpeg one upright frame
 * @param {string[]} knownNames objects already named in this call, so the same object keeps its name
 * @returns {Promise<{ object: string|null, box_2d: number[]|null, weapon_class: string|null, color: string|null }>}
 */
export async function describeObject(jpeg, knownNames = []) {
  const reuse = knownNames.length ? ` If it is one of these objects, use exactly that name: ${knownNames.map(n => JSON.stringify(n)).join(', ')}.` : '';
  const res = await genai.models.generateContent({
    model: VISION_MODEL,
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
      { text: `What object is the person holding up or showing to the camera? Give its short name, bounding box, the weapon class it becomes in a fighting game, and its main color.${reuse}` },
    ] }],
    config: { responseMimeType: 'application/json', responseSchema: visionSchema, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
  });
  return JSON.parse(res.text || '{}');
}
