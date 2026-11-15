// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { useLowPower } from "@/lib/low-power"
import { cn } from "@/lib/utils"
import { tileTapState } from "@/lib/tile-tap"
import { useTileTap, type AutoRejectCue } from "../animations"
import { TAP_FINGER_D } from "../hints"
import { GRAIN_DIM_HOST_MISSING, TvStatic } from "../tv-static"
import { AutoGlassMark, CardGlow, LowPowerMark, LowPowerWarn, lowPowerWash, warmMarks } from "./glass-mark"
import {
  BannedFace,
  EyeChip,
  FrontVerdictOverlay,
  REJECT_WASH,
  RotationVerdictFill,
  type TileVerdict,
} from "./tile-faces"
import {
  ACTIVE_Z,
  PERSPECTIVE_PX,
  POOL_GROW_ROLE_PX,
  POOL_GROW_VERDICT_PX,
  SLAB_DEPTH_PX,
  TILE_PX,
  keepInside,
  slotHue,
  slotSeeds,
  turnRoll,
  useTileRoom,
} from "./tile-geometry"
import { FlipGlint, HopGlow, LandingBurst, LowPowerRole, Slab, TileStroke, TileWave, TurnBloom, type RoleTone } from "./tile-layers"
import { TILT_SLAB_K, useTileCue } from "./use-tile-cue"
import { VideoSlot, useTileVideo } from "./tile-video"
import type { RemoteVideoObservation } from "@/lib/peer-video-observation"
import "./tile.css"

export type { TileVerdict }

export interface FinalTileProps {
  /** a stable number from the player id: the tile's clocks, its hue, its blob seeds */
  seed: number
  variant: "host" | "you" | "other" | "ghost"
  stream: MediaStream | null
  mirrored?: boolean
  /** the player's photo: the poster, and the hidden copies of the face when there is no stream */
  still?: string
  verdict?: TileVerdict
  /** false for the own tile and the host tile: they never turn */
  flippable: boolean
  /** the auto-reject warning window; only an undecided votable tile takes it */
  autoReject?: AutoRejectCue
  banned?: boolean
  onBan?: () => void
  onUnban?: () => void
  /** the gesture's verdict. The tile turns when the caller hands it back as `verdict`. */
  onVerdict?: (verdict: TileVerdict) => void
  /** a rejected card: its light and portrait ("glow"), or its photo under the portrait ("photo") */
  negativeFace?: "photo" | "glow"
  /** rises once per lesson: an undecided tile presses in once, lit green from below, under a tap */
  teach?: number
  /** the vote screen: the tile mounts at rest on its verdict, with no turn or landing, settles at REVIEW_SETTLE_SCALE, and frosts its photo faces */
  review?: boolean
  /** layers over the live face: the feed stand-ins, the connection states */
  children?: ReactNode
  /** decoded-frame evidence for one real remote attachment */
  observeRemote?: RemoteVideoObservation
}

// ── the turn ────────────────────────────────────────────────────────────
/** a card goes round for a reject, for a change of mind, and back, in this long */
const TURN_MS = 400
/** the turn's curve: a quick start, a long soft landing. tile.css repeats it for the glint and the gleam. */
const TURN_EASE = "cubic-bezier(0.22, 0.72, 0.18, 1)"
/** a tile that mounts with a verdict turns briskly: a zero-length turn left its layers rastered at the wrong scale */
const MOUNT_TURN_MS = 260
/** where TURN_EASE passes 90°: the faces swap here */
const FLIP_EDGE_ON_AT = 0.147
/** the landed tile stays raised this long: the settle, the waves, the sparks */
const LANDING_MS = 450
/** the tile pops out while it turns from pending, and settles deeper once it has landed */
const POP_SCALE = 1.2
/** a landed tile's resting scale, ≈0.758 (the product of successive tuning steps) */
const SETTLE_SCALE = 0.925 * 0.7 * 1.3 * 0.9
const REVIEW_SETTLE_SCALE = 0.95
/** a turn from a settled tile lifts it only this much over its settle */
const SETTLED_TURN_LIFT = 1.08
/** the settle slams: it overshoots into the grid and rebounds. The first approve pushes in on it too. */
const SLAM = "transform 260ms cubic-bezier(0.18, 0.89, 0.32, 1.28)"
const IDLE = "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)"
/** the cue layer eases back upright */
const LEAN_EASE = "transform 220ms ease-out"
/** the lesson's press: half of the way to the settle, in and back out, each way this long */
const PRESS_SCALE = 1 + 0.5 * (SETTLE_SCALE - 1)
const PRESS_MS = 1000
const PRESS_EASE = "cubic-bezier(0.45, 0, 0.55, 1)"
/** the press runs across the grid: each tile waits a little longer than the one before */
const PRESS_WAIT_MS = 20
const PRESS_STAGGER_MS = 55
/** the negative colour on this tile: a violet from the pool's own wheel, never a red */
const RIM_NEG = "#a98bff"
const RIM_NEG_RGB = "169,139,255"

