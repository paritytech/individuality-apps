// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * ALL game-screen choreography lives here, tuned in one place:
 *
 *  - useGridChoreography — the FLIP driver: every tile animates from where it
 *    visually was to where it belongs. Poses: "natural" (the grid), "parked"
 *    (off the nearest edge, faded), "intro" (the host zooms to a centred
 *    spotlight over the others, which stay put).
 *  - useTilesEnter — the tiles move in from the sides before kickoff, each
 *    column from its own edge, one slot after another.
 *  - the VERDICT GESTURE: useTileTap reads the tap. There is no swipe. The
 *    tile in ./tile/ draws the turn itself.
 *  - the AUTO-REJECT WINDOW: autoRejectCue reads the session's stage clock.
 *  - the GESTURE LESSON: on the tutorial turn useTeachSignal bumps once, and
 *    every votable tile presses in and back out.
 *  - the REWARD BURST: useRewardCue turns the peers who have accepted you
 *    into the beat's waves — one wave per new accepter, several accepters at
 *    once cascading a step apart, and the gold finale on the one who
 *    completes the set. The particles live in lib/reward-burst.ts and the
 *    canvas host is reward-burst.tsx.
 *  - the ROUND CHROME: turnPill places one pill per turn across the whole
 *    game, chromeDuckStyle drops the bar out of sight on the grid's own
 *    curve, and introHeadlineStyle brackets the intro hero with its two
 *    headlines, which fade in place.
 *  - the HINT PILLS: hintAnchors turns one grid measurement into the three
 *    lengths a pill needs, hintBoxStyle slides it in over the grid's top
 *    edge, and useHintCue runs the tutorial's three-pill sequence.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { SESSION_TICK_MS } from "@/lib/game-clock"
import { prefersReducedMotion } from "@/lib/reduced-motion"
import { FULL_PARTICLE_COUNT, REWARD_STEP_MS, waveRange } from "@/lib/reward-burst"

// ── tuning ──────────────────────────────────────────────────────────────────
// change here, everything follows.

/** grid reorder / park / spotlight travel — the transform half of the
 *  layout transition */
export const LAYOUT_MS = 520
/** park fade in/out — the opacity half of the same transition */
export const LAYOUT_FADE_MS = 380
/** the layout ease — slow start, long glide */
export const LAYOUT_EASE = "cubic-bezier(0.32, 0.72, 0, 1)"
/** the intro hero is the TILE, grown — never a fraction of the stage. The
 *  183px slot becomes a 300px hero, so a narrower screen shrinks both
 *  together. */
const HERO_SCALE = 1.639
/** full mode: the move into and out of the host intro. The other tiles step
 *  back to INTRO_BEHIND_SCALE about their centres, every one on the same ease. */
const INTRO_MS = 720
const INTRO_EASE = "cubic-bezier(0.45, 0, 0.15, 1)"
const INTRO_BEHIND_SCALE = 0.92
/** what the intro headlines assume before a tile has been measured */
const HERO_FALLBACK_PX = 300
/** the choreography publishes the measured hero here, as a CSS length, so the
 *  headlines can bracket it without measuring anything themselves */
const HERO_SIZE_VAR = "--game-hero"
/** parked tiles clear the stage by at least this many px */
export const PARK_MIN_PX = 240
/** THE MOVE-IN: how far off its side a tile starts, how long it travels, and
 *  the step between two slots. A group of six lands at 1060ms, inside the 2s. */
const TILES_ENTER_TRAVEL_PX = 460
const TILES_ENTER_MS = 760
const TILES_ENTER_STAGGER_MS = 60
/** the grid fades in under the slide */
const TILES_ENTER_FADE_MS = 480
const TILES_ENTER_FADE_EASE = "cubic-bezier(0.4, 0, 0.2, 1)"

export type GridPose = "natural" | "parked" | "intro"


// ── the FLIP driver ─────────────────────────────────────────────────────────

/**
 * The grid choreography. React has already reordered the DOM when the
 * layout effect runs, so the "before" positions are the target rects stored
 * on the previous run; each tile then transitions from that pose to this
 * render's pose. Tiles are the children of `gridRef` carrying `data-id`.
 */
