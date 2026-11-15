// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* A TRAIL'S LOOK — the table the shader painter (gl.js) reads, every key a
   uniform or a choice of branch. The trail lab's LOOK starts from these
   defaults and puts a dial on each; the slit and flip pages pick one of
   TAILS whole, with one select. */

export const COLOURS = ['gamma', 'spectral', 'heatmap', '70s rainbow']
export const EDGES = ['none', 'spectral', 'dots', 'dust', 'hot liquid glass']
export const PALETTES = ['the reference', 'sunset', 'custom']

export const LOOK_DEFAULTS = {
  /* THE COLOUR, by age: 0 at the ticket, 1 at the tail's end */
  colour: 'gamma', //         one of COLOURS
  stops: 3, //                gamma: this many colours head to tail, 2–4…
  ticketFirst: true, //       …the first the ticket's own (a short trail is all of it: the rest come in as it grows)
  c1: '#7dfbff',
  c2: '#fffbc0', //           pale yellow…
  c3: '#ddbeff', //           …and lavender
  c4: '#ffffff',
  curve: 0.62, //             …and how far along the later ones come in: below 1 sooner (0.62 puts the yellow where the gradient tail has it)
  fromNm: 480, //             spectral: the head's wavelength, nm…
  toNm: 700, //               …and the tail's
  saturation: 1, //           …and how pure, 0 grey
  warp: 0.35, //              heatmap: how far slow noise bends its bands
  grain: 0.14, //             …the film grain over it
  flow: 0.4, //               …how fast the noise drifts
  reverse: false, //          …toggle: cold at the head, hot at the tail
  stripes: 5, //              70s: this many lanes, 3–8, running the trail's length (rings on a circle)
  palette: 'the reference', // …one of PALETTES
  first: '#3fbf5a', //        …custom: the first lane…
  last: '#6b3fa8', //         …and the last
  gap: '#140b12', //          …the dark line between lanes
  gapPx: 2.1, //              …its width

  /* THE EDGE: what happens where the trail meets the black */
  edge: 'none', //            one of EDGES
  fringe: 0.6, //             spectral: the rainbow band, × the trail's half-width…
  soft: 0.55, //              …how softly it glows out, 0..1
  redOutside: false, //       …toggle: red on the outside (off: violet)
  fringeStrength: 1, //       …how much it covers the trail's own colour
  dotPx: 5, //                dots: their pitch, px…
  dotSize: 0.9, //            …the biggest, × the pitch
  dotDepth: 0.6, //           …how deep in from the edge they go (1: the whole trail is dots)
  spread: 0.8, //             dust: how far past the edge it drifts, × the half-width…
  density: 0.55, //           …how many specks
  speckPx: 1.1, //            …each this big
  twinkle: 0.6, //            …and how much they twinkle
  thickness: 1, //            glass: how round the tube, 0 flat
  rim: 2, //                  …the white light on its rim and its streak
  rainbow: 1, //              …the oil-film rainbow at the rim
  wobble: 0, //               …its edge wobbling, like something poured
  heat: 0, //                 …the glow in its core, warm, strongest at the head
}

/* the slit and flip pages' one select: a whole look each. null is a flat
   trail, no shader, in its own colours (paint.js FLAT_TAILS): gradient, as it
   always was, and blue to red; the rest the lab's two picks */
export const TAILS = {
  gradient: null,
  'blue to red': null,
  'hot liquid glass': { ...LOOK_DEFAULTS, edge: 'hot liquid glass' },
  '70s rainbow': { ...LOOK_DEFAULTS, colour: '70s rainbow' },
}
export const TAIL_KINDS = Object.keys(TAILS)
