// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE REWARD BURST — the confetti that fires inside your own tile when a peer
 * accepts you.
 *
 * No React here (architecture rule 6). This module owns the particles, the
 * physics and the beat's numbers; `components/game/reward-burst.tsx` is a
 * canvas host that creates the handle and pumps it from one rAF loop, and
 * `useRewardCue` in components/game/animations.ts maps accepters onto waves.
 *
 * THE WHOLE BURST IS ONE LAYOUT. `burstLayout` builds FULL_PARTICLE_COUNT
 * particles from a seeded RNG, so it is identical on every run. A wave spawns
 * a monotonic PREFIX of that layout — the first spawns particles 0..8, the
 * next adds 9..26, and so on — with the earlier ones still in flight. That is
 * what makes a cascade read as one escalating burst instead of five unrelated
 * pops. Only the count changes per wave: the color, size, angle and velocity
 * of particle `i` never do.
 *
 * The engine steps in FRAMES, not in wall time: a fixed 60fps timestep, which
 * is canvas-confetti's own per-frame model and the model every physics
 * constant below was tuned against.
 *
 * Native equivalents follow the same shape: pre-compute a deterministic array
 * of particle params, then append [start, end) to the active list on each
 * signal (iOS CAEmitterLayer, Android Compose Canvas).
 */

/** the layout's size — every wave is a prefix of this many particles */
export const FULL_PARTICLE_COUNT = 180

/** px/frame initial radial speed (±15% jitter) */
const START_VELOCITY = 12
/** px/frame² downward */
const GRAVITY = 0.2
/** velocity multiplier per frame */
const DECAY = 0.9
/** particle lifetime in frames (≈2s at 60fps) */
const TICKS = 120
/** size multiplier */
const SCALAR = 1.2
/** fade over the final N frames of life */
const FADE_TICKS = 30

/**
 * The burst's palette. It stays a literal list here, not a `--game-*` token:
 * a canvas has no CSS cascade to read from, and reading four custom
 * properties back out with `getComputedStyle` on every spawn would cost a
 * style read per particle for nothing.
 */
const COLORS = ["#6be170", "#413b9c", "#3b60f5", "#503da7"]

/**
 * Applied only to the wave that reaches the LAST particle, so the finale is
 * always distinct from the waves leading up to it: a "golden" style.
 */
const FINALE = {
  palette: ["#ffd700"],
  sizeMul: 1.3,
  velMul: 1.0,
  lifeMul: 1.2,
  glow: 6,
}

/** one frame of the fixed timestep */
const FRAME_MS = 1000 / 60
/**
 * The most catch-up one `step` may do. A throttled tab hands the next frame a
 * gap of minutes, and the while loop would walk every one of those frames.
 * A whole lifetime is enough: past it every particle is dead anyway.
 */
const MAX_CATCH_UP_MS = TICKS * FRAME_MS

/** what a particle is, before it is ever fired */
interface BurstParticle {
  vx: number
  vy: number
  /** where along the top edge it starts, 0..1 */
  xRel: number
  color: string
  size: number
  aspect: number
  shape: "rect" | "circle"
  rotation: number
  rotSpeed: number
}