export function useGridChoreography({
  stageRef,
  gridRef,
  orderKey,
  pose,
  hostId,
  lowPower,
}: {
  /** the area the spotlight centres in (usually the <main>) */
  stageRef: RefObject<HTMLElement | null>
  /** the grid whose [data-id] children move */
  gridRef: RefObject<HTMLElement | null>
  /** the display order, joined — changes drive reorder slides */
  orderKey: string
  pose: GridPose
  /** data-id of the spotlit tile during "intro" */
  hostId: string
  /** true: the hero keeps the grid size and only moves to the centre, the
   *  others do not step back, and every move takes the layout timing */
  lowPower: boolean
}) {
  const posRef = useRef<Map<string, DOMRect>>(new Map())
  const opaRef = useRef<Map<string, number>>(new Map())
  const poseRef = useRef<GridPose | null>(null)
  // the spotlit tile of the last intro, and until when (performance.now())
  // it stays raised: for good while the intro holds, its flight home once it ends
  const heroRef = useRef<{ id: string; until: number } | null>(null)

  useLayoutEffect(() => {
    const grid = gridRef.current
    const stageEl = stageRef.current
    if (!grid || !stageEl) return
    const reduceMotion = prefersReducedMotion()
    const tiles = [...grid.querySelectorAll<HTMLElement>("[data-id]")]

    // Reset to the natural layout and measure THIS order's resting slots.
    for (const el of tiles) {
      el.style.transition = "none"
      el.style.transform = ""
      el.style.zIndex = ""
    }
    void grid.offsetWidth // flush the reset before measuring
    const natural = new Map<string, DOMRect>()
    for (const el of tiles) natural.set(el.dataset.id ?? "", el.getBoundingClientRect())
    const stage = stageEl.getBoundingClientRect()

    // the hero is one tile at HERO_SCALE, clamped to the stage it lands in,
    // or the tile at grid size without the zoom. Publishing it lets the intro headlines sit a fixed gap off its edges.
    const hostRect = natural.get(hostId) ?? [...natural.values()][0]
    const tileWidth = hostRect?.width ?? 0
    const spotSize = lowPower ? tileWidth : Math.min(tileWidth * HERO_SCALE, stage.width, stage.height)
    stageEl.style.setProperty(HERO_SIZE_VAR, `${spotSize}px`)

    // the hint pills hang off the HOST tile's top edge and centre (the
    // top-left in play, lib/grid-layout turnLayout), and they leave through
    // the frame's top edge.
    // All three are layout facts only this effect holds, so it publishes them
    // the same way.
    const gridRect = grid.getBoundingClientRect()
    for (const [name, value] of Object.entries(
      hintAnchors({
        stageTop: stage.top,
        hostTop: (hostRect?.top ?? gridRect.top) - stage.top,
        hostCenterX: hostRect ? hostRect.left + hostRect.width / 2 - stage.left : 0,
      }),
    ))
      stageEl.style.setProperty(name, value)
    const stageCx = stage.left + stage.width / 2
    const parkedOf = (nat: DOMRect): DOMRect => {
      const leftCol = nat.left + nat.width / 2 < stageCx
      const dx = Math.max(PARK_MIN_PX, nat.width + 24) * (leftCol ? -1 : 1)
      return new DOMRect(nat.left + dx, nat.top, nat.width, nat.height)
    }
    const targetOf = (id: string, nat: DOMRect): { rect: DOMRect; opa: number } => {
      if (pose === "parked") return { rect: parkedOf(nat), opa: 0 }
      if (pose === "intro") {
        if (id === hostId)
          return {
            rect: new DOMRect(
              stage.left + (stage.width - spotSize) / 2,
              stage.top + (stage.height - spotSize) / 2,
              spotSize,
              spotSize,
            ),
            opa: 1,
          }
        // the others stay in their slots under the hero (sliding them off cost
        // most of the frame). In full mode they step back about their centres.
        if (lowPower) return { rect: nat, opa: 1 }
        const w = nat.width * INTRO_BEHIND_SCALE
        const h = nat.height * INTRO_BEHIND_SCALE
        return {
          rect: new DOMRect(nat.left + (nat.width - w) / 2, nat.top + (nat.height - h) / 2, w, h),
          opa: 1,
        }
      }
      return { rect: nat, opa: 1 }
    }

    // centre-origin transform mapping a tile from its natural slot onto R.
    // Without the zoom a unit scale is left out, so a live video only moves.
    const toT = (nat: DOMRect, R: DOMRect): string => {
      if (
        Math.abs(R.left - nat.left) < 0.5 &&
        Math.abs(R.top - nat.top) < 0.5 &&
        Math.abs(R.width - nat.width) < 0.5
      )
        return ""
      const k = R.width / nat.width
      const move = `translate(${R.left + R.width / 2 - (nat.left + nat.width / 2)}px, ${R.top + R.height / 2 - (nat.top + nat.height / 2)}px)`
      return !lowPower || k !== 1 ? `${move} scale(${k})` : move
    }

    // THE HERO LANDS OVER THE SCRIM. The reset above drops every tile back
    // to its own layer, but the scrim takes LAYOUT_FADE_MS to clear and the
    // hero its move out of the intro (INTRO_MS, LAYOUT_MS in low power, as
    // below) to fly home: dropped at once, the host's big tile went dark and
    // under its neighbours the instant the intro ended, a flash. It stays
    // raised until it has landed.
    const at = performance.now()
    if (pose === "intro") heroRef.current = { id: hostId, until: Infinity }
    else if (heroRef.current?.until === Infinity) heroRef.current.until = at + (lowPower ? LAYOUT_MS : INTRO_MS)
    const landing = pose !== "intro" && heroRef.current && at < heroRef.current.until ? heroRef.current : null

    // First = previous target pose; Last = this render's pose.
    const nextPos = new Map<string, DOMRect>()
    const nextOpa = new Map<string, number>()
    for (const el of tiles) {
      const id = el.dataset.id ?? ""
      const nat = natural.get(id)
      if (!nat) continue
      const { rect: to, opa } = targetOf(id, nat)
      nextPos.set(id, to)
      nextOpa.set(id, opa)
      // over the scrim (32) and over a turning tile (30)
      if ((pose === "intro" && id === hostId) || (id === landing?.id && !reduceMotion)) el.style.zIndex = "35"
      const from = posRef.current.get(id)
      el.style.transform = from ? toT(nat, from) : toT(nat, to) // no First on mount → snap
      el.style.opacity = String(from ? (opaRef.current.get(id) ?? 1) : opa)
    }
    // full mode: a move into or out of the intro takes the intro timing
    const was = poseRef.current
    const introMove = !lowPower && was !== null && (was === "intro") !== (pose === "intro")
    const [moveMs, moveEase] = introMove ? [INTRO_MS, INTRO_EASE] : [LAYOUT_MS, LAYOUT_EASE]
    // Commit "from" with a forced reflow, then apply "to" synchronously so the
    // transition fires even if the tab is backgrounded (rAF pauses there).
    void grid.offsetWidth
    tiles.forEach((el) => {
      const id = el.dataset.id ?? ""
      const nat = natural.get(id)
      const to = nextPos.get(id)
      if (!nat || !to) return
      el.style.transition = reduceMotion
        ? "none"
        : `transform ${moveMs}ms ${moveEase}, opacity ${LAYOUT_FADE_MS}ms ease-out`
      el.style.transform = toT(nat, to)
      el.style.opacity = String(nextOpa.get(id) ?? 1)
    })

    posRef.current = nextPos
    opaRef.current = nextOpa
    poseRef.current = pose

    // a run before the landing is over resets the layers itself, and raises
    // the hero again for what is left of it
    const landed = landing === null ? undefined : setTimeout(() => {
      const hero = tiles.find((el) => el.dataset.id === landing.id)
      if (hero) hero.style.zIndex = ""
    }, landing.until - at)
    return () => clearTimeout(landed)
  }, [gridRef, stageRef, orderKey, pose, hostId, lowPower])
}