type Face = "front" | "back"

/**
 * The turn state. The tile is a coin: the front holds the approve and the
 * back the reject. A first approve pushes in on the front with no turn, and a
 * reject turns ±180° (`rotY` is cumulative), so a change of mind is a pure turn.
 */
interface Turn {
  /** the verdict the faces hold. It lags the prop through a reset. */
  shown: TileVerdict | undefined
  rotY: number
  front: TileVerdict | null
  back: TileVerdict | null
  /** counts the turns; a landing and a card are keyed by it */
  key: number
  dir: 1 | -1
  ms: number
  flipping: boolean
  resetting: boolean
  /** the turn starts from a settled verdict: it lifts a little, not the full pop */
  fromSettled: boolean
}

const REST: Turn = {
  shown: undefined,
  rotY: 0,
  front: null,
  back: null,
  key: 0,
  dir: 1,
  ms: TURN_MS,
  flipping: false,
  resetting: false,
  fromSettled: false,
}
const dirOf = (v: TileVerdict): 1 | -1 => (v === "approve" ? 1 : -1)
const otherOf = (v: TileVerdict): TileVerdict => (v === "approve" ? "reject" : "approve")

/** the first commit from pending: the front stays bare until the turn has landed */
const commitFirst = (t: Turn, next: TileVerdict, ms: number): Turn => ({
  ...t,
  shown: next,
  rotY: 180 * dirOf(next),
  back: next,
  front: null,
  key: t.key + 1,
  dir: dirOf(next),
  ms,
  flipping: true,
  resetting: false,
  fromSettled: false,
})
/** the first approve from pending: no turn, the front takes it and the tile pushes in to its settle */
const pushTo = (t: Turn, next: TileVerdict): Turn => ({
  ...t,
  shown: next,
  rotY: 0,
  front: next,
  back: otherOf(next),
  key: t.key + 1,
  dir: dirOf(next),
  flipping: false,
  resetting: false,
  fromSettled: false,
})
/** a verdict with no turn: the front takes it at once and fades it in */
const commitFlat = (t: Turn, next: TileVerdict): Turn => ({
  ...t,
  shown: next,
  rotY: 0,
  front: next,
  back: null,
  key: t.key + 1,
  flipping: false,
  resetting: false,
})
/** a tile that mounts decided, at rest on the verdict's face: a later toggle is one half-turn */
const restOn = (v: TileVerdict): Turn => ({
  ...REST,
  shown: v,
  rotY: v === "approve" ? 0 : -180,
  front: "approve",
  back: "reject",
  key: 1,
  dir: dirOf(v),
})
/** a change of mind: one more half-turn. A front still bare takes the new verdict now. */
const flipTo = (t: Turn, next: TileVerdict): Turn => ({
  ...t,
  shown: next,
  rotY: t.rotY + 180 * dirOf(next),
  front: t.front ?? next,
  key: t.key + 1,
  dir: dirOf(next),
  ms: TURN_MS,
  flipping: true,
  fromSettled: true,
})
/** the reset turns the card back to its front, with no pop. Every light stands down as it starts. */
const startReset = (t: Turn): Turn => ({ ...t, rotY: 0, ms: TURN_MS, flipping: true, resetting: true })
const landReset = (t: Turn): Turn => ({ ...REST, key: t.key, dir: t.dir, ms: t.ms })

