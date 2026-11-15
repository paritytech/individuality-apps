// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

const camera = vi.hoisted(() => ({ tapCamera: vi.fn() }))
vi.mock("@/lib/camera", () => ({ tapCamera: camera.tapCamera }))
vi.mock("@/components/ui/screen", () => ({ Body: ({ children }: { children: ReactNode }) => children }))
vi.mock("@/lib/camera-help", () => ({ cameraHelp: vi.fn() }))
vi.mock("@/lib/camera-restart-notice", async () => await import("./camera-restart-notice"))
vi.mock("@/lib/permission-copy", () => ({ CAMERA_OFF_LINE: "Camera off" }))

import { CameraTapBanner } from "../components/camera-needed"

type ElementLike = { props?: { children?: ReactNode; onClick?: () => void; disabled?: boolean; [key: string]: unknown } }

function walk(node: ReactNode, visit: (element: ElementLike) => void): void {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  const element = node as ElementLike
  visit(element)
  walk(element.props?.children, visit)
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(text).join(" ")
  return text((node as ElementLike | null)?.props?.children ?? "")
}

describe("CameraTapBanner", () => {
  it("renders the exact notice and one click calls tapCamera once", () => {
    const tree = CameraTapBanner({ disabled: false })
    let button: ElementLike | undefined
    walk(tree, (element) => {
      if (element.props?.["data-testid"] === "camera-tap") button = element
    })

    expect(text(tree)).toContain("Camera problem")
    expect(text(tree)).toContain("Turn your camera back on")
    expect(text(tree)).toContain("Your camera stopped sending video. Tap once to start it again.")
    button?.props?.onClick?.()
    expect(camera.tapCamera).toHaveBeenCalledOnce()
  })

  it("disables the button while tapping or opening", () => {
    const tree = CameraTapBanner({ disabled: true })
    let disabled = false
    walk(tree, (element) => {
      if (element.props?.["data-testid"] === "camera-tap") disabled = element.props.disabled === true
    })
    expect(disabled).toBe(true)
  })
})