/**
 * THE MOVE-IN, on the clock: from `startAt` (unix seconds, device clock) the
 * left column slides in from the left edge and the right column from the
 * right, one slot after another, over a fade of the whole grid. A mount after
 * `startAt` joins the move-in where the clock has it. The animations run over
 * the FLIP driver's inline transforms and leave nothing behind.
 */
export function useTilesEnter(gridRef: RefObject<HTMLElement | null>, startAt: number | null) {
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (startAt === null || !grid || prefersReducedMotion()) return
    const since = Date.now() - startAt * 1000
    const slots = [...grid.querySelectorAll<HTMLElement>("[data-id]")]
    const runs = slots.map((el, index) => {
      const dx = index % 2 === 0 ? -TILES_ENTER_TRAVEL_PX : TILES_ENTER_TRAVEL_PX
      return el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
        duration: TILES_ENTER_MS,
        delay: index * TILES_ENTER_STAGGER_MS - since,
        easing: LAYOUT_EASE,
        fill: "backwards",
      })
    })
    runs.push(
      grid.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: TILES_ENTER_FADE_MS,
        delay: -since,
        easing: TILES_ENTER_FADE_EASE,
        fill: "backwards",
      }),
    )
    return () => runs.forEach((run) => run.cancel())
  }, [gridRef, startAt])
}


// ── the tile ────────────────────────────────────────────────────────────────

/** the tile's outside corner radius */
export const TILE_RADIUS_PX = 12

// ── the verdict gesture ─────────────────────────────────────────────────────
// A tap toggles the verdict. There is no swipe. The tile turns when the
// session hands the verdict back.

/** a finger that moves more than this many px is not a tap */
const TAP_SLOP_PX = 8
/** live media-query state, so a style builder can answer without touching the DOM */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const apply = () => setReduce(query.matches)
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])
  return reduce
}

/**
 * The gesture: a tap, and nothing else. A press counts as a tap only when the
 * same pointer lifts within TAP_SLOP_PX of where it went down. A press that
 * moves (a scroll, a stray swipe) or that the browser cancels reports nothing.
 * The tile reads `enabled` at the press and again at the lift, so a tap never
 * lands after the tile closed.
 *
 * The listeners live on `window`, so a finger that leaves the tile still ends
 * its press. The tile does not move under the finger.
 */
