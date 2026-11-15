// Armor tiers, after the film research brief:
// "Real bronze is dark, heavy, oxidized, dented" — linen, leather and patinated bronze; Ithaca's house
// colors are blue and red; red horsehair crests on Corinthian-style helmets. Antinous ("the peacock")
// is evoked with tinned bronze, gilt, a lion pelt and purple — not the film's exact costume.
import * as THREE from 'three';
import type { SlotLook, ShieldKind } from './armoredRenderer';
import type { EnemyKind } from './enemies';
import { pick, rand } from './math';

const C = (h: string) => new THREE.Color(h);
const SKINS = ['#b98a68', '#a77656', '#c79a7a', '#8f6448', '#c49272'];
const REVELER_CHITON = ['#D8CEB4', '#C8962E', '#6E1F2B', '#8a7a5a', '#233554', '#7A2622'];
const CREST_RED = '#8E1C18';

export function lookFor(kind: EnemyKind, armed: boolean, shield: ShieldKind): SlotLook {
  const base = { cloak: null, pelt: null, boss: false, shieldDevice: 'scorpion' as const };
  if (kind === 'hero') {
    // Odysseus: closed Corinthian, dark patinated bronze over leather, dark-red crest and cloak, worn boar shield
    return {
      ...base, scale: 1.04, skin: C('#a87454'), chiton: C('#4A3B30'),
      armor: 'muscle', armorTint: C('#6E5436'), helmet: 'corinthian', helmetTint: C('#6E5436'),
      crest: 'long', crestColor: C('#7E1A16'), leather: C('#3B2A1D'), greaves: true, bracers: true,
      cloak: C('#5C2A22'), prop: 'bow', shield: 'round', shieldDevice: 'boar-worn',
    };
  }
  if (kind === 'boss') {
    // Antinous, the peacock: tinned bronze with gilt, transverse white crest, lion pelt, purple cloak
    return {
      ...base, scale: 1.14, skin: C('#b48462'), chiton: C('#4B2342'),
      armor: 'muscle', armorTint: C('#CBC7BE'), helmet: 'corinthian', helmetTint: C('#D4AF5A'),
      crest: 'trans', crestColor: C('#E2DACB'), leather: C('#2a1a12'), greaves: true, bracers: true,
      cloak: C('#4B2342'), pelt: C('#B88A4E'), prop: 'xiphos', shield, shieldDevice: 'lion-gilt', boss: true,
    };
  }
  if (kind === 'archer') {
    return {
      ...base, scale: rand(0.94, 1.02), skin: C(pick(SKINS)), chiton: C('#6B6A3E'),
      armor: 'linothorax', armorTint: C('#6B6A3E'), helmet: 'pilos', helmetTint: C('#7A3B1E'),
      crest: 'none', crestColor: C('#000000'), leather: C('#4a3424'), greaves: false, bracers: true,
      prop: 'bow', shield: 'none',
    };
  }
  if (armed) {
    // Melanthius raided Odysseus's storeroom: polished-but-dusty bronze, red crests, Ithaca-blue shields
    const muscle = Math.random() < 0.5;
    return {
      ...base, scale: rand(0.95, 1.05), skin: C(pick(SKINS)), chiton: C(pick(['#7A2622', '#233554', '#6E1F2B'])),
      armor: muscle ? 'muscle' : 'linothorax', armorTint: C(muscle ? pick(['#B0804A', '#9a7040']) : '#D8CEB4'),
      helmet: 'corinthian', helmetTint: C(pick(['#B0804A', '#9a7040'])),
      crest: Math.random() < 0.85 ? 'long' : 'trans', crestColor: C(Math.random() < 0.7 ? CREST_RED : '#141110'),
      leather: C('#5A3A22'), greaves: true, bracers: false,
      cloak: Math.random() < 0.2 ? C(pick(['#5a1814', '#1d2a40'])) : null,
      prop: Math.random() < 0.45 ? 'spear' : 'xiphos', shield, shieldDevice: 'boar-blue',
    };
  }
  // wave 1: the wooers in their linen and leather, patinated caps and Corinthians, short swords
  const corinthian = Math.random() < 0.45;
  return {
    ...base, scale: rand(0.94, 1.04), skin: C(pick(SKINS)), chiton: C(pick(REVELER_CHITON)),
    armor: 'linothorax', armorTint: C(pick(['#D8CEB4', '#c9bb98', '#b9ad92'])),
    helmet: corinthian ? 'corinthian' : 'pilos', helmetTint: C(corinthian ? pick(['#7A5C38', '#5E4A32']) : '#5A3A22'),
    crest: corinthian && Math.random() < 0.6 ? 'long' : 'none', crestColor: C(CREST_RED),
    leather: C('#5A3A22'), greaves: Math.random() < 0.4, bracers: false,
    prop: 'xiphos', shield, shieldDevice: 'scorpion',
  };
}
