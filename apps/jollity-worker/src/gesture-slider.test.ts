// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { encodeGestureEvent, RendererNode as RendererNodeCodec, type Modifier, type RendererNode } from "@parity/truapi"
import type { SliderProps } from "./card"
import {
  drawGestureSlider, lineNudges, moveSlider, initialSliderPosition, thumbOffset,
  GESTURE_END, GESTURE_MOVE, GESTURE_THUMB_KEY,
} from "./gesture-slider"

const register: SliderProps = {
  text: "Slide to register", secondaryText: undefined, enabled: true, loading: false, confirmed: false, action: "register",
}

describe("the worker-drawn gesture slider works", () => {
  it("follows a move and resets a partial release", () => {
    const moved = moveSlider(initialSliderPosition(), GESTURE_MOVE, encodeGestureEvent({ phase: "Moved", x: 12000, y: 0, fractionPermille: 500 }))
    expect(moved.state.x).toBe(120)
    expect(moved.confirm).toBe(false)
    expect(JSON.stringify(drawGestureSlider(register, [], moved.state, "every-move"))).toContain('"start":120')
    const ended = moveSlider(moved.state, GESTURE_END, encodeGestureEvent({ phase: "Ended", x: 12000, y: 0, fractionPermille: 500 }))
    expect(ended).toEqual({ state: initialSliderPosition(), handled: true, confirm: false })
  })

  it("reads a move in hundredths of a logical pixel and draws the margin in whole points", () => {
    const moved = moveSlider(initialSliderPosition(), GESTURE_MOVE, encodeGestureEvent({ phase: "Moved", x: 12050, y: 0, fractionPermille: 500 }))
    expect(moved.state.x).toBe(120.5)
    expect(JSON.stringify(drawGestureSlider(register, [], moved.state, "every-move"))).toContain('"start":121')
  })

  it("host-driven mode declares no per-move action and leaves the thumb to the host", () => {
    const tree = JSON.stringify(drawGestureSlider(register, [], initialSliderPosition(), "host-driven"))
    expect(tree).toContain('"tag":"ParentWidth"')
    expect(tree).toContain('"thresholdPercent":90')
    expect(tree).not.toContain('"moveAction"')
    expect(tree).not.toContain('"tag":"Margin","value":{"top":0,"end":0,"bottom":0,"start"')
  })

  it("completes either mode once and never completes cancellation", () => {
    for (const phase of ["Ended", "Completed"] as const) {
      const payload = encodeGestureEvent({ phase, x: 24000, y: 0, fractionPermille: 1000 })
      const first = moveSlider(initialSliderPosition(), GESTURE_END, payload)
      expect(first.confirm).toBe(true)
      expect(moveSlider(first.state, GESTURE_END, payload).confirm).toBe(false)
    }
    expect(moveSlider(initialSliderPosition(), GESTURE_END, encodeGestureEvent({ phase: "Cancelled", x: 24000, y: 0, fractionPermille: 1000 })).confirm).toBe(false)
  })

  it("every-move keys the thumb's gesture and still hears its moves", () => {
    const tree = JSON.stringify(drawGestureSlider(register, [], { x: 30, completed: false }, "every-move"))
    expect(tree).toContain(`"key":"${GESTURE_THUMB_KEY}"`)
    expect(tree).toContain('"moveAction"')
    expect(tree).toContain('"start":30')
    expect(tree).not.toContain('"drag"')
  })

  it("draws the room footer slider's pill, thumb and two lines with its own values", () => {
    const frame: Modifier[] = [{ tag: "FillWidth", value: true }, { tag: "Height", value: 80 }, { tag: "Padding", value: { top: 0, end: 8, bottom: 0, start: 8 } }]
    const tree = JSON.stringify(drawGestureSlider({ ...register, secondaryText: "Nov 23 at 18:20" }, frame, initialSliderPosition(), "host-driven"))
    // The docked frame is kept around the pill: 80 tall, 8 more at each side.
    expect(tree.startsWith('{"tag":"Box","value":{"modifiers":[{"tag":"FillWidth","value":true},{"tag":"Height","value":80},{"tag":"Padding","value":{"top":0,"end":8,"bottom":0,"start":8}}]')).toBe(true)
    expect(tree).toContain(`{"tag":"Fill","value":{"color":${0x33363aff},"shape":{"tag":"Rounded","value":40}}}`)
    expect(tree).toContain(`{"tag":"Fill","value":{"color":${0xfdfdfdff},"shape":{"tag":"Circle"}}}`)
    expect(tree).toContain('{"tag":"Shadow","value":{"color":92,"x":0,"y":200,"blur":600}}')
    expect(tree).toContain(`"weight":400,"color":${0x585a62ff}`)
    expect(tree).toContain(`"weight":600,"color":${0xf5f6f9ff}`)
    expect(tree).toContain('"text":"Nov 23 at 18:20"')
    expect(tree).toContain('"stops":"0x00030e2e70c3f7c3702e0e0300"')
    expect(tree).toContain('"value":"chat-card/slide-chevron.png"')
    expect(tree).toContain(`"key":"${GESTURE_THUMB_KEY}"`)
    expect(tree).toContain('"pressScalePermille":1059')
    expect(tree).not.toContain("FgWarning")
  })

  it("puts each line where the slider centres it: 16.2 and 42.8 from the pill's top, or 29.5 alone", () => {
    // The tree's column is centred in the 56-point content box with no gap; the nudges move it to the slider's places.
    expect(lineNudges(2)).toEqual([-180, 280])
    expect(lineNudges(1)).toEqual([50])
  })

  it("holds the text faded out and the spinner turning once the product works", () => {
    const tree = JSON.stringify(drawGestureSlider({ ...register, loading: true, action: undefined }, [], initialSliderPosition(), "host-driven"))
    expect(tree).toContain('{"tag":"Opacity","value":0}')
    expect(tree).toContain('"chat-card/slide-spinner.png"')
    expect(tree).toContain('{"tag":"Spin","value":800}')
    expect(tree).not.toContain('"Shimmer"')
  })

  it("answers a move with an offset from where the last tree drew the thumb, far smaller than a tree", () => {
    expect(thumbOffset(130, 30)).toEqual({ tag: "SetOffset", value: { key: GESTURE_THUMB_KEY, x: 10000, y: 0 } })
    expect(thumbOffset(130.25, 30)).toEqual({ tag: "SetOffset", value: { key: GESTURE_THUMB_KEY, x: 10025, y: 0 } })
    const tree = drawGestureSlider(register, [], initialSliderPosition(), "every-move")
    const bytes = (node: RendererNode) => RendererNodeCodec.enc(node).length
    expect(bytes(thumbOffset(130, 30))).toBeLessThan(40)
    expect(bytes(thumbOffset(130, 30)) * 5).toBeLessThan(bytes(tree))
  })
})