const MOUNT = "mount"


/**
 * Bake the glass marks and the eye disc on the clock screen, before there is a
 * grid: in play the bake (~150 ms of a phone's main thread) landed on the
 * spotlight's zoom. The one tint is a page variable.
 */
export function warmTileMarks() {
  if (typeof document !== "undefined") warmMarks(document.documentElement)
}

/**
 * One player tile. It draws at TILE_PX and scales to its cell. A tap
 * toggles — a pending or rejected tile approves, an approved one rejects. There
 * is no swipe. The tile reports the verdict through `onVerdict`, and turns
 * when the verdict comes back. It takes no tap while a turn runs.
 */
export function FinalTile(props: FinalTileProps) {
  const lowPower = useLowPower()
  const cellRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number | null>(null)
  useLayoutEffect(() => {
    const cell = cellRef.current
    if (!cell) return
    const measure = () => setScale(cell.clientWidth / TILE_PX)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(cell)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={cellRef} className="relative aspect-square w-full">
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: TILE_PX,
          height: TILE_PX,
          transform: `scale(${scale ?? 1})`,
          // no size before the first measure: nothing shows at the wrong scale
          visibility: scale === null ? "hidden" : undefined,
        }}
      >
        {props.variant === "ghost" ? (
          <GhostTile />
        ) : props.banned ? (
          <BannedFace onUndo={props.onUnban} blur={!lowPower} />
        ) : (
          // a fresh turn state when the mode changes, so no half-turned tile stays
          <TileBody key={String(lowPower)} {...props} lowPower={lowPower} />
        )}
      </div>
    </div>
  )
}

/** an empty seat: nobody holds the chair, so there is no face under the grain.
 *  Near-black static, the same as a seat we hear nothing from. */
function GhostTile() {
  return (
    <div className="tile-round absolute inset-0 bg-[var(--game-banned)]">
      <TvStatic dim={GRAIN_DIM_HOST_MISSING} />
    </div>
  )
}

