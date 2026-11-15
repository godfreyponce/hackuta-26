// Costume & armor tiers, matched to what the characters wear in The Odyssey (2026) per the research brief —
// evoked, not copied:
//  • Odysseus: Corinthian with a tall red "broom-top" plume, cape, wrist armour; patinated, dented bronze and
//    battle-tested matte leather ("no shining bronze"); baggy trousers; hunting bow.
//  • His men / the storeroom kit: patinated bronze + leather, faux-Corinthians with red plumes, trousers, bracers.
//  • The suitors: "overly layered and decorated… wear everything they have" — dyed linen, brass embellishment,
//    short kilts, draped cloaks. (Melanthius arms them from Odysseus's storeroom in Book XXII.)
//  • Antinous, "the peacock": clean courtly finery, silver/tinned plate with brass-gilt embellishment, a fur
//    collar, the shortest kilt, over-the-knee sandals — here a gilt circlet, tinned cuirass with gilt trim,
//    lion pelt (not the film's cheetah), deep purple cloak, lacing to the knee.
// Ithaca's house colours: blue and red.
import * as THREE from 'three';
import type { SlotLook, ShieldKind } from './armoredRenderer';
import type { EnemyKind } from './enemies';
import { pick, rand } from './math';

const C = (h: string) => new THREE.Color(h);
const SKINS = ['#b98a68', '#a77656', '#c79a7a', '#8f6448', '#c49272'];
const SUITOR_DYES = ['#6E1F2B', '#233554', '#C8962E', '#7A2622', '#3E5B50', '#5C3B2A'];
const PLUME_RED = '#8E1C18';
const BRASS = '#C9A24A';

export function lookFor(kind: EnemyKind, armed: boolean, shield: ShieldKind): SlotLook {
  const base = { cloak: null, pelt: null, boss: false, shieldDevice: 'scorpion' as const, trousers: null, lacing: false, circlet: false, trim: null, quiver: false };
  if (kind === 'hero') {
    return {
      ...base, scale: 1.04, skin: C('#a87454'), chiton: C('#4A3B30'),
      armor: 'linothorax', armorTint: C('#3B2A1D'),            // matte, battle-tested leather cuirass
      helmet: 'corinthian', helmetTint: C('#5A4630'),          // dark patinated bronze
      crest: 'long', crestColor: C(PLUME_RED), leather: C('#3B2A1D'), greaves: true, bracers: true,
      cloak: C('#4A1A14'), trousers: C('#5E5040'), trim: C('#6E5436'),
      prop: 'bow', shield: 'round', shieldDevice: 'boar-worn',
    };
  }
  if (kind === 'boss') {
    return {
      ...base, scale: 1.12, skin: C('#b48462'), chiton: C('#3A1030'),
      armor: 'muscle', armorTint: C('#CBC7BE'),                // tinned bronze
      helmet: 'none', helmetTint: C('#D4AF5A'), circlet: true, // courtly, bare-headed: gilt circlet
      crest: 'none', crestColor: C('#E2DACB'), leather: C('#3a2416'), greaves: false, lacing: true, bracers: true,
      cloak: C('#3A1030'), pelt: C('#B88A4E'), trim: C('#D4AF5A'),
      prop: 'xiphos', shield, shieldDevice: 'lion-gilt', boss: true,
    };
  }
  if (kind === 'archer') {
    return {
      ...base, scale: rand(0.94, 1.02), skin: C(pick(SKINS)), chiton: C('#5C3B2A'),
      armor: 'linothorax', armorTint: C('#D6CFBC'), trim: C('#9a6a2a'),
      helmet: 'pilos', helmetTint: C('#7A3B1E'), crest: 'none', crestColor: C('#000000'),
      leather: C('#4a3424'), greaves: false, bracers: true, quiver: true, prop: 'bow', shield: 'none',
    };
  }
  if (armed) {
    // Melanthius brought Odysseus's own kit from the storeroom: patinated bronze, leather, red plumes, trousers
    const muscle = Math.random() < 0.55;
    return {
      ...base, scale: rand(0.95, 1.05), skin: C(pick(SKINS)), chiton: C(pick(['#7A2622', '#233554'])),
      armor: muscle ? 'muscle' : 'linothorax', armorTint: C(muscle ? pick(['#7A5C38', '#6E5436', '#8A6A40']) : '#4A3826'),
      helmet: 'corinthian', helmetTint: C(pick(['#7A5C38', '#6E5436'])),
      crest: Math.random() < 0.85 ? 'long' : 'trans', crestColor: C(Math.random() < 0.8 ? PLUME_RED : '#141110'),
      leather: C('#4A3826'), greaves: true, bracers: true, trousers: C(pick(['#6B5E4A', '#4f4436'])),
      cloak: Math.random() < 0.25 ? C(pick(['#5a1814', '#1d2a40'])) : null,
      prop: Math.random() < 0.45 ? 'spear' : 'xiphos', shield, shieldDevice: 'boar-blue',
    };
  }
  // wave 1 — the suitors: dyed, layered, brass-embellished linen; short kilts; caps or old Corinthians
  const corinthian = Math.random() < 0.35;
  return {
    ...base, scale: rand(0.94, 1.04), skin: C(pick(SKINS)), chiton: C(pick(SUITOR_DYES)),
    armor: 'linothorax', armorTint: C(pick(['#E9E4D6', '#E2DCCB', '#DAD3BF'])), trim: C(BRASS), // bleached linen
    helmet: corinthian ? 'corinthian' : 'pilos', helmetTint: C(corinthian ? '#B0804A' : '#5A3A22'),
    crest: corinthian ? 'long' : 'none', crestColor: C(PLUME_RED),
    leather: C('#5A3A22'), greaves: false, lacing: Math.random() < 0.5, bracers: false,
    cloak: Math.random() < 0.45 ? C(pick(SUITOR_DYES)) : null,
    prop: 'xiphos', shield, shieldDevice: 'scorpion',
  };
}
