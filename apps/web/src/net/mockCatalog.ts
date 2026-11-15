import type { WeaponClass } from '@ithaca/shared';

/** Objects the mock "Telemachus" holds up, in demo order. Frying pan first (spec A.10). */
export interface MockObject {
  objectName: string;
  displayName: string;
  weaponClass: WeaponClass;
  glbUrl: string;
  quip: string;
}

export const MOCK_OBJECTS: MockObject[] = [
  { objectName: 'frying pan', displayName: 'The Pan of Ithaca', weaponClass: 'blunt', glbUrl: '/dev/sample-weapon.glb',
    quip: 'A frying pan? Bold. I like it. Forging now.' },
  { objectName: 'broom', displayName: 'Spear of the Hearth', weaponClass: 'spear', glbUrl: '/prefabs/spear.glb',
    quip: "Your mother's broom? It'll pin a wooer yet." },
  { objectName: 'pot lid', displayName: 'The Lid of Laertes', weaponClass: 'shield', glbUrl: '/prefabs/shield.glb',
    quip: 'A pot lid. Hold it high, it stops arrows.' },
  { objectName: 'hot sauce bottle', displayName: 'Fire of the Kitchen', weaponClass: 'bomb', glbUrl: '/prefabs/bomb.glb',
    quip: "Ha! That'll go up like Greek fire." },
  { objectName: 'water bottle', displayName: 'Draught of Eumaeus', weaponClass: 'potion', glbUrl: '/prefabs/potion.glb',
    quip: "Water. He's bleeding, so it's medicine now." },
  { objectName: 'spatula', displayName: 'Blade of the Larder', weaponClass: 'sword', glbUrl: '/prefabs/sword.glb',
    quip: 'A spatula. Flat, quick, and mean. Good.' },
  { objectName: 'orange', displayName: 'Fruit of Scheria', weaponClass: 'throwable', glbUrl: '/prefabs/throwable.glb',
    quip: 'An orange. Throw it hard, lad.' },
];

const ICON_PATHS: Record<WeaponClass, string> = {
  spear: 'M30 170 L150 50 L162 38 L170 30 L158 46 L146 58 L38 178 Z M150 50 L176 24 L162 54 Z',
  sword: 'M60 160 L70 150 L140 64 L160 40 L150 70 L80 160 L70 170 Z M56 150 L80 174 L74 180 L50 156 Z',
  blunt: 'M100 40 a45 45 0 1 1 -0.1 0 Z M92 120 L108 120 L112 182 L88 182 Z',
  throwable: 'M100 52 a52 52 0 1 1 -0.1 0 Z M98 40 q8 -16 22 -16 q-6 14 -22 16 Z',
  shield: 'M100 28 a72 72 0 1 1 -0.1 0 Z',
  bomb: 'M80 70 L120 70 L120 56 L80 56 Z M60 90 q40 -30 80 0 q14 30 0 70 q-40 28 -80 0 q-14 -40 0 -70 Z M100 56 q6 -20 20 -28 l6 8 q-14 6 -18 20 Z',
  potion: 'M88 30 L112 30 L112 60 q34 18 30 66 q-4 46 -42 46 q-38 0 -42 -46 q-4 -48 30 -66 Z',
};

/** Black-figure style placeholder "photo" for mock objects (SVG data URI; no external assets). */
export function mockThumb(objectName: string, cls: WeaponClass): string {
  const label = objectName.toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<defs><radialGradient id="g" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#C86A3A"/><stop offset="1" stop-color="#7A3418"/></radialGradient></defs>
<rect width="200" height="200" fill="url(#g)"/>
<path d="${ICON_PATHS[cls]}" fill="#16110D"/>
<rect x="0" y="176" width="200" height="24" fill="#16110D" opacity="0.85"/>
<text x="100" y="193" font-family="Montserrat, sans-serif" font-size="13" font-weight="700" letter-spacing="2" fill="#D6CCBA" text-anchor="middle">${label}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const CLASS_ICON_PATHS = ICON_PATHS;