export function useTileTap({ enabled, onTap }: { enabled: boolean; onTap: () => void }): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
} {
  const live = useRef({ enabled, onTap })
  useEffect(() => {
    live.current = { enabled, onTap }
  }, [enabled, onTap])
  // the listeners of the press that runs now, so an unmount can drop them
  const release = useRef<(() => void) | null>(null)
  useEffect(() => () => release.current?.(), [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!live.current.enabled || !event.isPrimary || event.button !== 0) return
    event.preventDefault() // no text selection and no native image drag
    release.current?.()
    const { pointerId, clientX: startX, clientY: startY } = event

    const end = (tapped: boolean) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      release.current = null
      if (tapped && live.current.enabled) live.current.onTap()
    }
    const far = (e: PointerEvent) =>
      Math.abs(e.clientX - startX) > TAP_SLOP_PX || Math.abs(e.clientY - startY) > TAP_SLOP_PX
    const move = (e: PointerEvent) => {
      if (e.pointerId === pointerId && far(e)) end(false)
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId === pointerId) end(!far(e))
    }
    // iOS Safari sends pointercancel when it takes the touch for a scroll
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) end(false)
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    release.current = () => end(false)
  }, [])

  return { onPointerDown }
}


// ── the auto-reject warning ─────────────────────────────────────────────────
// The warning for the turn's own deadline, over the LAST SECONDS of the
// gameplay stage. It commits nothing: the session's sealTurn auto-rejects
// every undecided member at the turn change, and this is the warning for it.

/** the warning runs over the last this many seconds of the gameplay stage */
const AUTO_REJECT_LEAD_SEC = 4

/** the warning window, as the tiles need it */
export interface AutoRejectCue {
  /** is the window open right now? */
  active: boolean
  /** seconds left in the gameplay stage, in ms, as of the session's last tick */
  remainingMs: number
  /** the window's own length — AUTO_REJECT_LEAD_SEC, or the stage when it is
   *  shorter */
  leadMs: number
}

/**
 * The window, from the session's stage clock. NEVER an absolute delay measured
 * from the start of the stage: the app can enter a stage part-way through, so
 * only the REMAINING time is a stable anchor. A stage shorter than the lead
 * clamps the window to itself.
 */
export function autoRejectCue({
  stage,
  stageDuration,
  stageRemaining,
}: {
  /** the turn's stage — the same union the state machine's snapshot carries */
  stage: "introduction" | "gameplay" | "ending" | null
  stageDuration: number
  stageRemaining: number
}): AutoRejectCue {
  if (stage !== "gameplay") return { active: false, remainingMs: 0, leadMs: AUTO_REJECT_LEAD_SEC * 1000 }
  const leadMs = Math.min(AUTO_REJECT_LEAD_SEC, Math.max(0, stageDuration)) * 1000
  const remainingMs = Math.max(0, stageRemaining) * 1000
  return { active: remainingMs <= leadMs, remainingMs, leadMs }
}


// ── the gesture lesson ──────────────────────────────────────────────────────
// On the tutorial turn every votable tile presses in once, so the words and
// the motion arrive as one cue. It commits nothing.

/**
 * The lesson's trigger. It rises ONCE per arming, so no re-render can replay
 * a run: the number moves on the rising edge alone.
 */
export function useTeachSignal({ armed }: { armed: boolean }): number {
  const [signal, setSignal] = useState(0)
  const wasArmed = useRef(false)

  useEffect(() => {
    const rising = armed && !wasArmed.current
    wasArmed.current = armed
    if (rising) setSignal((n) => n + 1)
  }, [armed])

  return signal
}


// ── the reward burst ────────────────────────────────────────────────────────
// Your own tile answers the peers who accept you: one wave of confetti per
// new accepter, building to the gold finale on the accepter who completes the
// set. The engine, the palette and the beat's numbers are framework-free and
// live in lib/reward-burst.ts; this hook owns the MAPPING from accepters to
// waves alone.

/** what the canvas host needs: an id that rises per wave, and its prefix */
export interface RewardCue {
  /** monotonic — a change is what fires a wave. 0 means "never fired". */
  burst: number
  /** the layout's [start, end) particles this wave adds */
  start: number
  end: number
}

