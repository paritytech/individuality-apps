// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE ORG'S MASKING RULES blank the whole value of any attribute or tag whose
 * key or value contains one of these words (bulletin-deploy's 2026-08-06
 * sweep). Every literal we define is checked here; later tasks add their
 * vocabularies to this file.
 */
import { describe, expect, it } from "vitest"
import { CHEST_REASONS, DRAW_REASONS } from "../journeys/payoff-facts"
import { LAYER_NAMES, layerName } from "../journeys/game-trace"
import { FUNNEL_STAGES } from "../webrtc/funnel"
import { FAILURE_KINDS } from "./failures"
import { HOST_FAILURE_CLASSES } from "@individuality/people-chain"
import { TAG_KEYS } from "./init"
import { JOURNEYS } from "./journeys"
import { MOMENTS } from "./smoothness"
import { MASKED, isMaskSafe } from "./testing"
import { CAMERA_RESTORE_KEYS, CAMERA_RESTORE_LITERALS } from "./camera-restore"

describe("masking-safe literals", () => {
  it("knows the masked words", () => {
    expect(MASKED).toEqual(["auth", "secret", "credential", "password"])
    expect(isMaskSafe("turn.issue")).toBe(true)
    expect(isMaskSafe("auth-token")).toBe(false)
    expect(isMaskSafe("PASSWORD")).toBe(false)
  })

  it.each(FAILURE_KINDS.map((kind) => [kind]))("failure kind %s", (kind) => {
    expect(isMaskSafe(kind)).toBe(true)
  })

  it.each(TAG_KEYS.map((key) => [key]))("tag key %s", (key) => {
    expect(isMaskSafe(key)).toBe(true)
  })

  it.each(["route", "tx.build", "tx.broadcast", "tx.landed", "signing-refused", "not-eligible", "landed", "60s", "read-failed", "not-verified", "render", "app-hidden", "app-suspended", "report.after_abandon", "report.outcome", "build.stale", "build.check", "denied", "failed", "cancelled", "refused", "claim.retries", "claim.retry_attempt", "timeout", "asset.key", "prize.amount", "stale", "current", "unknown", "true", "false", "older than truapi 0.27", "chat.camera.permission"].map((reason) => [reason]))(
    "reason %s",
    (reason) => {
      expect(isMaskSafe(reason)).toBe(true)
    },
  )
})

