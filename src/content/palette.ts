/** 调色板：与 `docs/GAME_DESIGN.md` §8.1 的半写实暗黑基调一致。 */
export const COLOR = {
  void: 0x07060c,
  floor0: 0x151226,
  floor1: 0x0b0a14,
  stone0: 0x2e2740,
  stone1: 0x43395c,
  stone2: 0x565073,
  lava: 0xff6b4a,
  lavaHot: 0xffb347,
  blood: 0xff3b5c,
  hero: 0xd8c8b0,
  leather: 0x8a6a4a,
  leatherDark: 0x5c4430,
  steel: 0x9aa3ad,
  shadow: 0x05040a,
  slime: 0x7be05f,
  ghost: 0x9b6bff,
  bone: 0xe6e0d4,
  spider: 0x55d68a,
  poison: 0x8ef07a,
} as const;

/** CSS 变量用的字符串色（HUD 与 Pixi 共用一套色）。 */
export const CSS_COLOR = {
  hero: '#d8c8b0',
  blood: '#ff3b5c',
  lava: '#ff6b4a',
  steel: '#9aa3ad',
} as const;