/**
 * The beat's mapping: the Nth peer who accepts you fires the Nth wave, and the
 * accepter who COMPLETES the set fires the finale — the whole rest of the
 * layout, in the finale's gold. The count is the whole signal: nothing here
 * asks what time it is, and the one timer paces a cascade the count asked for.
 *
 * The finale is the end of the set (`reachable`), not a fixed fifth
 * accepter: a vacant slot or a short group leaves fewer than five peers, and
 * a finale nailed to the fifth would never fire. A full group's five is the
 * ladder's last wave anyway.
 *
 * Four rules:
 *
 *  - A RISE fires. A FALL fires nothing: waves already spent stay spent, so a
 *    peer who takes their accept back and casts it again buys no second wave.
 *  - A JUMP of more than one CASCADES, one wave per accepter, `REWARD_STEP_MS`
 *    apart. Several accepts can land in one render (a channel that opens with
 *    a queue behind it), and one spawn of the whole prefix would paint every
 *    particle gold; paced, each wave keeps its own range.
 *  - EVERY WAVE STARTS WHERE THE LAST ONE STOPPED, tracked in particles: the
 *    finale takes everything left, so a rise after it fires nothing. The
 *    boundary moves when a wave is QUEUED, so an accepter arriving
 *    mid-cascade lands behind the waves already waiting.
 *  - ZERO resets: acceptance is filed per turn, so a new turn opens at nothing
 *    (or, on a round's first turn, at the accepts cast before it opened), and
 *    the waves still waiting are dropped with it.
 */
export function useRewardCue({
  accepted,
  reachable,
}: {
  /** how many of this round's players have accepted you on this turn */
  accepted: number
  /** how many of them CAN — the round's players, yourself excluded */
  reachable: number
}): RewardCue {
  const [cue, setCue] = useState<RewardCue>({ burst: 0, start: 0, end: 0 })
  // the accepters already answered, as a high-water mark. A ref, not state: it
  // is what the next rise is measured against, never anything the frame draws.
  const spentRef = useRef(0)
  // how far into the layout the burst has already spawned, in particles
  const firedRef = useRef(0)
  // the waves waiting for their step, oldest first
  const queueRef = useRef<Array<{ start: number; end: number }>>([])
  // the cadence's ONE timer, alive only while there is a queue to pace
  const stepRef = useRef<ReturnType<typeof setInterval>>(undefined)

  // The cascade's pacing. The head fires at once and the rest follow a step
  // apart, and the FIRST EMPTY STEP stops the timer — so a wave queued just
  // behind a run still waits its step, and one arriving long after the run is
  // over answers immediately.
  const cascade = useCallback(() => {
    const step = () => {
      const wave = queueRef.current.shift()
      if (!wave) {
        clearInterval(stepRef.current)
        stepRef.current = undefined
        return
      }
      setCue((prev) => ({ burst: prev.burst + 1, start: wave.start, end: wave.end }))
    }
    step()
    stepRef.current = setInterval(step, REWARD_STEP_MS)
  }, [])

  // back to nothing fired. The marks, the queue and the timer are ONE piece of
  // memory: a wave outliving the count that asked for it would spawn a range
  // the next turn has not earned.
  const reset = useCallback(() => {
    clearInterval(stepRef.current)
    stepRef.current = undefined
    queueRef.current = []
    spentRef.current = 0
    firedRef.current = 0
  }, [])

  useEffect(() => {
    if (accepted <= 0) {
      reset()
      return
    }
    if (accepted <= spentRef.current) return
    // one wave per NEW accepter. The waves are 0-based, so accepter N is wave
    // N-1, and the accepter who completes the set carries the layout to its
    // END instead — reaching the last particle is what makes the engine draw
    // that spawn as the finale.
    for (let nth = spentRef.current + 1; nth <= accepted; nth++) {
      const complete = reachable > 0 && nth >= reachable
      const start = firedRef.current
      const end = complete ? FULL_PARTICLE_COUNT : waveRange(nth - 1).end
      if (end <= start) continue
      firedRef.current = end
      queueRef.current.push({ start, end })
    }
    spentRef.current = accepted
    // a cascade already in flight paces the new waves itself
    if (stepRef.current === undefined) cascade()
  }, [accepted, reachable, cascade, reset])

  // a mount owns the whole ladder, so leaving takes the pending waves and both
  // marks with it — a remount reads the count it finds instead of measuring it
  // against a mark from the mount before
  useEffect(() => reset, [reset])

  return cue
}


// ── the round chrome ────────────────────────────────────────────────────────
// The bottom bar and the two intro headlines. The bar is ONE PILL PER TURN
// across the whole game, and it rides the grid: it drops out of sight while
// the host is in the spotlight and over the gap between rounds, on the grid's
// own curve.

/** a pill's box */
export const PILL_W_PX = 16
export const PILL_H_PX = 56
export const PILL_RADIUS_PX = 8
/** the fallback fill window, for a cue that carries no turn length: the fill
 *  eases over ONE session tick, linearly, so the ticks read as a rise. A
 *  longer window never reaches its target before the next tick restarts it,
 *  so the fill would trail. A cue WITH `turnSec` does not use this — it hands
 *  the whole remaining turn to one CSS transition instead (round-counter). */