function TileBody({
  seed,
  variant,
  stream,
  mirrored,
  still,
  verdict,
  flippable,
  autoReject,
  onBan,
  onVerdict,
  negativeFace = "glow",
  teach,
  review,
  children,
  observeRemote,
  lowPower,
}: FinalTileProps & { lowPower: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const committed = flippable ? verdict : undefined
  const takesGesture = flippable && onVerdict !== undefined

  // ── the controlled verdict: each change of the prop starts its own turn ──
  const [turn, setTurn] = useState<Turn>(() =>
    review && committed ? (lowPower ? commitFlat(REST, committed) : restOn(committed)) : REST,
  )
  const [seen, setSeen] = useState<TileVerdict | undefined | typeof MOUNT>(() =>
    review && committed ? committed : MOUNT,
  )
  const [landing, setLanding] = useState(0)
  // a tile that stops being votable (its player became host) goes home at once,
  // not spinning through the spotlight's zoom
  const [snapKey, setSnapKey] = useState(-1)
  if (seen !== committed) {
    setSeen(committed)
    if (committed === undefined) {
      if (seen !== MOUNT && !flippable) {
        setTurn((t) => landReset(t))
        setSnapKey(turn.key)
      } else if (seen !== MOUNT) setTurn(startReset)
    } else if (lowPower) setTurn((t) => commitFlat(t, committed))
    else if (seen !== MOUNT && seen !== undefined) setTurn((t) => flipTo(t, committed))
    else if (committed === "approve") {
      // a push has no turn to land: it lands at once
      setTurn((t) => pushTo(t, committed))
      setLanding((n) => n + 1)
    } else setTurn((t) => commitFirst(t, committed, seen === MOUNT ? MOUNT_TURN_MS : TURN_MS))
  }
  // the turn lands: the tile settles and the landing plays
  useEffect(() => {
    if (!turn.flipping || turn.resetting) return
    const key = turn.key
    const id = setTimeout(() => {
      setTurn((t) => (t.key === key ? { ...t, flipping: false } : t))
      setLanding((n) => n + 1)
    }, turn.ms)
    return () => clearTimeout(id)
  }, [turn.key, turn.ms, turn.flipping, turn.resetting])
  useEffect(() => {
    if (!landing) return
    const id = setTimeout(() => setLanding(0), LANDING_MS)
    return () => clearTimeout(id)
  }, [landing])
  // after a first commit, the front takes the other verdict once it is out of sight
  useEffect(() => {
    if (turn.front !== null || turn.back === null) return
    const id = setTimeout(
      () => setTurn((t) => (t.front === null && t.back !== null ? { ...t, front: otherOf(t.back) } : t)),
      turn.ms + 40,
    )
    return () => clearTimeout(id)
  }, [turn.key, turn.front, turn.back, turn.ms])
  useEffect(() => {
    if (!turn.resetting) return
    const id = setTimeout(() => setTurn(landReset), turn.ms + 40)
    return () => clearTimeout(id)
  }, [turn.resetting, turn.ms])

  // Which face's verdict content is RENDERED: iOS does not cull descendants
  // with a layer of their own, so only the showing face gets it. It switches
  // where the turn passes 90°; a turn home to 0° switches at once.
  const target: Face = Math.abs(Math.round(turn.rotY / 180)) % 2 ? "back" : "front"
  const [displayFace, setDisplayFace] = useState<Face>(target)
  useEffect(() => {
    if (target === displayFace) return
    const id = setTimeout(() => setDisplayFace(target), turn.rotY === 0 ? 0 : turn.ms * FLIP_EDGE_ON_AT)
    return () => clearTimeout(id)
  }, [target, displayFace, turn.rotY, turn.ms])
  const face: Face = turn.rotY === 0 ? "front" : displayFace
  const backShowing = face === "back"
  // The tile's one feed moves to the face the coin is turning to as it passes
  // edge-on, home to 0° as well: neither face shows at that instant.
  const video = useTileVideo(stream, mirrored, still, variant === "you", observeRemote)
  // gone home at once: the feed moves now
  const snapped = snapKey === turn.key
  useEffect(() => {
    if (snapKey < 0) return
    const id = setTimeout(() => setSnapKey(-1), 60)
    return () => clearTimeout(id)
  }, [snapKey])
  const [videoFace, setVideoFace] = useState<Face>(target)
  useEffect(() => {
    if (target === videoFace) return
    const id = setTimeout(() => setVideoFace(target), snapped ? 0 : turn.ms * FLIP_EDGE_ON_AT)
    return () => clearTimeout(id)
  }, [target, videoFace, turn.ms, snapped])
  const feed = stream ? video : null
  const videoOnBack = videoFace === "back" && turn.back !== null
  // the back holds the AI card (a rejected tile's glow face): it covers the feed
  const backCovered = turn.back === "reject" && negativeFace === "glow" && !lowPower && !turn.resetting

  // the marks are baked before anyone votes, not by the first turn
  useEffect(() => {
    if (flippable && rootRef.current) warmMarks(rootRef.current)
  }, [flippable])

  // ── the gesture ──
  // a tap toggles: a pending or rejected tile approves, an approved one rejects
  const toggle = useCallback(() => {
    onVerdict?.(committed === "approve" ? "reject" : "approve")
  }, [onVerdict, committed])
  // a running turn ignores the finger, so a tap never lands mid-flip
  const tap = tileTapState({ takesGesture, flipping: turn.flipping, resetting: turn.resetting })
  const gesture = useTileTap({ enabled: tap.ready, onTap: toggle })
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Wake the tile's compositing on the press, with a scale nobody can see:
    // at rest Chrome keeps it flattened, and the turn's first frame waited for
    // the promote. React rewrites the transform when its value changes.
    const root = rootRef.current
    if (root && !lowPower) root.style.transform = root.style.transform.replace(/scale\(1(?:\.0+)?\)/, "scale(1.0001)")
    gesture.onPointerDown(event)
  }

  // ── the lesson's press ──
  const pending = turn.shown === undefined
  const [press, setPress] = useState(0)
  const [seenTeach, setSeenTeach] = useState(teach)
  if (teach !== seenTeach) {
    setSeenTeach(teach)
    // read as the lesson arrives: a decided tile sits it out
    if (teach && flippable && pending && committed === undefined) setPress(teach)
  }
  // `pressing` spans the whole press (the light, the tap), `pressIn` its first leg
  const [pressing, setPressing] = useState(false)
  const [pressIn, setPressIn] = useState(false)
  useEffect(() => {
    if (!press) return
    const wait = PRESS_WAIT_MS + (Math.abs(Math.trunc(seed)) % 6) * PRESS_STAGGER_MS
    const timers = [
      setTimeout(() => {
        setPressing(true)
        setPressIn(true)
      }, wait),
      setTimeout(() => setPressIn(false), wait + PRESS_MS),
      setTimeout(() => {
        setPressing(false)
        setPress(0)
      }, wait + 2 * PRESS_MS),
    ]
    return () => timers.forEach(clearTimeout)
  }, [press, seed])
  // a verdict ends the lesson on this tile at once
  const pressed = pressing && pending

  // ── what the tile wears ──
  const resetting = turn.resetting
  const roleTone: RoleTone = variant === "host" ? "host" : variant === "you" ? "me" : ""
  const poolGrow = roleTone ? POOL_GROW_ROLE_PX : POOL_GROW_VERDICT_PX
  const { inCue } = useTileCue({
    rootRef,
    autoReject,
    eligible: flippable && committed === undefined && pending && !lowPower,
    seed,
    shown: turn.shown,
    resetting,
    roleLit: roleTone !== "",
  })
  // the wave: in the cue, and on a card the cue turned (a tap-reject has none)
  const [waved, setWaved] = useState(false)
  if (inCue && !waved) setWaved(true)
  else if (!inCue && pending && waved) setWaved(false)
  const wavy = inCue || (turn.shown === "reject" && waved && !resetting)
  // low power: the cue is CSS, mounted as the window opens with the part already
  // gone, and held until the verdict, as the full cue holds
  const warnable = lowPower && flippable && committed === undefined && pending
  const [warn, setWarn] = useState<{ leadMs: number; atMs: number } | null>(null)
  if (!warnable && warn) setWarn(null)
  else if (warnable && !warn && autoReject?.active && autoReject.remainingMs > 0)
    setWarn({ leadMs: autoReject.leadMs, atMs: autoReject.leadMs - autoReject.remainingMs })
  // low power: the rejected face's wash, one per tile and turn. The reject a
  // cue warns of lands on the next key, so the cue rolls the colors of that key.
  const washKey = pending ? turn.key + 1 : turn.key
  const lowWash = useMemo(
    () => (lowPower ? lowPowerWash(turnRoll(seed, washKey).seeds) : undefined),
    [lowPower, seed, washKey],
  )
  const lit = roleTone !== "" || (pending ? inCue : !resetting)
  // a rejected card rolls its own hue and blob seeds, once per turn
  const negative = turn.shown === "reject" && !resetting
  const roll = negative ? turnRoll(seed, turn.key) : null
  const coverHue = roll ? roll.hue : slotHue(seed)
  const glowSeed = roll ? roll.seeds : slotSeeds(seed)
  // the vote screen blurs its snapshot in CSS: the faces hold still there, and the grid never blurs
  const frost = review && !lowPower && stream === null

  // ── the transform ──
  const settle = review ? REVIEW_SETTLE_SCALE : SETTLE_SCALE
  const pop = turn.fromSettled ? settle * SETTLED_TURN_LIFT : POP_SCALE
  const verdictScale = resetting ? 1 : turn.flipping ? pop : !pending ? settle : 1
  const tileScale = lowPower ? 1 : verdictScale * (pressIn && pending ? PRESS_SCALE : 1)
  const rotY = pending ? 0 : turn.rotY
  // raised, and held inside the screen, for as long as it is doing something
  const active = turn.flipping || landing > 0
  // at scale 1 the tile never leaves its room
  const room = useTileRoom(rootRef, active && !lowPower)
  const pull = keepInside(room, tileScale, POP_SCALE)
  const transform = [
    // before the perspective, so it moves the tile rather than the axis it turns about
    pull ? `translate(${pull.x.toFixed(2)}px, ${pull.y.toFixed(2)}px)` : "",
    !lowPower ? `perspective(${PERSPECTIVE_PX}px) rotateY(${rotY}deg)` : "",
    // promoted through the warning, so the verdict's turn does not start blank (a tap wakes it on press)
    !lowPower ? `scale(${(inCue && tileScale === 1 ? 1.0001 : tileScale).toFixed(4)})` : "",
  ]
    .filter(Boolean)
    .join(" ")
  const transition = snapped
    ? "none"
    : turn.flipping && !pending
      ? `transform ${turn.ms}ms ${TURN_EASE}`
      : press && pending
        ? `transform ${PRESS_MS}ms ${PRESS_EASE}`
        : !pending
          ? SLAM
          : IDLE

  // A card is drawn on whichever plane shows its colour, or is about to: it
  // mounts as the turn toward it begins and unmounts once the turn away from it
  // has passed edge-on.
  const planeCard = (onBack: boolean): TileVerdict | null => {
    const card = onBack ? turn.back : turn.front
    if (!card) return null
    const plane: Face = onBack ? "back" : "front"
    return target === plane || face === plane ? card : null
  }
  const planeZ = (onBack: boolean, d: number) =>
    onBack ? `translateZ(${-(SLAB_DEPTH_PX + d)}px) rotateY(180deg)` : `translateZ(${d}px)`

  return (
    <div
      ref={rootRef}
      onPointerDown={tap.ready ? onPointerDown : undefined}
      className={cn(
        "tile-3d relative will-change-transform",
        takesGesture && "touch-pan-y select-none",
        tap.ready && "cursor-pointer",
      )}
      data-tile-votable={tap.votable}
      data-tile-tap-ready={tap.ready}
      data-tile-verdict={committed ?? "pending"}
      // the grid slot reads this to come forward with the tile
      data-tile-active={active ? "true" : undefined}
      style={
        {
          "--attest-neg": RIM_NEG,
          "--attest-neg-rgb": RIM_NEG_RGB,
          transform,
          transition,
          transformOrigin: "center center",
          zIndex: active ? ACTIVE_Z : undefined,
        } as CSSProperties
      }
    >
      {landing > 0 && !lowPower ? <LandingBurst key={landing} verdict={turn.shown} flipped={backShowing} /> : null}
      {/* the cue layer: its own transform only, so it never fights the root's turn */}
      <div
        data-cue="cue"
        className={cn(
          "tile-3d",
          inCue && "tile-cue-wiggle-y",
          landing > 0 && !lowPower && "tile-landing-resonate",
        )}
        // per frame in the cue; once it ends, the lean eases back upright
        style={{ transition: inCue ? "none" : LEAN_EASE }}
      >
        <div className="tile-3d relative rounded-[12px]" style={{ width: TILE_PX, height: TILE_PX }}>
          {pressed && !lowPower ? <HopGlow poolGrow={POOL_GROW_VERDICT_PX} /> : null}
          {!lowPower ? (
            <TurnBloom
              active={turn.flipping || landing > 0}
              settled={lit}
              poolGrow={poolGrow}
              verdict={turn.shown}
              flipped={backShowing}
              roleTone={roleTone}
            />
          ) : roleTone ? (
            <LowPowerRole tone={roleTone} />
          ) : null}
          {!lowPower ? (
            <Slab
              flipped={backShowing}
              flipping={turn.flipping}
              turnMs={turn.ms}
              depthK={inCue ? TILT_SLAB_K : 1}
              seen={turn.flipping || resetting || inCue}
            />
          ) : null}
          {turn.flipping && !resetting ? <FlipGlint dir={turn.dir} turnMs={turn.ms} /> : null}
          {/* the covered card: its own light, and the portrait in glass over it. Low power shows the photo face. */}
          {[true, false].map((onBack) =>
            planeCard(onBack) === "reject" && negativeFace === "glow" && !lowPower && !resetting ? (
              <div
                key={`glow-${turn.key}-${onBack ? "b" : "f"}`}
                aria-hidden
                className="tile-gradient-face is-glow-face"
                style={{ transform: planeZ(onBack, 1.9) }}
              >
                <div className="tile-v4-cover">
                  <CardGlow seed={glowSeed} hue={coverHue} />
                </div>
                <div className="tile-v4-liquid">
                  <div className="tile-v4-star">
                    <div className="tile-v4-star-morph">
                      <AutoGlassMark side="negative" photo={false} />
                    </div>
                  </div>
                </div>
              </div>
            ) : null,
          )}
          {/* the photo faces: the approved card's tick, and the reviewed (or low power) reject's portrait */}
          {[true, false].map((onBack) => {
            const card = planeCard(onBack)
            const photoFace = card === "approve" || (card === "reject" && (negativeFace === "photo" || lowPower))
            return photoFace && !resetting ? (
              <div
                key={`photo-${turn.key}-${onBack ? "b" : "f"}`}
                aria-hidden
                className="tile-gradient-face is-tick"
                style={{ transform: planeZ(onBack, 1.9) }}
              >
                <div className="tile-v4-liquid">
                  <div className="tile-v4-star">
                    <div className="tile-v4-star-morph">
                      {!lowPower ? (
                        <AutoGlassMark
                          side={card === "reject" ? "negative" : "positive"}
                          photo
                          tint={card === "reject" ? undefined : "var(--game-approve)"}
                          wash={card === "reject" ? undefined : REJECT_WASH}
                          snapshot={frost ? still : undefined}
                        />
                      ) : (
                        <LowPowerMark side={card === "reject" ? "negative" : "positive"} />
                      )}
                    </div>
                  </div>
                </div>
                {lowPower ? <div key={card} className={`tile-lp-edge is-${card}`} /> : null}
              </div>
            ) : null
          })}
          {/* the front face: the live feed, whatever the caller lays over it, the ban chip */}
          <div
            className="tile-round tile-one-sided relative z-[2] h-full w-full"
          >
            {feed ? <VideoSlot video={feed} active={!videoOnBack} /> : null}
            {children}
            {warn && lowWash ? <LowPowerWarn leadMs={warn.leadMs} atMs={warn.atMs} wash={lowWash} /> : null}
            {pressed ? <TapHint still={lowPower} /> : null}
            {onBan && takesGesture && pending && !resetting ? <EyeChip onPress={onBan} /> : null}
            {turn.front ? (
              <FrontVerdictOverlay
                verdict={turn.front}
                live={stream !== null}
                still={still}
                resetting={resetting}
                showContent={face === "front"}
                rejectGradient={lowWash}
              />
            ) : null}
          </div>
          {!backShowing ? <TileStroke /> : null}
          {turn.back ? (
            <RotationVerdictFill
              verdict={turn.back}
              video={feed}
              videoHere={videoOnBack}
              still={still}
              resetting={resetting}
              showContent={face === "back"}
              depth={SLAB_DEPTH_PX + 1}
              frosted={frost && turn.back === "reject"}
              covered={backCovered}
            />
          ) : null}
          {/* the warning's wave, over whichever side shows */}
          {wavy ? <TileWave onBack={backShowing} slow={!inCue} deepen={inCue} /> : null}
        </div>
      </div>
    </div>
  )
}

/** the lesson's tap at the tile centre: a touch circle and a finger. Still: one wrapper fades in and out, nothing moves. */
function TapHint({ still }: { still: boolean }) {
  return (
    <div aria-hidden className={still ? "tile-tap-still" : undefined}>
      <div className={cn("tile-tap-hint", still && "is-still")} />
      <svg className={cn("tile-tap-finger", still && "is-still")} width={26} height={36.4} viewBox="0 0 15 21">
        <path d={TAP_FINGER_D} fill="white" />
      </svg>
    </div>
  )
}