/** a seeded RNG, so the burst's layout is reproducible across mounts */
function mulberry32(seed: number): () => number {
  return function next() {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The immutable per-particle params for a whole burst. Index `i` always means
 * the same particle, whenever it happens to fire. Particles start along the
 * top edge and fan into the DOWNWARD hemisphere; gravity does the rest.
 */
function burstLayout(count: number, seed = 42): BurstParticle[] {
  const r = mulberry32(seed)
  return Array.from({ length: count }, () => {
    const angle = Math.PI * r() // 0..π, never upward
    const speed = START_VELOCITY * (0.85 + r() * 0.3)
    return {
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      xRel: 0.15 + r() * 0.7, // 15%..85% across the top
      color: COLORS[Math.floor(r() * COLORS.length)],
      size: (5 + r() * 4) * SCALAR, // 6–10.8px
      aspect: 0.5 + r() * 1.0,
      shape: r() < 0.5 ? "rect" : "circle",
      rotation: r() * Math.PI * 2,
      rotSpeed: (r() - 0.5) * 0.3,
    }
  })
}

/** a particle in flight */
interface LiveParticle {
  x: number
  y: number
  vx: number
  vy: number
  color: string
  size: number
  shape: "rect" | "circle"
  aspect: number
  rot: number
  rotSpeed: number
  glow: number
  ticksLeft: number
}

/** the burst, as the canvas host drives it */
export interface BurstHandle {
  /** add the layout's [start, end) particles to whatever is still in flight */
  spawn: (start: number, end: number) => void
  /** advance and repaint. Returns whether anything is still alive. */
  step: (dtMs: number) => boolean
  /** drop everything and clear the canvas */
  destroy: () => void
}

/**
 * Take a canvas and hand back the burst. SIZING HAPPENS ONCE, here: setting a
 * canvas's width or height clears it, so a later fire must never resize. The
 * canvas takes its parent's box, and the device pixel ratio goes into the
 * context transform, so every number above stays in CSS pixels.
 */
export function createBurst(canvas: HTMLCanvasElement): BurstHandle {
  const parent = canvas.parentElement
  const dpr = window.devicePixelRatio || 1
  const w = parent?.clientWidth ?? canvas.clientWidth
  const h = parent?.clientHeight ?? canvas.clientHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext("2d")
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)

  const layout = burstLayout(FULL_PARTICLE_COUNT)
  let active: LiveParticle[] = []
  let accumulator = 0

  const advance = () => {
    for (const p of active) {
      p.x += p.vx
      p.y += p.vy
      p.vx *= DECAY
      p.vy *= DECAY
      p.vy += GRAVITY
      p.rot += p.rotSpeed
      p.ticksLeft -= 1
    }
    active = active.filter((p) => p.ticksLeft > 0)
  }

  const draw = () => {
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    for (const p of active) {
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillStyle = p.color
      ctx.globalAlpha = Math.max(0, Math.min(1, p.ticksLeft / FADE_TICKS))
      if (p.glow > 0) {
        ctx.shadowColor = p.color
        ctx.shadowBlur = p.glow
      }
      if (p.shape === "circle") {
        ctx.beginPath()
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.fillRect((-p.size * p.aspect) / 2, -p.size / 2, p.size * p.aspect, p.size)
      }
      ctx.restore()
    }
  }

  return {
    spawn(start, end) {
      if (!ctx || end <= start) return
      // the wave that reaches the last particle IS the finale
      const finale = end >= FULL_PARTICLE_COUNT
      for (let i = Math.max(0, start); i < Math.min(end, layout.length); i++) {
        const p = layout[i]
        const color = finale ? FINALE.palette[i % FINALE.palette.length] : p.color
        const size = finale ? p.size * FINALE.sizeMul : p.size
        active.push({
          x: w * p.xRel,
          y: -size,
          vx: finale ? p.vx * FINALE.velMul : p.vx,
          vy: finale ? p.vy * FINALE.velMul : p.vy,
          color,
          size,
          shape: p.shape,
          aspect: p.aspect,
          rot: p.rotation,
          rotSpeed: p.rotSpeed,
          glow: finale ? FINALE.glow : 0,
          ticksLeft: finale ? Math.round(TICKS * FINALE.lifeMul) : TICKS,
        })
      }
    },
    step(dtMs) {
      accumulator = Math.min(accumulator + Math.max(0, dtMs), MAX_CATCH_UP_MS)
      // FIXED TIMESTEP: the physics runs in whole frames, never in wall time,
      // so a slow frame slows nothing down — it steps twice instead
      while (accumulator >= FRAME_MS) {
        accumulator -= FRAME_MS
        advance()
      }
      draw()
      return active.length > 0
    },
    destroy() {
      active = []
      accumulator = 0
      ctx?.clearRect(0, 0, w, h)
    },
  }
}

// ── the beat ────────────────────────────────────────────────────────────────
// Your own tile answers the peers who accept you — one wave per accepter, so
// the cascade IS the count. That signal comes off the mesh's own channel, and nowhere else: the
// chain says nothing about who attested you until the report.

/**
 * Five waves, cascading. Each number is the SHARE of the layout that has
 * spawned by the end of that wave, from an intensity ladder of
 * 5/10/15/30/40/100 that drops 10 to land on five waves. Ending on 100 means
 * the last wave is the finale, which is what makes the cascade build to
 * something instead of repeating.
 */
const REWARD_WAVES = [5, 15, 30, 40, 100]
/**
 * A quick cadence. Slower steps make five waves in a single tile
 * read as separate pops instead of one escalating burst.
 */
export const REWARD_STEP_MS = 400

/** the particle count a wave has reached, as a prefix boundary */
function wavePrefix(wave: number): number {
  if (wave < 0) return 0
  const share = REWARD_WAVES[Math.min(wave, REWARD_WAVES.length - 1)]
  return Math.round((share / 100) * FULL_PARTICLE_COUNT)
}

/**
 * The particle range wave `wave` fires: the previous wave's prefix boundary up
 * to this one's. Each wave therefore ADDS to what is already in flight, which
 * is the whole trick — five separate bursts would read as five pops.
 */
export function waveRange(wave: number): { start: number; end: number } {
  return { start: wavePrefix(wave - 1), end: wavePrefix(wave) }
}