export const PILL_FILL_MS = SESSION_TICK_MS
/** the bar rests this far over the frame's bottom edge */
export const PILL_BAR_BOTTOM_PX = 40
/** the rotation countdown's line rests this far over the frame's bottom edge
 *  (its top at 767 on an 844 px frame) */
export const ROTATION_LINE_BOTTOM_PX = 53
/** the intro pose and the round gap push the chrome this far down */
const CHROME_DUCK_PX = 160

/** what the bar needs to know: where the game is, and how far into the turn.
 *  The turn count is per round, because the own group can differ per round —
 *  a player's stripe can land in a shorter group next round. */
export interface TurnCue {
  /** turns per round, one entry per round, in game order */
  turnsPerRound: readonly number[]
  /** the current round, 0-based */
  round: number
  /** the current turn inside its round, 0-based */
  turn: number
  /** 0..1 through the current turn */
  progress: number
  /** the turn's whole length in seconds. The live clock only steps in whole
   *  seconds, so a fill driven by `progress` alone climbs in stairs. With
   *  this length the pill takes ONE reading per turn and lets a single CSS
   *  transition carry the rest, which reads as one continuous rise. Omit it
   *  and the pill falls back to a `PILL_FILL_MS` step per cue. */
  turnSec?: number
}

/** how many pills the game has: the sum over the rounds — never a literal,
 *  and never `rounds × size`. */
export function turnPillCount(cue: TurnCue): number {
  return Math.max(1, cue.turnsPerRound.reduce((sum, turns) => sum + Math.max(0, turns), 0))
}

/** which pill the game is on, 0-based: every turn of the rounds before this
 *  one, plus the turn inside it */
export function turnPillIndex(cue: TurnCue): number {
  const round = Math.max(0, cue.round)
  const before = cue.turnsPerRound
    .slice(0, round)
    .reduce((sum, turns) => sum + Math.max(0, turns), 0)
  const at = before + Math.max(0, cue.turn)
  return Math.min(turnPillCount(cue) - 1, at)
}

export type PillState = "past" | "current" | "future"

/** what one pill shows. A past turn holds full and never animates, the
 *  current one rises from the bottom, a future one sits empty. */
export function turnPill(index: number, cue: TurnCue): { state: PillState; fill: number } {
  const at = turnPillIndex(cue)
  if (index < at) return { state: "past", fill: 1 }
  if (index > at) return { state: "future", fill: 0 }
  return { state: "current", fill: Math.min(1, Math.max(0, cue.progress)) }
}

/** the chrome's duck. Same curve and window as the grid's round-gap park
 *  (LAYOUT_MS, LAYOUT_EASE), so the bar leaves in lock-step with the tiles
 *  clearing sideways. (Into and out of the intro the tiles move on INTRO_MS
 *  and INTRO_EASE instead.) */
export function chromeDuckStyle(ducked: boolean): CSSProperties {
  return {
    transform: ducked ? `translateY(${CHROME_DUCK_PX}px)` : "translateY(0)",
    transition: `transform ${LAYOUT_MS}ms ${LAYOUT_EASE}`,
  }
}

/** the intro headlines: Manrope 700 at this size, one above the hero and one
 *  below it */
export const INTRO_HEADLINE_PX = 40
export const INTRO_HEADLINE_TRACKING = "-0.01em"
/** the gap between a headline and the hero's edge (196 → 268 and 568 → 600
 *  on an 844 frame) */
const INTRO_HEADLINE_GAP_PX = 32
/** the headlines fade in place, in and out */
const INTRO_HEADLINE_FADE = "opacity 200ms ease-out"
/** the two drop shadows — the only color the headlines carry, so they live
 *  here and never in the component */
export const INTRO_SHADOW_ABOVE = "0 3px 6px rgba(0,0,0,0.55)"
const INTRO_SHADOW_BELOW = "0 3px 8px rgba(0,0,0,0.6)"

/**
 * One intro headline, placed against the hero the choreography measured. The
 * hero is centred in the stage, so "above" anchors its BOTTOM edge a gap over
 * the hero's top and "below" anchors its TOP edge a gap under the bottom.
 */
export function introHeadlineStyle(place: "above" | "below", showing: boolean, shadow: boolean): CSSProperties {
  const off = `calc(50% + var(${HERO_SIZE_VAR}, ${HERO_FALLBACK_PX}px) / 2 + ${INTRO_HEADLINE_GAP_PX}px)`
  const above = place === "above"
  return {
    bottom: above ? off : undefined,
    top: above ? undefined : off,
    fontFamily: "var(--font-heading)",
    fontWeight: 700,
    fontSize: INTRO_HEADLINE_PX,
    letterSpacing: INTRO_HEADLINE_TRACKING,
    textShadow: !shadow ? undefined : above ? INTRO_SHADOW_ABOVE : INTRO_SHADOW_BELOW,
    opacity: showing ? 1 : 0,
    transition: INTRO_HEADLINE_FADE,
  }
}

