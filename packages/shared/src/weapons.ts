import type { WeaponClass } from './protocol';

export interface WeaponClassSpec {
  lengthM: number;        // longest axis after normalization
  massKg: number;
  damage: number;         // multiplier on impact damage
  sharp: boolean;         // can stick/pin on hit
  throwMult: number;      // multiplier on hand release velocity
  grip: 'end' | 'center'; // where the hand holds it
  examples: string[];     // fed to the vision prompt
}

export const WEAPON_CLASSES: Record<WeaponClass, WeaponClassSpec> = {
  spear:     { lengthM: 1.8, massKg: 2.0, damage: 1.6, sharp: true,  throwMult: 2.6, grip: 'end',
               examples: ['broom', 'mop', 'umbrella', 'pool cue', 'curtain rod', 'long stick', 'selfie stick'] },
  sword:     { lengthM: 0.9, massKg: 1.2, damage: 1.3, sharp: true,  throwMult: 2.0, grip: 'end',
               examples: ['spatula', 'ruler', 'wooden spoon', 'tv remote', 'hairbrush', 'rolled poster', 'tongs'] },
  blunt:     { lengthM: 0.5, massKg: 2.5, damage: 1.8, sharp: false, throwMult: 1.6, grip: 'end',
               examples: ['frying pan', 'book', 'shoe', 'hammer', 'laptop charger brick', 'stapler'] },
  throwable: { lengthM: 0.2, massKg: 0.4, damage: 1.0, sharp: false, throwMult: 3.0, grip: 'center',
               examples: ['ball', 'orange', 'apple', 'soda can', 'plushie', 'rubber duck', 'mug'] },
  shield:    { lengthM: 0.7, massKg: 3.0, damage: 0.8, sharp: false, throwMult: 1.4, grip: 'center',
               examples: ['plate', 'pot lid', 'cutting board', 'tray', 'pizza box', 'baking sheet'] },
  bomb:      { lengthM: 0.25, massKg: 0.6, damage: 2.5, sharp: false, throwMult: 2.4, grip: 'center',
               examples: ['hot sauce bottle', 'aerosol can', 'energy drink', 'firework-looking object'] },
  potion:    { lengthM: 0.22, massKg: 0.5, damage: 0.5, sharp: false, throwMult: 2.0, grip: 'center',
               examples: ['water bottle', 'juice box', 'coffee cup', 'tea mug', 'smoothie'] },
};
// bomb: explodes on first hard impact ("Greek fire") → radial impulse + damage, then despawns.
// potion: heals 40 HP when the holding hand is brought to the mouth (C emits 'drink').
