// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SELF-HEAL RECORD: each time the Mesh tries to mend a link (an ICE
 * restart, a rebuild of the peer connection, or answering a peer that came
 * back with an offer), how it started, which attempt it was and how it ended,
 * so a dashboard can show the self-heal's success rate and its time to recover
 * (lib/journeys/rtc-heal.ts turns an event into `rtc.heal_ms`).
 *
 * The triggers are the ones the mesh code has (lib/webrtc/mesh.ts):
 *
 *   disconnected     the link stayed `disconnected` past the grace
 *   failed           the connection reads `failed`
 *   never_connected  a present peer never connected within the initial timeout
 *   media_stall      `connected`, but no inbound frames for FRAMES_STALL_SWEEPS
 *                    sweeps (ANSWERER_STALL_SWEEPS on the answering side), or
 *                    no video at all by the no-video deadline (mesh.ts)
 *   rejoin_offer     the far end rebuilt or restarted. An offer on a link
 *                    that had been up and is not now is answered on the same
 *                    connection ("answer"); an offer or answer from a NEW
 *                    remote connection, or an offer the connection refuses
 *                    for its m-lines, gets a fresh one ("rebuild", #223)
 *   peer_no_video    `connected`, our video goes out, and the peer's own view
 *                    (link-view.ts) says it decodes none of it: the direction
 *                    our inbound frames cannot show. Healed when its view says
 *                    it sees us again (`peer_sees`)
 *   negotiation_error a lane SDP operation failed hard; the recovery remains
 *                     open until local or peer-observed video proves it healed
 *   network_change   the phone's network changed: every link restarts ICE
 *                    over its open channel, or is rebuilt (#1020)
 *   answer_timeout   the offer this side holds went unanswered for the answer
 *                    wait, on a link that had connected before (#1020)
 *   glare_rebuild    our lane offer crossed the far end's on a link that receives
 *                    video, with no heal open: rebuilt instead of rolled back
 *                    (mesh.ts receivesVideo)
 *
 * An attempt ENDS in one of the HealEnd ways. Healed: the link `connected`
 * (`connected`), except that media_stall needs flowing media
 * (`media_flowing`), peer_no_video the peer's view (`peer_sees`), and
 * negotiation_error either of those two. Not healed: the next attempt began first (`next_attempt`),
 * the peer left, or the mesh closed. The attempt number counts attempts since
 * the last heal, per peer. Pure: the Mesh passes the clock.
 */
export type HealTrigger = "disconnected" | "failed" | "never_connected" | "media_stall" | "rejoin_offer" | "peer_no_video" | "negotiation_error" | "network_change" | "answer_timeout" | "glare_rebuild"
export type HealAction = "ice_restart" | "rebuild" | "answer"
export type HealEnd = "connected" | "media_flowing" | "peer_sees" | "next_attempt" | "peer_left" | "mesh_closed"
export type HealDetail = "unseen"

export interface HealEvent {
  trigger: HealTrigger
  action: HealAction
  detail?: HealDetail
  /** 1 for the first attempt since the link was last healthy */
  attempt: number
  healed: boolean
  /** ms from the attempt starting to it ending, healed or not */
  healMs: number
  end: HealEnd
}

export interface HealEpisodeEvent {
  /** At most six visible items: all steps, or first three, +N omitted, last two. */
  ladder: string
  /** every attempt in the episode, including any this row's ladder could not show */
  steps: number
  /** attempts not retained in memory, present only when the episode outgrew
   *  its capped head and tail (KEEP_HEAD + KEEP_TAIL) */
  steps_dropped?: number
  healed: boolean
  end: Exclude<HealEnd, "next_attempt">
  /** ms from the episode's first attempt starting to its terminal end */
  ms: number
}

/** Steps an episode keeps at each end. A peer that never heals can log
 *  thousands of attempts, and only the first and last few are ever read: the
 *  ladder shows at most six, and its count is kept separately. */
const KEEP_HEAD = 8
const KEEP_TAIL = 8

type Step = { trigger: HealTrigger; action: HealAction; detail?: HealDetail }

interface Attempt {
  trigger: HealTrigger
  action: HealAction
  detail?: HealDetail
  attempt: number
  at: number
}

interface Episode {
  at: number
  /** attempts since the episode opened, kept apart from the retained steps */
  count: number
  /** the first KEEP_HEAD steps, then the last KEEP_TAIL once past the cap */
  steps: Step[]
}

export class HealTracker {
  private open = new Map<string, Attempt>()
  private episodes = new Map<string, Episode>()

  /** `emit` hears each finished attempt; `emitEpisode` hears terminal episodes.
   *  Both are required: an emitter left off would drop every row silently. */
  constructor(
    private emit: (peerId: string, event: HealEvent) => void,
    private emitEpisode: (peerId: string, event: HealEpisodeEvent) => void,
  ) {}

  /** what the open attempt is mending, if one is open */
  openTrigger(peerId: string): HealTrigger | undefined {
    return this.open.get(peerId)?.trigger
  }

  isOpen(peerId: string): boolean {
    return this.open.has(peerId)
  }

  /** An attempt starts; the one still open for this peer ends as not healed.
   *  Returns the attempt's number. */
  begin(peerId: string, trigger: HealTrigger, action: HealAction, now: number, detail?: HealDetail): number {
    this.finish(peerId, now, false, "next_attempt")
    let episode = this.episodes.get(peerId)
    if (!episode) {
      episode = { at: now, count: 0, steps: [] }
      this.episodes.set(peerId, episode)
    }
    episode.count += 1
    const step: Step = { trigger, action, ...(detail ? { detail } : {}) }
    if (episode.steps.length < KEEP_HEAD) episode.steps.push(step)
    else {
      episode.steps.push(step)
      // Past head + tail, the oldest tail entry falls off, so memory is bounded.
      if (episode.steps.length > KEEP_HEAD + KEEP_TAIL) episode.steps.splice(KEEP_HEAD, 1)
    }
    const attempt = episode.count
    this.open.set(peerId, { trigger, action, ...(detail ? { detail } : {}), attempt, at: now })
    return attempt
  }

  /** The connection reached `connected`. Media-triggered repairs need media
   *  proof: a data-channel-ready PC can still have a broken video lane. */
  connected(peerId: string, now: number): void {
    const trigger = this.open.get(peerId)?.trigger
    if (trigger !== "media_stall" && trigger !== "peer_no_video" && trigger !== "negotiation_error")
      this.finish(peerId, now, true, "connected")
  }

  /** The peer's view says it decodes our video again. */
  peerSees(peerId: string, now: number): void {
    const trigger = this.open.get(peerId)?.trigger
    if (trigger === "peer_no_video" || trigger === "negotiation_error") this.finish(peerId, now, true, "peer_sees")
  }

  /** Inbound frames advanced: the media lane is healthy. */
  mediaFlowing(peerId: string, now: number): void {
    const trigger = this.open.get(peerId)?.trigger
    if (trigger === "media_stall" || trigger === "negotiation_error") this.finish(peerId, now, true, "media_flowing")
  }

  /** the peer left the mesh: its count starts over, as the Mesh's own budget does */
  leave(peerId: string, now: number): void {
    this.finish(peerId, now, false, "peer_left")
    this.episodes.delete(peerId)
  }

  closeAll(now: number, isConnected: (peerId: string) => boolean = () => false): void {
    for (const peerId of [...this.open.keys()]) {
      if (isConnected(peerId)) this.connected(peerId, now)
      if (this.open.has(peerId)) this.finish(peerId, now, false, "mesh_closed")
    }
    this.episodes.clear()
  }

  private finish(peerId: string, now: number, healed: boolean, end: HealEnd): void {
    const attempt = this.open.get(peerId)
    if (!attempt) return
    this.open.delete(peerId)
    this.emit(peerId, {
      trigger: attempt.trigger,
      action: attempt.action,
      ...(attempt.detail ? { detail: attempt.detail } : {}),
      attempt: attempt.attempt,
      healed,
      healMs: now - attempt.at,
      end,
    })
    if (end === "next_attempt") return
    const episode = this.episodes.get(peerId)
    this.episodes.delete(peerId)
    if (!episode) return
    const format = ({ trigger, action, detail }: Step) => `${trigger}${detail ? `/${detail}` : ""}:${action}`
    const visible = episode.steps.length <= 6
      ? episode.steps.map(format)
      : [
          ...episode.steps.slice(0, 3).map(format),
          `+${episode.count - 5}`,
          ...episode.steps.slice(-2).map(format),
        ]
    const dropped = episode.count - episode.steps.length
    this.emitEpisode(peerId, {
      ladder: visible.join(" > "),
      steps: episode.count,
      ...(dropped > 0 ? { steps_dropped: dropped } : {}),
      healed,
      end,
      ms: now - episode.at,
    })
  }
}