// ── the hint pills ──────────────────────────────────────────────────────────
// The tutorial's three pills and the missing-host pill. One white pill shape,
// four uses:
//
//   "Show gesture"          — anchored over the HOST tile, with a tail
//   "Tap to Identify Humans" — centred, no tail
//   "No tap means it's a bot" — centred, no tail
//   "No host - copy other players" — centred, with the white glow
//
// Every pill rests just above the grid's top edge and leaves through the
// FRAME's top edge, so the four read as one family. The grid's top, the host
// tile's centre and the travel to the frame edge are layout facts, so
// useGridChoreography measures them once and publishes them as the three
// custom properties below. A pill's style is then pure CSS arithmetic.

/** the pill's box */
export const HINT_PILL_H_PX = 48
export const HINT_PILL_RADIUS_PX = 32
export const HINT_PILL_FONT_PX = 16
export const HINT_PILL_LINE_PX = 20
/** the anchored "Show gesture" pill has a fixed width — the tail must sit
 *  under its middle */
const HINT_ANCHORED_W_PX = 176
/** the rounded triangle under the anchored pill */
const HINT_TAIL_W_PX = 28
const HINT_TAIL_H_PX = 22
/** the tail tucks this far under the pill so the join reads as one shape */
const HINT_TAIL_OVERLAP_PX = 4
/** pill plus tail — the whole travelling box */
const HINT_BOX_H_PX = HINT_PILL_H_PX + HINT_TAIL_H_PX
/** the box's bottom sits this far BELOW the host tile's top edge, so the
 *  tail's apex bites into the host tile instead of floating over it */
const HINT_TAIL_BITE_PX = 9
/** a pill never comes closer than this to the stage's side edge */
const HINT_EDGE_PX = 8
/** nor closer than this to the FRAME's top edge. A short screen centres the
 *  grid higher than a whole box fits above it, and a pill that rests off the
 *  frame is no cue at all — so the box holds here and the tail bites deeper */
const HINT_MIN_TOP_PX = 12
/** the lift and the glow — the only colors a pill carries, so
 *  they live here and never in the component */
const HINT_SHADOW = "drop-shadow(0 6px 14px rgba(0, 0, 0, 0.32))"
const HINT_GLOW = "drop-shadow(0 0 18px rgba(255, 255, 255, 0.45))"

/** where the box rests, as a stage-relative length */
const HINT_TOP_VAR = "--game-hint-top"
/** how far up the box travels to clear the frame's top edge */
const HINT_LIFT_VAR = "--game-hint-lift"
/** the host tile's centre, as a stage-relative length */
const HOST_CX_VAR = "--game-host-cx"
/** what a pill assumes before a tile has been measured (390 × 844) */
const HINT_TOP_FALLBACK_PX = 62
const HINT_LIFT_FALLBACK_PX = 132
const HOST_CX_FALLBACK_PX = 99.5

/**
 * The three lengths a pill needs, from the one measurement the choreography
 * already takes. `hostTop` and `hostCenterX` are stage-relative, `stageTop` is
 * the stage's own distance from the frame's top edge. A host below the top
 * row has its pill over the tile above it, the tail still in the host.
 */
function hintAnchors({
  stageTop,
  hostTop,
  hostCenterX,
}: {
  stageTop: number
  hostTop: number
  hostCenterX: number
}): Record<string, string> {
  const rest = hostTop + HINT_TAIL_BITE_PX - HINT_BOX_H_PX
  const top = Math.max(rest, HINT_MIN_TOP_PX - stageTop)
  return {
    [HINT_TOP_VAR]: `${top}px`,
    [HINT_LIFT_VAR]: `${Math.max(0, stageTop + top + HINT_BOX_H_PX)}px`,
    [HOST_CX_VAR]: `${hostCenterX}px`,
  }
}

/** the entrance and exit: in with a soft overshoot, out pulled
 *  straight up */
function hintTransition(visible: boolean): string {
  return visible
    ? "transform 460ms cubic-bezier(0.18, 0.9, 0.3, 1.08), opacity 240ms ease-out"
    : "transform 360ms cubic-bezier(0.5, 0, 0.75, 0), opacity 220ms ease-in 80ms"
}

/**
 * The travelling box. It rests over the host tile's top edge and hides a
 * full frame-height above it, so the slide really enters through the frame's
 * top edge. Reduced motion keeps the fade and drops the travel.
 */
