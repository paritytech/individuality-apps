// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN'S LOOK, AS DATA — every key the lab's coin (this folder) reads,
   and the two looks the pages play:

     BASE_LOOK    the lab's defaults: the Winners coin (metal)
     LUCKY_LOOK   the Lucky coin: green plastic, a clover cut into the field,
                  FAIR DRAW and GOOD LUCK in 3D letters — the intro's
                  coin (render-utils/coin/lucky.js), and what the lab's Lucky
                  coin button gives (coin-look/config.js LUCKY, in the panel's
                  own shape; the coin-look smoke holds the two together)
     GOOD_LUCK_LOOK  the Good luck coin: teal plastic, a spiral on a plain
                  front, GOOD LUCK in 3D letters on the back — the slit
                  draw's coin, and the lab's Good luck coin button (GOOD_LUCK)

   The comments on each key are the lab's: sizes are FRACTIONS of the coin's
   radius, not px, so one shape holds at any coinR. Nothing here reads a page's
   table; the lab keeps its live copy (LOOK) and hands it in. */

/* F0 of each metal, as sRGB hex (three converts to linear). Physically based
   values, a touch richer than the measured ones so they read on a phone */
export const METALS = {
  silver: '#fcfaf5',
  gold: '#ffd98a',
  roseGold: '#f6c3ad',
  copper: '#f2a883',
  bronze: '#d9ab7a',
  steel: '#c8c9c8',
}
export const METAL_NAMES = [...Object.keys(METALS), 'custom']
export const FINISHES = ['spun', 'linear', 'polished'] // spun: concentric grooves, the reference's radial light cone
export const PATTERNS = ['none', 'stipple', 'guilloche', 'knurl']
export const LETTER_TOPS = ['frosted', 'polished', 'brushed'] // the walls are always polished: that rim of light is what says 'raised'
export const LETTER_PROFILES = ['struck', 'rounded', 'chamfer']
export const LETTER_BUILDS = ['relief', 'geometry']
export const TONE_MAPS = ['agx', 'neutral', 'off']
export const AA_MODES = ['smaa', 'fxaa', 'msaa4', 'off']
export const MAP_SIZES = ['512', '1024', '2048'] // 512: the draw's coins (slit/config.js)
export const BACK_DESIGNS = ['words', 'logo']

