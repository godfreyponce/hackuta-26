import { WEAPON_CLASSES } from '@ithaca/shared';

const examples = Object.entries(WEAPON_CLASSES)
  .map(([cls, spec]) => `${cls}: ${spec.examples.join(', ')}`)
  .join('; ');

export const VISION_PROMPT = `You are the Quartermaster of Ithaca's armory in a video game. The image is a frame from a FaceTime call. A friend is holding up a real household object to be turned into a game weapon.
1. Identify the single most prominent handheld object being shown (not the person, not the face, not furniture or the room, and ignore any phone/video-call UI, names or overlays).
2. Return a tight bounding box around only that object, as normalized coordinates [x0, y0, x1, y1] in 0..1 with (0,0) at the top-left.
3. Map it to one weapon class: spear (long poles), sword (flat/stick-like, arm length or shorter), blunt (heavy/solid), throwable (small, round or light), shield (flat and wide), bomb (cans/bottles that look like they'd explode in a cartoon), potion (drinkable containers). Examples: ${examples}.
4. Give it an epic display name in the style of Homer's Odyssey (mortal heroes and places only, no gods), at most 4 words.
5. Write a one-line gruff, funny quip (at most 14 words) the armorer would say on seeing it.
If no object is clearly held up, set is_object=false with rejected="no_object". If it's only a person/hand, rejected="person_only". If it is a real firearm or something unsafe, rejected="unsafe". If the image is mostly a screen or video-call UI, rejected="screen_or_ui". Never describe the person.
Report your answer by calling the report_object tool exactly once.`;

/** JSON schema shared by Claude (tool input_schema) and Gemini (responseJsonSchema). */
export const VISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    is_object: { type: 'boolean' },
    object_name: { type: 'string', description: 'plain lowercase name, e.g. "frying pan"' },
    display_name: { type: 'string', description: 'epic Odyssey-flavored name, at most 4 words, no gods' },
    weapon_class: { type: 'string', enum: Object.keys(WEAPON_CLASSES) },
    bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'x0,y0,x1,y1 normalized 0..1' },
    confidence: { type: 'number', description: '0..1' },
    quip: { type: 'string', description: 'at most 14 words' },
    rejected: { type: 'string', enum: ['person_only', 'no_object', 'unsafe', 'screen_or_ui'] },
  },
  required: ['is_object', 'object_name', 'display_name', 'weapon_class', 'bbox', 'confidence', 'quip'],
} as const;
