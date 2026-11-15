// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Humanity's Membership news in the Weekly Game room.
 *
 * Four pieces of news, each said once per episode: you are a Member (with the
 * username to claim), the username is ready to claim, the membership is
 * paused, the membership is back. `announced` is the whole of the dedupe: a
 * line whose kind is in it is not planned again until the person leaves and
 * re-enters the state it is about.
 *
 * Humanity's card once posted these in Humanity's own room, before the chat
 * moved here. Its observation was the Humanity card; here
 * it is the personhood state the worker already reads for the game card.
 *
 * Pure module: types, parsing of untrusted storage, the planner and the tree.
 */
import { ACTION_USERNAME, DARK_THEME_ART_WELL, artCard, button, doneButton, spacer, type ColorToken, type RenderNode } from "../card"

export const MESSAGE_MEMBERSHIP = "jollity.membership"

/** The personhood states the chat speaks about, reduced from the SDK's tags. */
export type Standing = "member" | "suspended" | "other"

export type MembershipMessageKind = "membership" | "claim" | "suspended" | "restored"

/** What one posted line says, and the picture it is drawn with. */
export interface MembershipLine {
  text: string
  status: "ready" | "claim" | "paused" | "back"
  /** The line carries Claim username. */
  claim?: boolean
}

export interface MembershipObservation {
  standing: Standing
  /** The member still wears a numbered name, so the username is there to claim. */
  claimable: boolean
}

const MEMBERSHIP_RECORD_VERSION = 1 as const

export interface MembershipRecord {
  version: typeof MEMBERSHIP_RECORD_VERSION
  /** Null until the first observation: the baseline the rest is diffed against. */
  standing: Standing | null
  claimable: boolean
  /** Set on the step from suspended back to member, until the `restored` line goes out. */
  restoredPending: boolean
  announced: MembershipMessageKind[]
}

const KINDS: readonly MembershipMessageKind[] = ["membership", "claim", "suspended", "restored"]
const STANDINGS: readonly Standing[] = ["member", "suspended", "other"]

/** MembershipReady reads as member, as it does on the Humanity card: Humanity registers it on its own. */
export function standingOf(tag: string): Standing {
  if (tag === "Member" || tag === "Caution" || tag === "MembershipReady") return "member"
  if (tag === "Suspended") return "suspended"
  return "other"
}

/** Whether a personhood state is a member in good standing or close to losing it; null when unread. */
export function isMemberStanding(tag: string | null): boolean | null {
  return tag === null ? null : standingOf(tag) === "member"
}

export function emptyMembershipRecord(): MembershipRecord {
  return { version: MEMBERSHIP_RECORD_VERSION, standing: null, claimable: false, restoredPending: false, announced: [] }
}

/** Parse untrusted storage. Anything unreadable starts over from no baseline. Never throws. */
export function sanitizeMembershipRecord(raw: unknown): MembershipRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyMembershipRecord()
  const value = raw as Record<string, unknown>
  if (value.version !== MEMBERSHIP_RECORD_VERSION) return emptyMembershipRecord()
  const standing = value.standing
  if (standing !== null && !STANDINGS.includes(standing as Standing)) return emptyMembershipRecord()
  const announced = Array.isArray(value.announced)
    ? [...new Set(value.announced.filter((kind): kind is MembershipMessageKind => KINDS.includes(kind as MembershipMessageKind)))]
    : []
  return {
    version: MEMBERSHIP_RECORD_VERSION,
    standing: standing as Standing | null,
    claimable: value.claimable === true,
    restoredPending: value.restoredPending === true && standing === "member",
    announced,
  }
}

const withKind = (announced: readonly MembershipMessageKind[], kind: MembershipMessageKind) =>
  announced.includes(kind) ? [...announced] : [...announced, kind]

/**
 * Fold one read into the record. The first observation is a baseline: a
 * standing member gets `membership` marked without a line, so nobody hears
 * stale news on the worker's first boot (the username claim stays owed). So
 * does a return from suspension, which `restored` announces instead. Leaving
 * suspended re-arms `suspended`, entering it re-arms `restored`.
 */
