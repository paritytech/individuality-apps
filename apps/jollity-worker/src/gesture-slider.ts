// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The docked Register slider, drawn by this worker on the host's general `Gesture` node: the pill, thumb and two
 * lines of the approved slider look, and its press, spring settle and pop, given to the host as the gesture's feel
 * so it plays them at display rate.
 *
 * How the slider follows the finger (the build's GESTURE_MODE):
 * - `host-driven` (the default): the host moves the thumb itself, completes the slide past 90% of its travel, and
 *   the worker hears only the start and the end;
 * - `every-move`: the host sends at most one move a display frame, none while one is unanswered, and the worker
 *   answers only the newest it holds with a `SetOffset` for the keyed thumb, never a tree. A tree goes out only when
 *   something besides the thumb changes, and always at the end of a drag.
 */
import { decodeGestureEvent, setOffset, type Modifier, type RendererNode } from "@parity/truapi"
import type { SliderProps } from "./card"

export type GestureMode = "host-driven" | "every-move"
export type SliderPosition = { x: number; completed: boolean }
export const GESTURE_START = "gesture-slider.start"
export const GESTURE_MOVE = "gesture-slider.move"
export const GESTURE_END = "gesture-slider.end"
/** The key of the slider's Gesture, which `SetOffset` names to move its thumb. */
export const GESTURE_THUMB_KEY = "gesture-slider.thumb"
export const initialSliderPosition = (): SliderPosition => ({ x: 0, completed: false })

export function moveSlider(state: SliderPosition, action: string, payload?: Uint8Array): {
  state: SliderPosition; handled: boolean; confirm: boolean
} {
  if (![GESTURE_START, GESTURE_MOVE, GESTURE_END].includes(action)) return { state, handled: false, confirm: false }
  if (!payload) return { state, handled: true, confirm: false }
  const event = decodeGestureEvent(payload)
  // Gesture positions come in hundredths of a logical pixel.
  const x = Math.max(0, event.x / 100)
  if (event.phase === "Started") return { state: initialSliderPosition(), handled: true, confirm: false }
  if (state.completed) return { state, handled: true, confirm: false }
  if (event.phase === "Moved") return { state: { x, completed: false }, handled: true, confirm: false }
  const complete = event.phase === "Completed" || (event.phase === "Ended" && event.fractionPermille >= 900)
  return {
    state: complete ? { x, completed: true } : initialSliderPosition(),
    handled: true,
    confirm: complete,
  }
}

/** Bytes as the client spells them: a 0x-prefixed hex string. */
const hexBytes = (bytes: number[]): `0x${string}` => `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`

/**
 * The approved docked slider's look and motion, value for value. Colours are
 * 0xRRGGBBAA; lengths in points, or in hundredths of a point where the field says so.
 */
export const SLIDE_LOOK = {
  pillHeight: 80,
  pillRadius: 40,
  track: 0x33363aff,
  inset: 12, // the thumb's inset from the pill's edges
  thumb: 56,
  thumbFill: 0xfdfdfdff,
  // A 0 2 6 shadow at 0.36 black: 0.36 of 255 is 92 (0x5C). Hundredths.
  thumbShadow: { color: 0x0000005c, x: 0, y: 200, blur: 600 },
  textStart: 84, // the lines' start, from the pill's start
  textEnd: 16, // the lines' end, from the pill's end
  line: { size: 1800, lineHeight: 2200, letterSpacing: 0 }, // 18 on 22, in hundredths
  line1: { weight: 400, color: 0x585a62ff },
  line2: { weight: 600, color: 0xf5f6f9ff },
  gap: 460, // between the lines: 4.6, in hundredths
  textPaddingTop: 100, // 1, in hundredths
  fadeRatePermille: 1400, // the lines fade at 1.4 times the thumb's share of its travel
  // The first line's band: the 13 stops of its gradient (alpha 0 to 0.970 to 0, of 255), 186 wide, 212 pt/s, 70 lead, 1 s rest.
  shimmer: {
    color: 0xffffffff,
    stops: hexBytes([0, 0.011, 0.054, 0.181, 0.44, 0.766, 0.97, 0.766, 0.44, 0.181, 0.054, 0.011, 0].map((a) => Math.round(a * 255))),
    band: 18_600,
    lead: 7000,
    speed: 21_200,
    restMs: 1000,
  },
  spinMs: 800, // one turn of the spinner
  feel: {
    pressScalePermille: 1059, // the thumb grows to 1.059 on press
    pressMs: 133,
    unpressMs: 150,
    springOmegaCenti: 1800, // the settle's spring: 18 rad/s
    springDampingCenti: 80, // damped at 0.8
    approachMs: 117,
    approachReference: 4200, // the approach grows with sqrt(distance / 42)
    popPermille: [1059, 1132, 1192, 1225, 1235, 1237, 1237, 1237, 1232, 1226, 1219, 1198, 1149, 1099,
      1050, 1023, 1005, 991, 981, 977, 976, 977, 983, 988, 990, 994, 998, 1000], // the pop's scale, frame by frame
    popOffset: 333, // 3.33, in hundredths
  },
} as const

/** The chevron and the spinner of the thumb, drawn at 3x, in the worker's archive. */
export const SLIDE_CHEVRON = "chat-card/slide-chevron.png"
export const SLIDE_SPINNER = "chat-card/slide-spinner.png"

const W = SLIDE_LOOK
/** The pill's content box: the pill less its 12 inset all round. */
const CONTENT = W.pillHeight - 2 * W.inset

/**
 * How far each line moves from where the tree's column puts it, in hundredths. The slider centres the lines (with
 * their gap) in the pill below a padding of 1; the tree's column centres them in the content box with no gap, so each
 * line is moved by the difference.
 */
export function lineNudges(lines: 1 | 2): number[] {
  const block = lines * W.line.lineHeight + (lines - 1) * W.gap
  const slideTop = W.textPaddingTop + (W.pillHeight * 100 - W.textPaddingTop - block) / 2 - W.inset * 100
  const treeTop = (CONTENT * 100 - lines * W.line.lineHeight) / 2
  return Array.from({ length: lines }, (_, i) => Math.round(slideTop + i * (W.line.lineHeight + W.gap) - (treeTop + i * W.line.lineHeight)))
}

const line = (text: string, style: { weight: number; color: number }, nudge: number, shimmer: boolean): RendererNode => ({
  tag: "Text", value: {
    modifiers: [
      { tag: "Font", value: { ...W.line, ...style } },
      ...(nudge !== 0 ? [{ tag: "Translate" as const, value: { x: 0, y: nudge } }] : []),
      ...(shimmer ? [{ tag: "Shimmer" as const, value: W.shimmer }] : []),
    ],
    props: {},
    children: [{ tag: "String", value: { text } }],
  },
})

/** The two lines beside the thumb: the label (with the band while the slider waits) over the secondary line. */
function labels(props: SliderProps, waiting: boolean): RendererNode {
  const second = props.secondaryText ?? ""
  const nudges = lineNudges(second ? 2 : 1)
  return {
    tag: "Column", value: {
      modifiers: [
        { tag: "FillWidth", value: true },
        { tag: "Margin", value: { top: 0, end: W.textEnd - W.inset, bottom: 0, start: W.textStart - W.inset } },
        { tag: "FadeWithPan", value: { key: GESTURE_THUMB_KEY, ratePermille: W.fadeRatePermille } },
        // Held at the end (sliding done, or waiting on the product), the text stands at 1 - 1.4: gone.
        ...(waiting ? [] : [{ tag: "Opacity" as const, value: 0 }]),
      ],
      props: { horizontalAlignment: "Start" },
      children: [
        line(props.text, W.line1, nudges[0]!, waiting),
        ...(second ? [line(second, W.line2, nudges[1]!, false)] : []),
      ],
    },
  }
}

/**
 * The slider as the host draws it: `frame` (the card's modifiers for the slider) stays the frame around the pill,
 * and the thumb stands at `state.x` when the worker answers every move.
 */
export function drawGestureSlider(props: SliderProps, frame: Modifier[], state: SliderPosition, mode: GestureMode): RendererNode {
  const waiting = !props.loading && !props.confirmed
  const thumb: RendererNode = {
    tag: "Box", value: {
      modifiers: [
        { tag: "Width", value: W.thumb }, { tag: "Height", value: W.thumb },
        { tag: "Shadow", value: W.thumbShadow },
        { tag: "Fill", value: { color: W.thumbFill, shape: { tag: "Circle" } } },
        ...(mode === "every-move" ? [{ tag: "Margin" as const, value: { top: 0, end: 0, bottom: 0, start: Math.round(state.x) } }] : []),
      ],
      props: { contentAlignment: "Center" },
      children: [{ tag: "Image", value: {
        modifiers: [{ tag: "Width", value: W.thumb }, { tag: "Height", value: W.thumb }, ...(props.loading ? [{ tag: "Spin" as const, value: W.spinMs }] : [])],
        props: { source: { tag: "Archive", value: props.loading ? SLIDE_SPINNER : SLIDE_CHEVRON }, fit: "Fill" },
      } }],
    },
  }
  const gesture: RendererNode = {
    tag: "Gesture", value: {
      modifiers: [{ tag: "FillWidth", value: true }, { tag: "Height", value: W.thumb }],
      props: {
        accessibilityLabel: props.secondaryText ? `${props.text}, ${props.secondaryText}` : props.text,
        enabled: props.enabled !== false && !props.loading && !props.confirmed,
        hapticOnComplete: true,
        pan: {
          axis: "Horizontal", startAction: GESTURE_START, endAction: GESTURE_END,
          ...(mode === "host-driven"
            ? { drag: { travel: { tag: "ParentWidth" }, release: { tag: "Complete", value: { thresholdPercent: 90 } }, holdAtEnd: true } }
            : { moveAction: GESTURE_MOVE, moveIntervalMs: 0 }),
        },
        // The labels fade by this key's travel, and a keyed pan with a move action is paced by the host.
        key: GESTURE_THUMB_KEY,
        feel: { ...W.feel, popPermille: [...W.feel.popPermille] },
      },
      children: [thumb],
    },
  }
  const pill: RendererNode = {
    tag: "Box", value: {
      modifiers: [
        { tag: "FillWidth", value: true }, { tag: "Height", value: CONTENT },
        { tag: "Padding", value: { top: W.inset, end: W.inset, bottom: W.inset, start: W.inset } },
        { tag: "Fill", value: { color: W.track, shape: { tag: "Rounded", value: W.pillRadius } } },
      ],
      props: { contentAlignment: "CenterStart" },
      children: [labels(props, waiting), gesture],
    },
  }
  return frame.length ? { tag: "Box", value: { modifiers: frame, props: { contentAlignment: "CenterStart" }, children: [pill] } } : pill
}

/** The answer to a move in `every-move`: the thumb's distance from where the last tree drew it. */
export const thumbOffset = (x: number, drawnAt: number): RendererNode => setOffset(GESTURE_THUMB_KEY, x - drawnAt)

