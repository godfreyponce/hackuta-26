// Design tokens — "bronze & firelight", tuned to the desaturated orange/blue grade
// reviewers describe for the 2026 film (values inferred from descriptions; no film assets used).
// Mirrored as CSS custom properties in styles/tokens.css. Keep both in sync.
export const C = {
  soot: '#14110E',
  soot2: '#1D1915',
  soot3: '#27211B',
  timber: '#3B2E22',
  stone: '#6E665B',
  dust: '#A89F8E',
  linen: '#D6CCBA',
  bronzeDark: '#4E3D2A',
  bronze: '#8A6A40',
  brass: '#C49A4A',
  verdigris: '#3E5B50',
  verdigrisLight: '#6E9C88',
  ithacaRed: '#7A2622',
  alarm: '#C23B2E',
  ithacaBlue: '#233554',
  night: '#1B2737',
  blueRim: '#3C566E',
  fireCore: '#FFC070',
  flame: '#F08A2E',
  ember: '#A9431A',
  terracotta: '#B5562E',
  blood: '#5A1512',
  mist: '#9AA3A2',
} as const;

// Lighting (Kelvin-ish → RGB approximations). Key:fill ≈ 10:1.
export const LIGHT = {
  hearth: '#FF9A4A',      // ~2000K
  brazier: '#FF8A3A',
  moon: '#7F9DC4',        // ~7000K cool fill
  ambientSky: '#2A3446',
  ambientGround: '#1A120B',
  fog: '#120E0B',
} as const;

export const FONTS = {
  display: "'Montserrat Variable', 'Montserrat', system-ui, sans-serif",
  lore: "'Cormorant Garamond', 'EB Garamond', Georgia, serif",
  inscription: "'Cinzel', 'Cormorant Garamond', serif",
} as const;
