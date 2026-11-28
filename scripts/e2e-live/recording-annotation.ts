// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { contrast, crewIdentity, scenarioPresentation } from "./crew/catalogue"
import { isNarrationTransportFailure, type NarrationState, type NarrationTransition } from "./narration"
import type { RecordingSegment, SlotResult } from "./result"

export interface RecordingParticipantState {
  startSeconds: number
  endSeconds: number
  state: NarrationState | "unavailable"
  text: string
  source: NarrationTransition["source"] | "evidence"
  action: string | null
}

export interface RecordingParticipant {
  slot: number
  account: string
  key: string
  displayName: string
  colour: string
  receiver: boolean
  states: RecordingParticipantState[]
}

export interface RecordingCueSheet {
  version: 1
  runId: string
  attempt: number
  gameIndex: number
  clockBasis: "runner-wall-clock-media-calibrated"
  segment: RecordingSegment & { durationSeconds: number }
  receiver: { slot: number; key: string; displayName: string; profile: string; title: string }
  participants: RecordingParticipant[]
  unavailable: { account: string; reason: string }[]
}

export interface BuildRecordingCueSheetInput {
  runId: string
  receiver: SlotResult
  results: readonly SlotResult[]
  segment: RecordingSegment
  durationSeconds: number
}

const compareText = (one: string, two: string): number => (one < two ? -1 : one > two ? 1 : 0)
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const lightenUntilReadable = (hex: string): string => {
  if (contrast(hex, "#0D1321") >= 4.5) return hex
  const value = Number.parseInt(hex.slice(1), 16)
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  for (let amount = 0.1; amount <= 1; amount += 0.1) {
    const mixed = channels.map((channel) => Math.round(channel + (255 - channel) * amount))
    const candidate = `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
    if (contrast(candidate, "#0D1321") >= 4.5) return candidate
  }
  return "#FFFFFF"
}

function identity(result: SlotResult): { key: string; displayName: string; colour: string } {
  try {
    if (!result.username) throw new Error("missing username")
    const found = crewIdentity(result.username)
    return { key: found.key, displayName: found.displayName, colour: lightenUntilReadable(found.palette.primary) }
  } catch {
    return {
      key: `slot-${result.slot}`,
      displayName: result.username || `Bot ${result.slot}`,
      colour: "#7C8DB5",
    }
  }
}

function title(result: SlotResult): string {
  try {
    return scenarioPresentation(result.profile).title
  } catch {
    return result.profile
  }
}

const exactRun = (candidate: SlotResult, receiver: SlotResult, runId: string): boolean =>
  candidate.version === 2 &&
  candidate.run?.id === runId &&
  candidate.run.attempt === receiver.run?.attempt &&
  candidate.game?.index === receiver.game?.index

function statesFor(result: SlotResult, receiver: SlotResult, segment: RecordingSegment, durationSeconds: number): RecordingParticipantState[] {
  // Both the WebM creation_time and narration are stamped by the runner host.
  // They are not browser Date values, so persona clock offsets cannot skew
  // them. GitHub runner clocks are NTP-synchronised; chain run/attempt/game
  // identity is the correlation boundary, not a finalized-chain correction
  // whose independently observed lag varies between runners.
  const start = Date.parse(segment.startedAt)
  // The codec duration can include close/finalization frames after the runner
  // sealed its evidence clock. Never pull a later event into that tail.
  const evidenceEnd = Math.min(start + durationSeconds * 1000, Date.parse(segment.finishedAt))
  const transitions = result.narration
    // The MP4 rail is rendered later from immutable evidence. A transient
    // failure to update the small in-page HUD is harness-health evidence, not
    // something the character did, and must never replace their real action.
    .filter((transition) => !isNarrationTransportFailure(transition))
    .map((transition, index) => ({ transition, index, at: Date.parse(transition.at) }))
    .filter(({ at }) => Number.isFinite(at) && at < evidenceEnd)
    .sort((one, two) => one.at - two.at || one.index - two.index)
  const initial = [...transitions].reverse().find(({ at }) => at <= start)
  const within = transitions.filter(({ at }) => at > start && at < evidenceEnd)
  const timeline = [...(initial ? [initial] : []), ...within]
  if (timeline.length === 0) {
    return [{ startSeconds: 0, endSeconds: durationSeconds, state: "unavailable", text: "No event timeline was recorded for this participant.", source: "evidence", action: null }]
  }
  const states: RecordingParticipantState[] = timeline.map(({ transition, at }, index) => {
    const next = timeline[index + 1]
    return {
      startSeconds: initial && index === 0 ? 0 : clamp((at - start) / 1000, 0, durationSeconds),
      endSeconds: next ? clamp((next.at - start) / 1000, 0, durationSeconds) : durationSeconds,
      state: transition.state,
      text: transition.text,
      source: transition.source,
      action: transition.action,
    }
  }).filter((state) => state.endSeconds > state.startSeconds)
  if (!initial && states[0]?.startSeconds > 0) {
    states.unshift({
      startSeconds: 0,
      endSeconds: states[0].startSeconds,
      state: "unavailable",
      text: "This participant's event timeline begins later in the recording.",
      source: "evidence",
      action: null,
    })
  }
  return states
}

/** Build a receiver-specific HUD solely from immutable evidence selected by
 * gather. Accounts in the chain roster are the allow-list; run, attempt and
 * game boundaries prevent a rerun from borrowing another attempt's story. */
export function buildRecordingCueSheet(input: BuildRecordingCueSheetInput): RecordingCueSheet {
  const { runId, receiver, results, segment } = input
  const durationSeconds = Math.max(0, input.durationSeconds)
  if (!receiver.game) throw new Error("receiver has no game")
  if (receiver.version !== 2) throw new Error("receiver result predates recording narration")
  if (receiver.run?.id !== runId) throw new Error("receiver does not carry this workflow run id")
  if (!receiver.run.attempt) throw new Error("receiver has no workflow attempt")

  const groupAccounts: string[] = []
  for (const round of [...(receiver.groups ?? [])].sort((one, two) => one.round - two.round)) {
    for (const member of [...round.members].sort((one, two) => one.index - two.index)) {
      if (!groupAccounts.includes(member.account)) groupAccounts.push(member.account)
    }
  }
  if (receiver.account && !groupAccounts.includes(receiver.account)) groupAccounts.unshift(receiver.account)

  const byAccount = new Map<string, SlotResult[]>()
  for (const result of results) {
    if (!result.account) continue
    const list = byAccount.get(result.account) ?? []
    list.push(result)
    byAccount.set(result.account, list)
  }

  const participants: RecordingParticipant[] = []
  const unavailable: { account: string; reason: string }[] = []
  for (const account of groupAccounts) {
    const candidates = byAccount.get(account) ?? []
    const result = candidates.find((candidate) => exactRun(candidate, receiver, runId))
    if (!result) {
      const reason = candidates.length === 0
        ? "No selected result exists for this roster account."
        : "The available result belongs to another run, attempt, or game."
      unavailable.push({ account, reason })
      continue
    }
    const person = identity(result)
    participants.push({
      slot: result.slot,
      account,
      ...person,
      receiver: result.slot === receiver.slot,
      states: statesFor(result, receiver, segment, durationSeconds),
    })
  }
  const receiverIdentity = identity(receiver)
  return {
    version: 1,
    runId,
    attempt: receiver.run.attempt,
    gameIndex: receiver.game.index,
    clockBasis: "runner-wall-clock-media-calibrated",
    segment: { ...segment, durationSeconds },
    receiver: { slot: receiver.slot, ...receiverIdentity, profile: receiver.profile, title: title(receiver) },
    participants,
    unavailable: unavailable.sort((one, two) => compareText(one.account, two.account)),
  }
}

const xmlEscape = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;")

const plainLines = (value: string, width = 43): string[] => {
  const words = value.replaceAll("\n", " ").split(/\s+/).filter(Boolean)
  const lines: string[] = []
  for (const word of words) {
    const line = lines.at(-1)
    if (!line || line.length + word.length + 1 > width) lines.push(word)
    else lines[lines.length - 1] = `${line} ${word}`
  }
  return lines.slice(0, 3)
}

const svgStateColour = (state: RecordingParticipantState["state"]): string => {
  if (state === "active" || state === "failed") return "#FF7C5D"
  if (state === "recovered" || state === "passed") return "#9AD96A"
  if (state === "unavailable") return "#B4A097"
  return "#8CD7F2"
}

/** One deterministic bitmap source for the HUD at a point in the recording.
 * FFmpeg overlays PNGs made from these SVG snapshots; it does not depend on
 * optional drawtext/libass builds on developer machines or Actions images. */
export function renderRecordingHudSvg(sheet: RecordingCueSheet, atSeconds: number, dimensions: { videoHeight: number; panelWidth: number }): string {
  const { videoHeight, panelWidth } = dimensions
  if (![videoHeight, panelWidth].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("HUD dimensions must be positive integers")
  const availableHeight = Math.max(120, videoHeight - 170)
  const rowHeight = Math.min(150, Math.max(28, Math.floor(availableHeight / Math.max(1, sheet.participants.length))))
  const compact = rowHeight < 105
  const bodySize = compact ? 13 : rowHeight < 80 ? 18 : rowHeight < 110 ? 21 : 23
  const rows = sheet.participants.map((participant, index) => {
    const state = participant.states.find((entry) => atSeconds >= entry.startSeconds && atSeconds < entry.endSeconds) ?? {
      startSeconds: 0,
      endSeconds: sheet.segment.durationSeconds,
      state: "unavailable" as const,
      text: "No event evidence covers this moment.",
      source: "evidence" as const,
      action: null,
    }
    const y = 122 + index * rowHeight
    const lines = compact ? [state.text.length > 52 ? `${state.text.slice(0, 49)}…` : state.text] : plainLines(state.text)
    return `<g transform="translate(22 ${y})">
      <circle cx="6" cy="-6" r="6" fill="${xmlEscape(participant.colour)}"/>
      <text x="20" y="0" font-size="${bodySize}" font-weight="700" fill="${xmlEscape(participant.colour)}">${xmlEscape(participant.displayName)}${participant.receiver ? "  •  YOU" : ""}</text>
      <text x="${panelWidth - 22}" y="0" text-anchor="end" font-size="${Math.max(11, bodySize - 3)}" font-weight="700" fill="${svgStateColour(state.state)}">${xmlEscape(state.state.toUpperCase())}</text>
      <text x="0" y="${bodySize + (compact ? 9 : 14)}" font-size="${Math.max(11, bodySize - 4)}" fill="#D7DCE8">${lines.map((line, lineIndex) => `<tspan x="0" dy="${lineIndex === 0 ? 0 : bodySize + 2}">${xmlEscape(line)}</tspan>`).join("")}</text>
    </g>`
  }).join("\n")
  const missing = sheet.unavailable.length
    ? `<text x="22" y="${videoHeight - 62}" font-size="15" fill="#B4A097">Evidence unavailable: ${sheet.unavailable.length} crew timeline${sheet.unavailable.length === 1 ? "" : "s"}</text>`
    : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${videoHeight}" viewBox="0 0 ${panelWidth} ${videoHeight}">
  <rect width="${panelWidth}" height="${videoHeight}" fill="#0D1321"/>
  <text x="22" y="38" font-family="DejaVu Sans,Arial,sans-serif" font-size="28" font-weight="700" fill="#FFFFFF">WHAT THE CREW IS DOING</text>
  <text x="22" y="70" font-family="DejaVu Sans,Arial,sans-serif" font-size="20" fill="#CCD5E5">Receiver: ${xmlEscape(sheet.receiver.displayName)}</text>
  <text x="22" y="96" font-family="DejaVu Sans,Arial,sans-serif" font-size="17" fill="#97A0B4">${xmlEscape(sheet.receiver.title)}</text>
  <g font-family="DejaVu Sans,Arial,sans-serif">${rows}</g>
  ${missing}
  <text x="22" y="${videoHeight - 28}" font-family="DejaVu Sans,Arial,sans-serif" font-size="15" fill="#97A0B4">Actual events from this run • no scheduled actions inferred</text>
</svg>`
}
