// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* ONE measured anchor: the stage rect. Everything else — canvas size, camera
   distance, the cap's centre, and on a phone the sphere's radius — derives
   from it, so CSS and GL agree on the pixel. World units are NOMINAL stage px
   (a 390×844 phone): with the camera at D = (844/2)/tan(fov/2) the z=0 plane is
   exactly 844 units tall, so a length of R nominal px on that plane is R·scale
   css px at any fov and any window size — the frame scales the whole design
   (layout.scale = actual/nominal). The fov dial only changes how much depth
   shows.

   Mind the difference between R and what you SEE: the sphere's silhouette is
   the tangent cone, not the equator, so it lands at D·R/√(D²−R²) nominal px —
   21 % past R at fov 115. fitR() inverts that. */

export const NOMINAL = { W: 390, H: 844 }

export const layout = { W: 390, H: 844, dpr: 1, scale: 1, D: 905, cx: 195, cy: 422 }

/* the stage's quality ceiling: the most device px per css px it draws at, and
   whether a coin may multisample (coin/lucky.js). 2× is the stage's own; a
   host lowers it when the GPU cannot keep up (jollity's draw steps it down by
   frame time) and fires a resize. The slit page's ?dpr= and ?msaa= set it. */
export const DPR_CAP = { max: 2, msaa: true }

/* the radius whose silhouette lands T nominal px from the centre */
export const fitR = (T, D) => (T * D) / Math.hypot(D, T)

/* true when anything the GL side cares about moved. fov() is the scene's — the
   stage has no opinion about it — and after() is where a scene that fits itself
   to the measurement does so (the sphere's phone radius: scenes/sphere/stage.js),
   called with layout final except for the CSS vars below it. */
export function measure(app, { fov: fovOf = () => 115, after = null } = {}) {
  const r = app.getBoundingClientRect()
  const was = { W: layout.W, H: layout.H, dpr: layout.dpr }
  layout.W = Math.max(1, Math.round(r.width))
  layout.H = Math.max(1, Math.round(r.height))
  layout.dpr = Math.min(DPR_CAP.max, window.devicePixelRatio || 1)
  layout.scale = layout.H / NOMINAL.H
  const fov = Math.min(170, Math.max(5, fovOf())) // a perspective camera cannot reach 180°
  layout.D = NOMINAL.H / 2 / Math.tan((fov * Math.PI) / 360)
  layout.cx = layout.W / 2
  layout.cy = layout.H / 2
  after?.(layout)
  const s = document.documentElement.style
  s.setProperty('--cx', `${layout.cx}px`)
  s.setProperty('--cy', `${layout.cy}px`)
  s.setProperty('--scale', String(layout.scale))
  return layout.W !== was.W || layout.H !== was.H || layout.dpr !== was.dpr
}
