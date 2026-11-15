// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { DARK_THEME_ART_WELL, artWellOf, type ColorToken } from "./card"
import type { Unsubscribe, WorkerHost } from "./host"

export interface ArtWell {
  current(): ColorToken
  onChange(redraw: () => void): Unsubscribe
}

const wells = new WeakMap<WorkerHost, ArtWell>()

export function artWellFor(host: WorkerHost): ArtWell {
  const known = wells.get(host)
  if (known) return known

  let well = DARK_THEME_ART_WELL
  const redraws = new Set<() => void>()
  host.theme?.subscribe((theme) => {
    const next = artWellOf(theme)
    if (next === well) return
    well = next
    for (const redraw of [...redraws]) redraw()
  })

  const created: ArtWell = {
    current: () => well,
    onChange(redraw) {
      redraws.add(redraw)
      return () => {
        redraws.delete(redraw)
      }
    },
  }
  wells.set(host, created)
  return created
}
