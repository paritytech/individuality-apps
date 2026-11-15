// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CameraDiagnosticSnapshot } from "./camera-diagnostics"

export function formatCameraStatus(camera: CameraDiagnosticSnapshot, currentMs = typeof performance === "undefined" ? 0 : performance.now()): string {
  const track = camera.track
  const self = camera.self
  const outbound = camera.outbound
  return [
    `camera ${camera.streamId}`,
    camera.openedAt ? `age:${Math.max(0, Math.round(currentMs - camera.openedAt))}ms` : "",
    `${track?.readyState ?? "off"}${track?.muted ? "/muted" : ""}${track && !track.enabled ? "/disabled" : ""}`,
    track?.width ? `${track.width}×${track.height ?? "?"}@${track.frameRate ?? "?"}` : "",
    self.checkpoint ? `self:${self.checkpoint}/${self.stale ? "repaired" : "current"}/${self.play ?? "?"}/${self.fps?.toFixed(1) ?? "?"}fps` : "",
    outbound.links ? `out:${outbound.links}/${outbound.fps?.toFixed(1) ?? "?"}fps/${outbound.limitation ?? "none"}` : "",
    `${camera.lastEvent}${camera.recovery ? `/${camera.recovery}` : ""}`,
  ].filter(Boolean).join(" · ")
}