export function applyMembershipObservation(record: MembershipRecord, observed: MembershipObservation): MembershipRecord {
  const previous = record.standing
  let announced = [...record.announced]
  if (observed.standing === "member" && previous !== "member" && (previous === null || previous === "suspended")) {
    announced = withKind(announced, "membership")
  }
  if (previous === "suspended" && observed.standing !== "suspended") announced = announced.filter((kind) => kind !== "suspended")
  if (previous !== null && previous !== "suspended" && observed.standing === "suspended") {
    announced = announced.filter((kind) => kind !== "restored")
  }
  // A worker that first meets someone already paused says so once: unlike a
  // standing member, a paused one has something to do about it.
  return {
    ...record,
    standing: observed.standing,
    claimable: observed.claimable,
    restoredPending: observed.standing === "member" && (previous === "suspended" || record.restoredPending),
    announced,
  }
}

/**
 * The lines owed for the record as it stands, in posting order: `restored`,
 * `suspended`, `membership`, `claim`. A `membership` line while the name is
 * claimable carries the button, so it also settles `claim`.
 */
export function planMembershipLines(record: MembershipRecord): { kind: MembershipMessageKind; line: MembershipLine }[] {
  const out: { kind: MembershipMessageKind; line: MembershipLine }[] = []
  const { standing, announced } = record
  if (record.restoredPending && standing === "member" && !announced.includes("restored")) {
    out.push({ kind: "restored", line: MEMBERSHIP_COPY.restored })
  }
  if (standing === "suspended" && !announced.includes("suspended")) out.push({ kind: "suspended", line: MEMBERSHIP_COPY.paused })
  if (standing === "member" && !announced.includes("membership")) {
    out.push({ kind: "membership", line: MEMBERSHIP_COPY.member(record.claimable) })
  } else if (standing === "member" && record.claimable && !announced.includes("claim")) {
    out.push({ kind: "claim", line: MEMBERSHIP_COPY.claim })
  }
  return out
}

/** Remember that a line went out. Idempotent. */
export function applyMembershipSent(record: MembershipRecord, kind: MembershipMessageKind): MembershipRecord {
  let announced = withKind(record.announced, kind)
  if (kind === "membership" && record.claimable) announced = withKind(announced, "claim")
  return { ...record, restoredPending: kind === "restored" ? false : record.restoredPending, announced }
}

/** ASCII only: the host reads the worker bundle as Latin-1. */
export const MEMBERSHIP_COPY = {
  member: (claimable: boolean): MembershipLine =>
    claimable
      ? { text: "Congratulations, you are a Polkadot Member! Claim your username.", status: "ready", claim: true }
      : { text: "Congratulations, you are a Polkadot Member!", status: "ready" },
  claim: { text: "Your username is ready to claim.", status: "claim", claim: true } as MembershipLine,
  // The chain does not say why a membership is paused, and a missed game is
  // by far the common reason, so the line speaks to that.
  paused: { text: "Your membership is paused. Play the next game to start rebuilding. It can take more than one.", status: "paused" } as MembershipLine,
  restored: { text: "Your membership is back.", status: "back" } as MembershipLine,
}

const ART: Record<MembershipLine["status"], string> = {
  ready: "chat-card/member-ready.png",
  claim: "chat-card/member-ready.png",
  paused: "chat-card/member-paused.png",
  back: "chat-card/member-back.png",
}

const CLAIM_USERNAME = "Claim username"
const CLAIMED = "Claimed"

/** The tree of one posted line. `nameSet` greys Claim username once the name is claimed. */
export function membershipTree(line: MembershipLine, nameSet = false, well: ColorToken = DARK_THEME_ART_WELL): RenderNode {
  const rest = line.claim
    ? [spacer(12), nameSet ? doneButton(CLAIMED) : button(CLAIM_USERNAME, ACTION_USERNAME)]
    : []
  return artCard(ART[line.status] ?? null, line.text, rest, well)
}

/** A posted payload, or null when it is not one. */
export function membershipLineOf(payload: unknown): MembershipLine | null {
  if (typeof payload !== "object" || payload === null) return null
  const { text, status, claim } = payload as Record<string, unknown>
  if (typeof text !== "string" || typeof status !== "string" || !Object.hasOwn(ART, status)) return null
  return { text, status: status as MembershipLine["status"], ...(claim === true ? { claim: true } : {}) }
}
