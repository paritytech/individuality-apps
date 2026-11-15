// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useSyncExternalStore } from "react"
import { getCameraDiagnosticSnapshot, subscribeCameraDiagnostics } from "@/lib/camera-diagnostics"
import { formatCameraStatus } from "@/lib/camera-status"

const EMPTY = getCameraDiagnosticSnapshot()

export function CameraStatusView() {
  const camera = useSyncExternalStore(subscribeCameraDiagnostics, getCameraDiagnosticSnapshot, () => EMPTY)
  return (
    <p aria-label="Camera status" className="border-b border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
      {formatCameraStatus(camera)}
    </p>
  )
}