export function hintBoxStyle({
  visible,
  glow,
  shadow,
  reduced,
}: {
  visible: boolean
  glow: boolean
  /** false: no lift and no glow, so the box paints no filter */
  shadow: boolean
  reduced: boolean
}): CSSProperties {
  const away = `translateY(calc(-1 * var(${HINT_LIFT_VAR}, ${HINT_LIFT_FALLBACK_PX}px)))`
  return {
    top: `var(${HINT_TOP_VAR}, ${HINT_TOP_FALLBACK_PX}px)`,
    height: HINT_BOX_H_PX,
    transform: visible || reduced ? "translateY(0)" : away,
    opacity: visible ? 1 : 0,
    transition: reduced ? "opacity 200ms ease-out" : hintTransition(visible),
    filter: !shadow ? undefined : glow ? `${HINT_GLOW} ${HINT_SHADOW}` : HINT_SHADOW,
    willChange: "transform, opacity",
  }
}

/** the anchored pill: centred over the host tile, held off the stage edge */
export function hintAnchoredPillStyle(): CSSProperties {
  return {
    left: `max(${HINT_EDGE_PX}px, calc(var(${HOST_CX_VAR}, ${HOST_CX_FALLBACK_PX}px) - ${HINT_ANCHORED_W_PX / 2}px))`,
    width: HINT_ANCHORED_W_PX,
    height: HINT_PILL_H_PX,
  }
}

/** the tail: under the pill, aimed at the host tile whatever the pill did to
 *  stay on screen */
export function hintTailStyle(): CSSProperties {
  return {
    left: `calc(var(${HOST_CX_VAR}, ${HOST_CX_FALLBACK_PX}px) - ${HINT_TAIL_W_PX / 2}px)`,
    top: HINT_PILL_H_PX - HINT_TAIL_OVERLAP_PX,
    width: HINT_TAIL_W_PX,
    height: HINT_TAIL_H_PX,
    transform: "rotate(180deg)",
  }
}

// ── the hint sequence ───────────────────────────────────────────────────────

/** which pill is on screen */
export type HintKind = "show-gesture" | "tap-to-identify" | "no-tap-bot" | "no-host"

/** one frame of hidden pose before the slide, so the transition has a "from" */
const HINT_ARM_MS = 48
/** the tutorial's pills, in ms from the run start. The pills NEVER share the
 *  screen: each 360ms exit ends before the next pill slides in. */
const HINT_GESTURE_OUT_MS = 1600
const HINT_TAP_IN_MS = 2000
const HINT_TAP_OUT_MS = 3640
const HINT_NO_TAP_IN_MS = 4000
/** how long the missing-host pill holds each time the grid settles */
const NO_HOST_HINT_MS = 5000

/**
 * The hint state machine. Two runs, and a pill changes on a timer or on a tap —
 * the run is keyed by its trigger, so a run that stops (the host returns, the
 * pose leaves the grid) clears the pill in the SAME render, with no state
 * write at all. Each settle of the grid starts a run again.
 *
 *   "no-host"  — the glowing pill for NO_HOST_HINT_MS
 *   "tutorial" — "show-gesture", then "tap-to-identify", then "no-tap-bot",
 *                which stays until the run ends or a tap hides it
 *
 * A tap hides the pill that shows (`dismiss`). The run's later timers still
 * fire. A missing host wins: the no-host pill is the only cue then.
 */
export function useHintCue({
  ready,
  hostMissing,
  firstTurn,
  turn = "",
}: {
  /** the grid is settled and the game is playing */
  ready: boolean
  /** the host's feed is not here — nobody to copy */
  hostMissing: boolean
  /** the game's very first turn, the one the tutorial belongs to */
  firstTurn: boolean
  /** the turn, so back-to-back no-host turns each show the pill */
  turn?: string
}): {
  /** the pill showing right now, or null */
  cue: HintKind | null
  /** hides the pill showing now; the run's later timers still fire */
  dismiss: () => void
} {
  const run = !ready ? "" : hostMissing ? `no-host|${turn}` : firstTurn ? "tutorial" : ""
  const [shown, setShown] = useState<{ run: string; kind: HintKind | null }>({
    run: "",
    kind: null,
  })

  useEffect(() => {
    if (run === "") return
    const at = (ms: number, kind: HintKind | null) =>
      setTimeout(() => setShown({ run, kind }), ms)
    const timers =
      run.startsWith("no-host")
        ? [at(HINT_ARM_MS, "no-host"), at(HINT_ARM_MS + NO_HOST_HINT_MS, null)]
        : [
            at(HINT_ARM_MS, "show-gesture"),
            at(HINT_GESTURE_OUT_MS, null),
            at(HINT_TAP_IN_MS, "tap-to-identify"),
            at(HINT_TAP_OUT_MS, null),
            at(HINT_NO_TAP_IN_MS, "no-tap-bot"),
          ]
    return () => {
      for (const timer of timers) clearTimeout(timer)
      // the last pill holds until the run ends: a later run must not start on it
      setShown({ run: "", kind: null })
    }
  }, [run])

  const dismiss = useCallback(() => setShown({ run, kind: null }), [run])

  return { cue: shown.run === run ? shown.kind : null, dismiss }
}
