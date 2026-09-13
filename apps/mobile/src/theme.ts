/**
 * One small, high-contrast palette (docs/06 §6.1). Deliberately not a design
 * system: this app has seven screens and one job, and a human has to read a
 * refusal reason correctly at a glance on a phone in sunlight.
 */
export const colors = {
  bg: '#0B1220',
  surface: '#141C2E',
  surfaceAlt: '#1C2740',
  border: '#2A3855',
  text: '#F2F6FF',
  textMuted: '#9BA9C4',
  buy: '#2ECC71',
  sell: '#FF6B6B',
  ok: '#2ECC71',
  warn: '#FFB020',
  danger: '#FF4D4D',
  accent: '#4D9DFF',
  disabled: '#3A4460',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

export const font = {
  /** Everything tappable is at least this tall (docs/06 §6.1, large targets). */
  minTouchTarget: 48,
  h1: 28,
  h2: 20,
  body: 16,
  small: 13,
  mono: 15,
} as const;