describe("masking-safe sealed signalling vocabulary", () => {
  // the per-player flag on the game trace, and the sealed wire's counters in
  // the connection_stalled detail (packages/jollity-statement-core health.ts)
  const words = [
    "rtc.no_signalling_key",
    "ownKeyMissing",
    "peerIdMissing",
    "openFailed",
    "plaintextDropped",
    "droppedAtLookupCap",
    "droppedInBackoff",
  ]
  it.each(words.map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})

describe("masking-safe camera restore vocabulary", () => {
  it.each([...CAMERA_RESTORE_KEYS, ...CAMERA_RESTORE_LITERALS].map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})

describe("masking-safe session-record vocabulary", () => {
  const words = [
    "jollity.telemetry.last-session",
    "in-game",
    "previous.exit",
    "previous-session-end",
    ...["clean-close", "killed-background", "crash-or-kill-foreground", "host-reload", "own-reload", "unknown"],
    ...["session_id", "gap_ms", "screen", "game_index", "turn", "live_video", "heap_mb", "open_journeys", "open_journey_steps"],
  ]
  it.each(words.map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})

describe("masking-safe page lifecycle and host retry vocabulary", () => {
  const words = [
    "page-lifecycle", "lifecycle.event", "lifecycle.state", "lifecycle.mono_ms", "lifecycle.persisted",
    ...["visibilitychange", "pagehide", "pageshow", "freeze", "resume", "hidden", "visible"],
    "host.retry", "host.retry.operation", "host.retry.attempt", "host.retry.reason", "host.retry.waited_ms",
    ...["host-interrupted", "block-not-pinned", "read-timeout", "read-failed", "turn"],
    ...["host-read", "storage.read", "storage.open", "identity.user-id", "host.system-info", "sdk.accounts", "sdk.truapi", "chain-read.settle", "chain-read.chest", "turn.ice-servers"],
    ...["signup-route", "signup-seat", "signup-tx", "person-bind", "report", "chain-health"],
    ...["host-reconnect", "foreground-return"],
  ]
  it.each(words.map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})

describe("masking-safe non-error log attributes", () => {
  const keys = [
    "account", "release", "signup.attempt", "signup.route",
    "previous.end", "previous.visibility", "previous.in_game", "previous.pagehide",
    "previous.pagehide_persisted", "previous.freeze", "previous.visibility_changed",
    "previous.screen", "previous.game", "previous.turn",
    "previous.session.session_id", "previous.session.gap_ms", "previous.session.game_index",
    "previous.session.turn", "previous.session.live_video", "previous.session.heap_mb",
    "previous.session.open_journeys", "previous.session.open_journey_steps",
    "previous.session.visibility_changes", "failure.open_journeys", "failure.open_journey_steps",
    "camera.event", "camera.page_ms", "camera.stream_id", "camera.stale",
    "camera.checkpoint", "camera.camera_checkpoint", "camera.age_ms", "camera.reopen_recovered",
    "camera.trigger", "camera.attempt", "camera.deferred", "camera.reason", "camera.open_ms",
    "camera.late", "camera.ready_state", "camera.muted", "camera.enabled", "camera.width",
    "camera.height", "camera.frame_rate", "camera.device_id_hash", "camera.attached_stream_id",
    "camera.current_stream_id", "camera.outcome", "camera.error_name", "camera.paused",
    "camera.frames", "camera.elapsed_ms", "camera.fps", "camera.hidden_since_open",
    "camera.old_stream_id", "camera.new_stream_id", "camera.link", "camera.frames_encoded",
    "camera.frames_sent", "camera.limitation", "camera.track_id", "camera.visible",
    "camera.suspended", "camera.generation", "camera.owner", "camera.grace_ms",
    "storage.op", "storage.key", "storage.ms",
    "chain.health.where", "chain.health.outcome", "chain.health.error_class",
    "chain.health.consecutive_lost", "chain.health.registered", "chain.health.latency_ms",
    "chain.health.error",
    "game_log.storage", "game_log.pending_chunks", "game_log.pending_full_parts",
    "game_log.memory_only_chunk_ids", "game_log.shed_chunk_ids", "game_log.shed_game_indexes",
  ]
  it.each(keys.map((key) => [key]))("attribute %s", (key) => {
    expect(isMaskSafe(key)).toBe(true)
  })
})

describe("masking-safe journey vocabulary", () => {
  const words = Object.entries(JOURNEYS).flatMap(([name, { steps, outcomes }]) => [
    name,
    `journey.${name}`,
    ...steps.map((step) => `${name}.${step}`),
    ...outcomes,
  ])
  it.each(words.map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
  it.each([["journey.sad"], ["journey.sad_reason"], ["journey.expected"], ["journey.outcome"], ["step.outcome"], ["clock.offset"], ["clock.span_drift_ms"], ["chain.time.start"], ["chain.time.end"], ["chain.block.start"], ["chain.block.end"], ["wall.time.start"], ["wall.time.end"], ["clock.span_drift_ms.end"]])(
    "attribute %s",
    (key) => {
      expect(isMaskSafe(key)).toBe(true)
    },
  )
})

describe("masking-safe payoff vocabulary", () => {
  it.each(
    [
      ...CHEST_REASONS, ...DRAW_REASONS, "no-score-row", "suspended", "not-attested", "chain", "derived",
      "draw.invited", "draw.reason", "draw.won", "draw.skipped", "chest.outcome", "chest.count", "chest.settling", "chest.reason", "chest.recovered", "chest.recovery_ms", "collectables", "none",
      "membership.standing", "membership.change", "membership.remaining", "membership.reason", "membership.reason_source",
      "became-member", "lost-membership", "member", "candidate", "payoff.stage", "chest.load", "winners-disagree", "result-disagree",
    ].map((word) => [word]),
  )("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})

// the literals each later lane added: sign-up and person, permissions, join,
// game, and the game log with the render crash
const LANE_WORDS = [
  ...HOST_FAILURE_CLASSES,
  "chain.retries", "chain.retry_reason", "chain.retry_operation", "chain.retry_succeeded", "chain-health", "signup-route", "signup-seat", "signup-tx", "person-bind", "report",
  "signup-broadcast", "build.check_retries", "signup.route", "signup.attempt", "signup.retry_reason", "signup.error_surfaced", "signup.retries", "signup.landed_ms", "signup.window_check_timeout", "registration.finalized_lag_ms", "bind-pending", "stale-alias", "no-alias", "tracking-lost", "host-chain", "network", "other", "window-closed", "refused", "signup.retrying", "retrying", "closed", "signup.stage", "signup.reason", "signup.taps", "signup.landed_by", "reread", "signup.hidden_ms", "signup.on_return", "page-asleep", "asleep", "expired", "draw.entered", "draw.skipped", "unfunded", "person-route", "seat-preparing",
  "person.stage", "person.error", "person.result", "bind-retry", "returning", "deposit", "free",
  "telemetry.grant", "permissions.result", "permissions.step", "permissions.reason", "turn.received", "granted", "refused",
  "camera.blocked", "camera.no-camera", "network.timeout", "network.denied", "statements.allocation", "statements.host-error",
  "network.turn-receipt",
  "camera.warm", "camera.state", "camera.reason", "ready", "unavailable", "denied", "no-camera", "busy", "timeout", "unknown",
  "turn.ok", "turn.cached", "rtc.path", "rtc.outcome", "rtc.ice", "direct", "stun", "relay", "connected",
  "failed", "pending", "join.connected", "game.index", "peer.all",
  "round.1", "round.2", "round.3", "game.late", "rtc.layer", "rtc.from", "game.peer.away", "away.reason", "said", "reconnected", "peer-reconnect", "camera-recover",
  "track-ended", "still-muted", "ended-while-away", "report.outcome", "report-retry", "store-write", "turn-issue",
  "game-log", "game_log.late", "render", "render-crash", "clock-drift", "span-clock", "drift_ms", "journey", "component_stack",
  "ui.moment_frame_ms", "moment", "avg", "max", ...MOMENTS, "rtc.quality_limited_s",
  // the pair id (#255)
  "rtc.pair", "rtc.peer", "g12:r2:5fd9d742609d",
  // coverage (#256)
  "rtc.coverage_pct", "rtc.coverage_s", "rtc.unsupported", "coverage", "unsupported",
  // the connection funnel (#257)
  "rtc.funnel_ms", "rtc.role", "rtc.last_stage", ...FUNNEL_STAGES, "initiator", "answerer", "none", "stage",
  // the selected path (#258)
  "rtc.path_changes", "rtc.local_type", "rtc.remote_type", "rtc.protocol", "rtc.relay_protocol", "rtc.network",
  "host", "srflx", "prflx", "udp", "tcp", "tls", "remote", "wifi", "cellular", "[jollity-rtc] path 5Amy relay/srflx tls",
  // the relay credential outcome (#259)
  "rtc.turn_ttl_left_s", "turn.received", "turn.stage", "turn.status", "turn-unavailable", "true", "false", "cached", "proof-chain", "proof", "issue", "config",
  "proof rejected: ring revision too old", "no personhood proof from the host", "no reason given", "no TURN issuer configured",
  // durable TURN cache wait
  "turn.durable_wait_ms", "turn.durable_result", "durable_timed_out", "hit", "miss", "error",
  // ICE gathering detail (#260)
  "rtc.candidates", "rtc.candidate_type", "rtc.gather_ms", "rtc.ice_errors", "rtc.error_code", "rtc.error_host", "rtc.gathered", "rtc.ice_error",
  "other", "701", "stun.l.google.com", "2/1/0",
  // restart and rebuild detail (#261)
  "rtc.heal_ms", "rtc.heal", "rtc.heal_trigger", "rtc.heal_action", "rtc.heal_detail", "rtc.heal_attempt", "rtc.healed", "rtc.heal_end",
  "disconnected", "never_connected", "media_stall", "rejoin_offer", "ice_restart", "rebuild", "answer",
  "next_attempt", "peer_left", "mesh_closed", "media_flowing", "network_change", "answer_timeout",
  // one terminal row for all attempts in a heal episode (Q14/Q15)
  "rtc.heal_episode", "rtc.heal_ladder", "rtc.heal_steps", "rtc.heal_steps_dropped", "rtc.heal_episode_healed", "rtc.heal_episode_result", "rtc.heal_episode_ms",
  "disconnected", "failed", "never_connected", "media_stall", "rejoin_offer", "peer_no_video", "negotiation_error", "network_change", "answer_timeout", "glare_rebuild",
  "ice_restart", "rebuild", "answer", "unseen", "negotiation_error/unseen",
  "disconnected:ice_restart", "disconnected:rebuild", "failed:rebuild", "never_connected:rebuild",
  "media_stall:ice_restart", "media_stall:rebuild", "rejoin_offer:answer", "rejoin_offer:rebuild",
  "peer_no_video:ice_restart", "peer_no_video:rebuild", "negotiation_error:rebuild", "negotiation_error/unseen:rebuild",
  "network_change:ice_restart", "network_change:rebuild", "answer_timeout:rebuild", "glare_rebuild:rebuild", "+2",
  // how an established link failed, and the near-simultaneous cohort (#944)
  "rtc.link.failed", "rtc.link.failed.kind", "rtc.link.failed.quiet_ms", "rtc.link.failed.up_ms", "rtc.link.failed.path",
  "rtc.link.failed.relay_protocol", "rtc.link.failed.relay_protocol_source", "rtc.link.failed.turn_host",
  "rtc.link.failed.page_hidden", "rtc.link.failed.since_net_change_ms", "torn-down", "timed-out", "mixed",
  "rtc.heal.cohort", "rtc.heal.cohort.size", "rtc.heal.cohort.window_ms", "rtc.heal.cohort.relay_protocol",
  "rtc.heal.cohort.turn_endpoint_host", "rtc.heal.cohort.fail_kind", "rtc.heal.cohort.unrecovered",
  "rtc.heal.cohort.page_hidden", "rtc.heal.cohort.since_net_change_ms", "rtc.heal.cohort.recovery_ms.1", "rtc.heal.cohort.quiet_ms.1",
  // a relay's protocol and where it was read (an iPhone's comes from the TURN url), and its TURN host
  "rtc.relay_protocol_source", "rtc.turn_host", "stats", "url", "tcp", "tls", "udp", "turn.cloudflare.com",
  // one terminal row for a peer's away period (Q2/Q13)
  "rtc.away_period", "rtc.away_reason", "rtc.away_return", "rtc.away_last_attempt", "rtc.away_attempts",
  "rtc.away_offerer", "rtc.away_offerer_role", "rtc.away_ms",
  "said", "timeout", "link_connected", "said_back", "statement_description", "session_rejoin",
  "offer_refused_rejoin", "own_absence_sweep", "heard_again", "peer_left", "mesh_closed",
  "none", "ice_restart", "rebuild", "yield", "stranded_offer", "answer", "self", "peer", "initiator", "answerer",
  // back from the background (#557)
  "rtc.resume_ms", "side", "self", "peer", "keyframe.method", "keyframe.verified", "active-toggle", "replace-track", "resume",
  // hard lane negotiation failures (#485)
  "rtc.negotiation_error", "rtc.error_name", "rtc.negotiation_stage", "rtc.negotiation_operation", "rtc.negotiation_reason",
  "InvalidAccessError", "InvalidStateError", "OperationError", "offer", "set-local", "set-remote", "ssrc-collision", "negotiation_error",
  // the sender's SPS (#629)
  "rtc.sps", "rtc.sps.poc_type", "rtc.sps.vui", "rtc.sps.restriction", "rtc.sps.reorder", "rtc.sps.dec_buf", "rtc.sps.num_ref", "rtc.sps.profile",
  "rtc.sps.constraints", "rtc.sps.level", "rtc.sps.complete", "rtc.sps.outcome", "rtc.sps.engine", "rtc.sps.mime", "rtc.sps.keyframe_request", "rtc.sps.frames", "rtc.sps.reason", "untapped", "pending", "no-worker", "not-ready", "worker-failed", "attach-threw", "post-failed",
  "rtc.sps.cost_ms", "rtc.sps.to_key_ms", "rtc.sps_tap", "sps", "no-sps", "not-h264", "no-key", "ended", "script", "encoded", "sent", "unsupported", "video/H264",
  // signalling health (#262)
  "rtc.signal_rtt_ms", "rtc.signal_via", "statement", "channel", "rtc.signal_problems", "rtc.signal_event", "rtc.signal_frame", "rtc.signal_reason",
  "rtc.signal_slot_wait_ms", "rtc.signal_replaced", "rtc.signal", "rtc.signal_error", "retry", "desc", "cand", "presence", "error", "rtc.stall_ms", "rtc.stall", "rtc.stall_reason",
  "rtc.last_error", "rtc.recovered_via", "self-heal", "reconnect-tapped",
  // the failure causes (#225)
  "timestamp-window", "bad-request", "proof-rejected", "redemption-limit", "no-ring-roots", "timeout", "proof-failed", "server-error", "no-route", "no-host", "no-chain-info", "no-accounts", "key-list-failed", "no-ring-key", "proof-refused", "proof-threw", "grant-missing", "timestamp outside the accepted window", "redemption limit reached",
  // network versus device (#263)
  "rtc.out_available_kbps", "rtc.jitter_buffer_ms", "rtc.decode_ms", "rtc.encode_ms", "rtc.frames_dropped", "rtc.nack", "rtc.pli", "rtc.direction", "in", "out",
  "rtc.codec", "rtc.codec_fmtp", "rtc.codec_from", "rtc.decoder_from", "rtc.decoder_change", "H264", "VP8", "codec", "rtc.encoder", "rtc.decoder", "rtc.encoder_efficient", "rtc.decoder_efficient", "OpenH264", "libvpx", "VideoToolbox",
  // decode load (#265)
  "rtc.decoding_streams", "rtc.decoded_pixels_per_s", "rtc.decode_load", "ok", "partial", "decode_load",
  // network changes (#264)
  "net.change", "net.changes", "net.event", "net.online", "net.type", "net.effective", "net.from_type", "net.from_effective", "net.connection",
  "online", "offline", "change", "[jollity-net] change wifi 4g -> cellular 3g", "[jollity-net] offline (connection unsupported)",
  "available_bitrate", "decode_time", "encode_time", "jitter_buffer", "nack_pli", "frames_dropped", "decoder", "encoder", "power_efficient",
  // the camera warm-up (#226)
  "camera.first_open_ms", "camera.attempts", "camera.late", "camera.retry", "camera.open", "camera.attempt", "camera.wait_ms",
  "camera-trail", "camera.event", "camera.no_frames", "camera.age_ms_at_join", "camera.first_frame_ms", "camera.self_fps", "camera.outbound_fps",
  "camera.reuse", "camera.reopen", "camera.stale_attachment", "camera.checkpoint", "camera.hidden_since_open", "camera.reason", "camera.limitation",
  "open.requested", "open.resolved", "open.failed", "stream.reused", "track.muted", "track.unmuted", "track.ended", "page.hidden", "page.shown", "page.frozen",
  "recover.started", "recover.done", "stream.release", "stream.stop", "self.attach", "self.play", "self.first_frame", "self.window", "self.no_frames", "self.detach", "camera.handover_summary",
  "outbound.video", "link", "frames_encoded", "frames_sent", "limitation", "track_id",
  "page_ms", "stream_id", "trigger", "warm-up", "join", "return", "force", "deferred", "open_ms", "ready_state", "muted", "enabled", "width", "height", "frame_rate", "device_id_hash",
  "visible", "reason", "owner", "grace_ms", "checkpoint", "attached_stream_id", "current_stream_id", "stale", "outcome", "error_name", "ready_state", "paused",
  "first_frame_ms", "frames", "elapsed_ms", "fps", "hidden_since_open", "age_ms", "old_stream_id", "new_stream_id", "frame", "no-frame", "open-failed", "resolved", "rejected",
  "first", "recovery", "attempts", "since_first_ms", "hidden",
  // low power mode and the device probe
  "on", "off", "done", "ui.probe_frame_ms", "ui.probe_frames", "probe.version", "probe.threshold_ms", "p95",
  "probe-no-verdict", "no-verdict", "no-frames", "probe.stage", "probe.attempts", "countdown", "late",
  // the name link and the names on the wheel (#456)
  "name-link-failed", "name_link.surface", "name_link.stage", "name_link.why", "name_link.lookup_reason", "name_link.already_linked", "name_link.store", "name_link.allowance", "name_link.allowance_answer",
  "name_link.paid_in", "name_link.sign_ms", "name_link.trigger", "background", "register", "name-pending", "name-preparing", "name-unowned", "unowned", "not-linked", "name-not-linked", "app", "chat", "setup", "skipped", "no-host", "no-username", "no-chain", "existing", "not-needed", "allocated",
  "not-allocated", "pgas", "native", "draw.name_lookup", "draw.name_lookup_ms", "name.outcome", "name.ticket", "winner", "named", "no-store", "no-note",
  "not-for-account", "no-holder", "no-dotns", "read-failed",
  "draw.name_shown", "draw.name_wait_ms", "draw.ticket_tap", "name.via", "name.shown", "name.error", "tap", "name", "fallback",
  "no-chain", "not-pinned", "chain-lost", "disconnected", "decode",
  // the game clock
  "clock.chain_gap_ms", "clock.correction_ms", "clock.peer_count", "clock.peer_offset_ms", "clock.offset_ms",
  "clock.peer_rtt_ms", "clock.peer_quorum_ms", "clock.peer_window_ms",
  "clock.check", "clock.result", "clock.via", "clock.window", "clock.method",
  "first-value", "first-change", "chain", "peer", "pregame", "late", "resume", "step",
  "few", "split", "held", "dead-band", "applied", "none", "jump",
  "clock ready", "clock chain check", "clock peer check", "clock peers", "clock correction", "clock corrected", "clock jumped",
  "clock peer check done", "handover offset", "peer clock reply dropped", "jollity_clock_sync_use_case", "rttMs", "quorumMs",
  "gapMs", "moveMs", "medianMs", "agree", "offsetMs", "fromMs", "toMs", "speed", "method", "window", "peers", "tiles-enter", "game",
  "game.tap_sent", "game.tap_received", "tap.tag", "tap.seq", "tap.accepted", "tap.receiver_round", "tap.turn", "tap.hidden", "tap.link",
  "shown", "already-accepted", "unaccept", "accept", "round-closed", "round-not-open", "no-round", "handed", "not-a-peer", "tap received",
]

describe("masking-safe vocabulary of the lanes", () => {
  it.each(LANE_WORDS.map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})

describe("masking-safe layer names", () => {
  // the health ladder's layers, packages/jollity-statement-core/src/health.ts `Layer`
  const LAYERS = ["internet", "turn-credentials", "store-write", "store-read", "signalling", "ice", "media", "camera", "device"]
  it.each(LAYERS.map((layer) => [layer]))("%s is sent under a masking-safe name", (layer) => {
    expect(isMaskSafe(layerName(layer))).toBe(true)
  })
  it("every mapped value passes the masking check", () => {
    for (const value of Object.values(LAYER_NAMES)) expect(isMaskSafe(value)).toBe(true)
  })
  it("maps turn-credentials to turn-issue", () => {
    expect(layerName("turn-credentials")).toBe("turn-issue")
    expect(layerName(null)).toBe("unknown")
  })
})

describe("masking-safe vote-trail vocabulary", () => {
  it.each(
    [
      "votes.taps", "votes.auto", "votes.turns", "report.person", "report.notperson", "report.auto_only",
      "report.ties", "report.unseen", "report.filed_by", "auto-confirm", "tap",
      "report.auto_confirm", "off-after-background", "report.outcome", "window-closed",
    ].map((word) => [word]),
  )("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})

describe("masking-safe reminder vocabulary", () => {
  it.each(
    [
      "reminder.ask", "register.blocked", "outcome", "surface", "app", "reason", "held", "asking", "unrecorded", "dropped",
      "starts-in-past", "ask-failed", "ask-asking", "reminders-denied", "chain-unread", "no-game-to-join",
      "reminder-unanswered", "permission-failed", "permission-timed-out",
    ].map((word) => [word]),
  )("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})
