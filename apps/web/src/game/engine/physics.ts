import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

let ready: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!ready) ready = RAPIER.init();
  return ready;
}

// Interaction groups: (membership << 16) | filter
export const G = {
  STATIC: 1 << 0,
  RAGDOLL: 1 << 1,
  WEAPON: 1 << 2,   // free (dynamic) weapons and arrows
  HELD: 1 << 3,     // held (kinematic) weapons + hands
} as const;

export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export const GROUPS = {
  static: groups(G.STATIC, G.RAGDOLL | G.WEAPON),
  ragdoll: groups(G.RAGDOLL, G.STATIC | G.RAGDOLL | G.WEAPON | G.HELD),
  weapon: groups(G.WEAPON, G.STATIC | G.RAGDOLL | G.WEAPON),
  held: groups(G.HELD, G.RAGDOLL),
  none: groups(0, 0),
};
