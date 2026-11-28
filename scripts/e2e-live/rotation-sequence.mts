// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Rotation advances only after a run actually decides to play. A tiny public
// artifact records that decision and half. This avoids PR boots, skipped runs,
// another network, and expired historical artifacts changing the schedule.
import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export interface RotationMarker {
  name: string
  workflow_run?: { id?: number }
}

export function nextRotation(markers: readonly RotationMarker[], currentRunId: number, network: string): { half: "A" | "B"; runNumber: number } {
  if (!Number.isInteger(currentRunId) || currentRunId < 1) throw new Error(`current GitHub run id must be a positive whole number (got ${String(currentRunId)})`)
  if (!network) throw new Error("rotation network is required")
  const prefix = `e2e-rotation-play-${network}-`
  const parsed = markers.flatMap((marker) => {
    if (!marker.name.startsWith(prefix)) return []
    const match = marker.name.slice(prefix.length).match(/^(\d+)-(A|B)$/)
    if (!match) return []
    const runId = Number(match[1])
    if (!Number.isInteger(runId) || marker.workflow_run?.id !== runId) return []
    return [{ runId, half: match[2] as "A" | "B" }]
  })
  const own = parsed.find((marker) => marker.runId === currentRunId)
  if (own) return { half: own.half, runNumber: currentRunId }
  const latest = parsed.filter((marker) => marker.runId < currentRunId).sort((a, b) => b.runId - a.runId)[0]
  return { half: latest?.half === "A" ? "B" : "A", runNumber: currentRunId }
}

async function main(): Promise<void> {
  let text = ""
  for await (const chunk of process.stdin) text += String(chunk)
  const parsed = JSON.parse(text) as { artifacts?: RotationMarker[] } | { artifacts?: RotationMarker[] }[]
  const pages = Array.isArray(parsed) ? parsed : [parsed]
  const rotation = nextRotation(pages.flatMap((page) => page.artifacts ?? []), Number(process.env.GITHUB_RUN_ID), process.env.E2E_NETWORK ?? "previewnet")
  console.log(`rotation half ${rotation.half} for run ${rotation.runNumber}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rotation_run=${rotation.runNumber}\nrotation_half=${rotation.half}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`rotation sequence failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