export const BASE_LOOK = {
  /* the metal */
  metal: 'custom', //        one of METAL_NAMES
  customColour: '#a8a8a8', // …used when metal is 'custom'
  /* the finish */
  finish: 'spun', //         spun | linear | polished
  brush: 0.33, //            how far the brushing stretches the highlight (anisotropy, 0..1)
  roughness: 0.18, //        the field's own roughness
  grain: 0.22, //            the brush lines you see up close (roughness + a touch of normal)
  /* the engraving */
  amount: 50, //            the face's big line: digits read as an amount (1,250), or any words, or empty
  backLabel: 'LUCKY YOU', //  the back's words, a line each
  backDesign: 'words', //    the back: its words, or the Polkadot symbol on a plain disc
  logoDisc: 30, //           …the disc's radius, % of the field's: the pattern stops at it
  logoSize: 70, //           …the symbol, % of the disc
  label: 'cash', //          …and the word under them
  height: 1.2, //            the letters' height, % of the coin's diameter — one number for the
  //                         relief's normals, the parallax and the 3D letters alike
  bevel: 0.1, //             the letters' walls, % of the diameter: how far the shoulder runs in
  profile: 'struck', //     the wall's shape: struck (steep, a small round shoulder, flat top) | rounded | chamfer
  build: 'geometry', //      relief: normal-mapped (cheap, flat when tilted) · geometry: real 3D letters
  raised: true, //           letters stand up from the field; off, they are cut into it (relief only)
  tops: 'polished', //       the letters' tops: frosted | polished | brushed — the walls stay polished
  frostRoughness: 0.43, //   …the frost's roughness
  wallRoughness: 0.8, //    the letters' walls — their height: 0.03 a mirror, like the tops as it rises
  topCurve: 0.41, //          the tops curve down to their edges, in letter heights: a light side and a
  //                         shadow side across every cap, as on a struck coin (0: machined flat)
  topCurveWidth: 0.2, //     …over this much of each cap's edge, % of the diameter
  cavity: 0.5, //              how dark the grooves go (the cavity map's strength)
  pattern: 'none', //        the rim band's pattern: none | stipple (the reference's sandblast) | guilloche | knurl
  fieldPattern: 'guilloche', // the field behind the letters: see patterns.js
  patternScale: 1, //        …its density
  patternDepth: 0.18, //     …how deep its lines are cut, % of the diameter — the letters' height does not change it
  cloverRaised: false, //    the clover's leaves stand up from the field, the hatching cut into them
  reeds: 0, //               ridges round the edge (0: a smooth edge)
  /* the light */
  followTilt: true, //       gyro / mouse turn the room round the coin, so the highlights sweep
  //                         (off: the room stays put; the coin still leans by tiltShare)
  swing: 30, //              deg: how far the tilt may go, each axis
  tiltShare: 1, //           how much of that the coin itself turns (1: you walk round a still coin)
  keyAz: 35, //             where the key light is: azimuth, deg (0 behind you, − to the left)…
  keyEl: 72, //              …and elevation, deg. The whole studio turns with it, and the glint
  room: 3.6, //              the studio's brightness (environment intensity)
  backLight: 0, //           a soft panel behind the coin: what the letters' polished walls and the coin's edge
  //                         reflect, since they are seen edge-on (0: none; rebuilds the studio)
  glint: 12, //             the key light that makes the crisp glint
  glow: 2.16, //              bloom on the glints
  shadows: false, //          the 3D letters cast shadows from the key (a shadow map; recompiles)
  shadowSoft: 3, //          …their edge's softness (PCF radius, texels)
  shadowRoom: 0.6, //        …and how much the shadow also dims the room's reflection: on metal a
  //                         light's own shadow barely shows, since the metal shows the room
  /* the shine at the edges */
  edgeCalm: 0.57, //          specular antialiasing: roughness widens where the normal turns faster than a pixel
  ceiling: 40, //             no pixel brighter than this before the bloom — single hot pixels stop sparkling
  keepHue: true, //          …and a pixel over it keeps its colour, scaled down, instead of clipping toward white
  sheen: 0, //            a soft light on edges turned toward the key, so no edge goes black
  glints: 8, //              star glints on the rim that flash as the tilt lines them up (0: none)
  glintStars: 0.65, //          …their strength
  idle: true, //             the coin sways a little when left alone
  /* the coin */
  coinR: 113, //             radius, nominal px — 100 is the intro's coin
  thick: 0.03, //            thickness, × radius
  sides: 0, //               the coin's outline: 0 round, 3… a polygon
  round: 0.25, //            …its corners' radius, × the coin's radius (1: round again)
  edgeRound: 0, //           the rim's outer corner: 0 a sharp edge, 1 a full quarter round
  rimW: 0.12, //             the raised rim's width, × radius
  lens: 65, //               the camera's field of view, deg — the intro's too (LUCKY_LOOK)
  /* the skin: the same coin in another material (skins/) */
  skin: 'metal', //          metal | plastic | glass | pixel | lava | matrix | neon
  plasticColour: '#e8423c',
  plasticTopColour: '#ffd23f',
  plasticWallColour: true, // the letters' walls take the second colour too (the coin's edge keeps the first)
  plasticGloss: 1,
  plasticRoughness: 0.35,
  plasticReflection: 1, //   how much the plastic reflects, head-on and edge-on (0: chalk, no white rims)
  glassTint: '#d8f0ff',
  glassIor: 1.5,
  glassDispersion: 0.04,
  glassFrost: 0.12,
  glassDepth: 0.7,
  pixelSize: 4,
  pixelPalette: 'gameboy',
  pixelDither: 0.6,
  lavaColour: '#ff4a12',
  lavaHeat: 0.9,
  lavaScale: 4,
  lavaSpeed: 0.25,
  matrixColour: '#2bff6a',
  matrixGlyphsAcross: 28,
  matrixSpeed: 1,
  matrixTrail: 0.6,
  neonColourA: '#ff2bd6',
  neonColourB: '#27e8ff',
  neonTubeWidth: 1,
  neonFlicker: 0.25,
  /* the cost */
  toneMapping: 'neutral', // agx | neutral | off
  aa: 'msaa4', //              smaa | fxaa | msaa4 | off — the 3D letters' edges stair-step without one
  parallax: false, //        parallax occlusion: real depth at an angle, 8–32 reads a pixel
  parallaxSteps: 16,
  clearcoat: false, //       a lacquer layer over the metal
  mapSize: '1024', //        the engraving maps' side, texels
  readout: true, //          the cost line under the coin
}

