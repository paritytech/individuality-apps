// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The waiting room's camera card: the camera will not start, in the words of
 * components/camera-needed. It sits over the title and offers nothing to tap.
 */
import { cameraNeededCopy } from "@/components/camera-needed"
import type { CameraTrouble } from "@/lib/camera-help"

export function CameraCard({ help, hidden, className = "" }: { help: CameraTrouble; hidden: boolean; className?: string }) {
  const { heading, body, starting } = cameraNeededCopy(help)
  return (
    <div
      role="status"
      className={
        "mx-6 mt-4 rounded-2xl bg-card p-4 transition-[opacity,visibility] duration-300 " +
        (hidden ? "invisible opacity-0 " : "") +
        className
      }
    >
      <p className="text-base leading-5 font-semibold text-foreground">{heading}</p>
      <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{body}</p>
      {starting ? <p className="mt-0.5 text-sm leading-5 font-semibold text-foreground">{starting}</p> : null}
    </div>
  )
}