/* the Lucky coin: BASE_LOOK with the Lucky coin button's values over it */
export const LUCKY_LOOK = {
  ...BASE_LOOK,
  skin: 'plastic',
  plasticColour: '#135824',
  plasticTopColour: '#767e07',
  plasticWallColour: false,
  plasticGloss: 0,
  plasticRoughness: 1,
  plasticReflection: 0,
  metal: 'custom',
  customColour: '#a8a8a8',
  finish: 'linear',
  roughness: 0.03,
  brush: 0.33,
  grain: 0.22,
  amount: 'fair draw',
  label: '',
  raised: true,
  build: 'geometry',
  height: 1.5,
  bevel: 0.85,
  profile: 'struck',
  tops: 'polished',
  wallRoughness: 0.8,
  topCurve: 1.5,
  topCurveWidth: 0.2,
  cavity: 0.5,
  pattern: 'stipple',
  backDesign: 'words',
  logoDisc: 30,
  logoSize: 76,
  backLabel: 'Good Luck',
  fieldPattern: 'clover',
  patternScale: 1,
  patternDepth: 0.6,
  cloverRaised: false,
  reeds: 169,
  keyAz: -37,
  keyEl: 29,
  followTilt: true,
  swing: 30,
  tiltShare: 1,
  room: 3.94,
  backLight: 0,
  glint: 12,
  glow: 0,
  shadows: false,
  idle: true,
  edgeCalm: 2,
  ceiling: 1,
  keepHue: true,
  sheen: 0,
  glints: 0,
  sides: 0,
  edgeRound: 0.4,
  coinR: 100,
  thick: 0.13,
  rimW: 0.08,
  lens: 65,
  readout: true,
  toneMapping: 'neutral',
  aa: 'msaa4',
  parallax: false,
  clearcoat: false,
  mapSize: '1024',
}

/* the Good luck coin: BASE_LOOK with the Good luck coin button's values over it —
   GOOD LUCK raised on a spiral on its front, the logo on its back */
export const GOOD_LUCK_LOOK = {
  ...BASE_LOOK,
  skin: 'plastic',
  plasticColour: '#49b4b6',
  plasticTopColour: '#292929',
  plasticWallColour: true,
  plasticGloss: 0.28,
  plasticRoughness: 0.33,
  plasticReflection: 1,
  amount: 'good luck',
  label: '',
  raised: true,
  build: 'geometry',
  height: 1.1,
  bevel: 2,
  profile: 'struck',
  tops: 'polished',
  wallRoughness: 0.03,
  topCurve: 1.08,
  topCurveWidth: 0.2,
  cavity: 0.45,
  pattern: 'none',
  backDesign: 'logo',
  backLabel: 'GOOD LUCK',
  logoDisc: 38,
  logoSize: 64,
  fieldPattern: 'spiral',
  patternScale: 0.8,
  patternDepth: 0.26,
  reeds: 229,
  keyAz: -13,
  keyEl: 73,
  followTilt: true,
  swing: 30,
  tiltShare: 1,
  room: 1.92,
  backLight: 3,
  glint: 12,
  glow: 3,
  shadows: true,
  shadowSoft: 12,
  shadowRoom: 0,
  idle: true,
  edgeCalm: 2,
  ceiling: 3,
  keepHue: true,
  sheen: 0,
  glints: 8,
  glintStars: 1.6,
  sides: 0,
  edgeRound: 0,
  coinR: 100,
  thick: 0.095,
  rimW: 0.12,
  lens: 65,
  readout: true,
  toneMapping: 'neutral',
  aa: 'msaa4',
  parallax: false,
  clearcoat: false,
  mapSize: '1024',
}

/* the letters are geometry only when they stand up: cut letters would need a boolean cut */
export const geometryLetters = (L) => L.build === 'geometry' && L.raised

/* the colour the metal is in look L */
export const metalHex = (L) => (L.metal === 'custom' ? L.customColour : METALS[L.metal] ?? METALS.silver)
