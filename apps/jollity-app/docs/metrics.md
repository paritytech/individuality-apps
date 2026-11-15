# Jollity metrics

The app sends numbers that a dashboard aggregates (p50, p95, avg, count) as
Sentry trace metrics. This page lists every metric name the app emits, its
kind, unit and attributes, and the file that emits it. Events, logs and
spans are described in the repository's `docs/telemetry.md`.

## How metrics are sent

- **Only with a Sentry DSN.** Every point goes through
  `lib/telemetry/metrics.ts` (`recordCount`, `recordDistribution`,
  `recordGauge`). Without a configured DSN, telemetry never starts and every
  call is a no-op. A call never throws.
- **One unit per name.** Sentry's unit-typed aggregates filter by unit, so a
  name is always sent with the same unit. Counters carry no unit.
- **Scope tags on every point.** The SDK copies `user.id` and `user.name`
  from the scope (the player's own account and display name, when known),
  but not the scope's tags. `metrics.ts` copies the tags listed in
  `lib/telemetry/scope-tags.ts` (`SCOPE_TAGS`: product, host and device
  details, network type, low-power state, `game.index`, `session.id`,
  `test.tag`, the WebRTC codec capabilities and `rtc.sps_tap`) onto every
  point. A tag nobody set is left out.
- **Delivery.** `@sentry/core` 11.x buffers points per client and sends them
  as one `trace_metric` envelope every 5 s (the timer starts with the first
  point after a flush), at 1000 points, on `Sentry.flush`, or when the page
  turns hidden. The envelope goes through the app's retrying transport queue
  (`lib/telemetry/queue.ts`). There is no per-name aggregation on the device.
- **Values are numbers, attributes are strings.** Attributes are for
  filtering and grouping only.

## Which attributes identify a link

A link is the WebRTC connection between this device and one co-player.

- `rtc.peer` is the co-player's index in this game, as this device numbers
  its co-players. It is never an account. The other end numbers the players
  differently, so `rtc.peer` alone cannot join the two ends of a link.
- `rtc.pair` is `g<game>:r<round>:<12 hex>`. The hex part is a short blake2b
  hash of the game index and the two players' accounts (sorted), so both ends
  compute the same id without either account being sent. Anyone who knows a
  game's roster (which is public on chain) can recompute the hash for every
  pair of players in that game and so tell which two accounts a pair id
  belongs to.
- `round` is the 1-based round.

Points marked **link** below carry `rtc.pair`, `rtc.peer` and `round` (some
also `rtc.role`: `initiator` or `answerer`). Points marked **round summary**
carry the link attributes plus the link's path and codec:
`rtc.path`, `rtc.relay_protocol` (on a relay), `rtc.encoder`, `rtc.decoder`,
`rtc.encoder_efficient`, `rtc.decoder_efficient`, `rtc.encoder_kind`,
`rtc.decoder_kind` (hardware or software), `rtc.codec`, `rtc.codec_fmtp`,
`rtc.codec_in`, `rtc.codec_in_fmtp`, `rtc.codec_out` and `rtc.codec_out_fmtp`
(`unsupported` where the browser reports nothing). `game.tap_sent` and
`game.tap_received` carry `rtc.pair` too.

A browser that never reports a statistic all round (iOS WebKit reports fewer
than Chromium) sends no point for it; the round's span names the missing
category in `rtc.unsupported` instead of sending a misleading 0.

## WebRTC: per peer and round

Sent when a round closes, one set per co-player, from
`lib/journeys/rtc-quality.ts`. `stat` names the percentile over the round's
3 s stats readings.

| Name | Kind | Unit | Attributes | Meaning |
| :-- | :-- | :-- | :-- | :-- |
| `rtc.rtt_ms` | distribution | millisecond | round summary, `stat` p50, p95 | Round-trip time. |
| `rtc.loss_pct` | distribution | percent | round summary, `stat` p50, p95 | Inbound packet loss. |
| `rtc.jitter_ms` | distribution | millisecond | round summary, `stat` p50, p95 | Inbound jitter. |
| `rtc.jitter_buffer_ms` | distribution | millisecond | round summary, `stat` p50, p95 | Jitter-buffer delay per frame. |
| `rtc.decode_ms` | distribution | millisecond | round summary, `stat` p50, p95 | Decode time per frame. |
| `rtc.encode_ms` | distribution | millisecond | round summary, `stat` p50, p95 | Encode time per frame. |
| `rtc.in_fps`, `rtc.out_fps` | distribution | none | round summary, `stat` p50 | Frames per second received and sent. A paused peer's windows are left out. |
| `rtc.in_height`, `rtc.out_height` | distribution | none | round summary, `stat` p50 | Video height received and sent. |
| `rtc.out_kbps` | distribution | none | round summary, `stat` p50 | Outgoing video bitrate, kbit/s. |
| `rtc.out_available_kbps` | distribution | none | round summary, `stat` p50 | The browser's estimate of available outgoing bitrate, kbit/s. |
| `rtc.freeze_ms` | distribution | millisecond | round summary, `stat` total | Inbound video freeze time. Sent only when above 0. |
| `rtc.peer_paused` | counter | | round summary | Seconds the peer's video was paused (phone locked). The value is seconds. Sent only when above 0. |
| `rtc.frames_dropped` | counter | | round summary | Frames dropped. Sent only when above 0. |
| `rtc.nack`, `rtc.pli` | counter | | round summary, `rtc.direction` in, out | NACKs and picture-loss indications. Sent only when above 0. |
| `rtc.quality_limited` | counter | | round summary, `reason` | One per reason the encoder was limited by (cpu, bandwidth, other). |
| `rtc.quality_limited_s` | distribution | second | round summary, `reason`, `stat` total | Seconds the encoder was limited, per reason. |
| `rtc.path_changes` | counter | | round summary | Times the selected candidate pair changed. Sent only when above 0. |
| `rtc.coverage_s` | distribution | second | round summary | Seconds of the round with live inbound video: the link was connected and frames decoded. 0 included. |
| `rtc.coverage_pct` | distribution | percent | round summary | The same, as a share of the round. |
| `rtc.link` | counter | | round summary, `rtc.role`, `rtc.outcome`, `rtc.last_stage`, `rtc.seen`, `rtc.rtx`, `rtc.red`, `rtc.ulpfec`, `rtc.flexfec`, `rtc.rebuilds` | The link row: one per peer per round, also for a link that never connected. `rtc.outcome` is `video`, `connected-no-video`, `connected-unmeasured`, `not-connected` or `standby`. `rtc.rebuilds` is 0, 1, 2 or `3+`. Built in `lib/journeys/rtc-link.ts`. |
| `rtc.link.ttff_ms` | distribution | millisecond | as `rtc.link` | First offer to first frame. |
| `rtc.link.freeze_ms` | distribution | millisecond | as `rtc.link` | Inbound freeze time, 0 included. Not sent for a link with no frame counter. |
| `rtc.link.path_ms` | distribution | millisecond | round summary, with the `rtc.path` and `rtc.relay_protocol` of that path | Connected time on one path, one point per path the link used in the round. |
| `rtc.video_ms` | distribution | millisecond | `round`, `rtc.peer`, `rtc.pair` | Reload-safe slice: time with live inbound video since the last slice. Sent from the first stats poll after 10 s, at the round's end and when the page hides. |
| `rtc.present_ms` | distribution | millisecond | `round`, `rtc.peer`, `rtc.pair` | Reload-safe slice: time the peer was in the room since the last slice. |
| `rtc.decoding_streams` | distribution | none | `round`, `stat` p50, p95, `rtc.decode_load` ok, unsupported | Device-wide, once per round: video streams decoding at the same time. |
| `rtc.decoded_pixels_per_s` | distribution | none | `round`, `stat` p50, p95, `rtc.decode_load` ok, partial | Device-wide, once per round: width × height × fps summed over decoding streams. Not sent when no stream size or rate is known. |

## WebRTC: link events

Sent as they happen, from `lib/journeys/game-trace.ts` and the helpers it
calls in `lib/journeys/`.

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `rtc.funnel_ms` | distribution | millisecond | link, `rtc.role`, `stage`, `rtc.standby` | Time from the mesh opening to a connection stage: `offer`, `answer`, `ice_checking`, `connected`, `first_frame`. One point per stage reached, from each end. | `rtc-funnel.ts` |
| `rtc.candidates` | distribution | none | link, `rtc.candidate_type` host, srflx, relay, other | Local ICE candidates of one type in a gathering, 0 included. | `rtc-gather.ts` |
| `rtc.gather_ms` | distribution | millisecond | link | Duration of a completed ICE gathering. | `rtc-gather.ts` |
| `rtc.ice_errors` | counter | | link, `rtc.error_code`, `rtc.error_host` | ICE candidate errors of a gathering. `rtc.error_host` is the STUN or TURN server's host name, never a URL or a player's address. 701 means the server could not be reached. | `rtc-gather.ts` |
| `rtc.heal_ms` | distribution | millisecond | link, `rtc.heal_trigger`, `rtc.heal_action`, `rtc.heal_detail`, `rtc.heal_attempt`, `rtc.healed`, `rtc.heal_end` | One recovery attempt (ICE restart or rebuild), from its start to its end, healed or not. | `rtc-heal.ts` |
| `rtc.heal_episode_ms` | distribution | millisecond | link, `rtc.heal_episode_result` healed, unhealed, `rtc.heal_end` | A whole recovery episode, all attempts included. | `game-trace.ts` |
| `rtc.away_ms` | distribution | millisecond | link | How long a co-player was away (backgrounded or link down). | `game-trace.ts` |
| `rtc.resume_ms` | distribution | millisecond | link, `side` self, peer, `keyframe.method`, `keyframe.verified` | From a return from the background (this phone, or the co-player's away flag clearing) to the link's next decoded frame. | `rtc-quality.ts` |
| `rtc.stall_ms` | distribution | millisecond | `round`, `rtc.layer`, `rtc.recovered_via` | How long a connection stall of the health ladder lasted. | `rtc-stall.ts` |
| `rtc.negotiation_error` | counter | | link, `rtc.error_name`, `rtc.negotiation_stage`, `rtc.negotiation_operation`, `rtc.negotiation_reason` | A hard SDP failure on the data-channel renegotiation lane. | `game-trace.ts` |
| `rtc.codec_guard` | counter | | link, `rtc.codec_guard_reason` | An engine that must not send RTX, whose codec preferences did not hold (#559). | `game-trace.ts` |
| `rtc.impl_change` | counter | | link, `rtc.direction`, `rtc.impl_from`, `rtc.impl`, their kinds, `rtc.codec_from`, `rtc.codec` | A decoder, encoder, its hardware or software kind, or a direction's codec changed mid-call. | `game-trace.ts` |
| `rtc.sps` | counter | | link, `rtc.sps.outcome`, `rtc.sps.engine`, `rtc.sps.mime`, `rtc.sps.keyframe_request`, `rtc.sps.reason`, the parsed SPS fields | One SPS tap result per link (sampled sessions only, see `lib/webrtc/sps-tap.ts`). | `game-trace.ts`, `rtc-sps.ts` |
| `rtc.sps.cost_ms` | distribution | millisecond | link, `rtc.sps.engine`, `rtc.sps.outcome` | Main-thread and worker time the tap cost. Not sent for an untapped link. | `game-trace.ts` |
| `rtc.sps.to_key_ms` | distribution | millisecond | as `rtc.sps.cost_ms` | Time to the first key frame the tap saw. | `game-trace.ts` |
| `rtc.sps.frames` | distribution | none | as `rtc.sps.cost_ms` | Frames the tap inspected. | `game-trace.ts` |
| `rtc.turn_ttl_left_s` | distribution | second | `turn.received` true, cached, `round` | Seconds left on the TURN credentials a mesh opened with. | `turn-outcome.ts` |

## WebRTC: signalling over the statement store

From `lib/journeys/rtc-signal.ts`. The events come from the statement-store
transport's submit hook, which carries no frame contents.

| Name | Kind | Unit | Attributes | Meaning |
| :-- | :-- | :-- | :-- | :-- |
| `rtc.signal_rtt_ms` | distribution | millisecond | link, `rtc.role`, `rtc.signal_via` statement, channel, `rtc.signal_peer_present` | Offer sent to answer received, on one device's monotonic clock. `rtc.signal_peer_present` is false when the peer had not been heard from when the offer went out; filter on true for signalling health. |
| `rtc.signal_rtt_from_seen_ms` | distribution | millisecond | as above | For an offer to an absent peer: from the peer's first frame after the offer to its answer. |
| `rtc.signal_problems` | counter | | `rtc.signal_event` retry, failed, `rtc.signal_frame` desc, cand, presence, `rtc.signal_reason` timeout, error; link when the frame was for one peer, else `round` | A statement submit that backed off or gave up. A retry is always `error`. |
| `rtc.signal_slot_wait_ms` | distribution | millisecond | `rtc.signal_frame`; link or `round` | A frame's wait for a free submit slot (backpressure). |
| `rtc.signal_replaced` | counter | | `rtc.signal_frame`; link or `round` | A frame that waited for its channel and was replaced by a newer one before it was sent. |
| `rtc.store_margin_ms` | distribution | millisecond | `rtc.store_base` chain, device | The statement-store clock's acceptance margin, learned after a re-stamp was accepted. |
| `rtc.store_time_rejected` | counter | | `rtc.store_base` | A statement rejected for its time on both stamps. |
| `rtc.store_calibration` | counter | | `rtc.store_outcome` accepted, learned, rejected, failed | One waiting-room calibration of the store clock. |
| `rtc.store_calibration_ms` | distribution | millisecond | `rtc.store_outcome` | That calibration's duration. |
| `rtc.store_calibration_margin_ms` | distribution | millisecond | `rtc.store_outcome` | The margin after that calibration. |
| `rtc.store_interrupted` | counter | | `rtc.store_reason` | The host ended the room's statement subscription. |
| `rtc.store_resubscribe` | counter | | `rtc.store_attempt` | The subscription was opened again after that. |

## WebRTC: other

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `rtc.return_local_candidates` | distribution | none | `app.screen`, `game.stage`, `app.reloaded` | Local ICE candidates gathered in the 5 s after a long return from the background. | `lib/resume-reload.ts` |
| `turn.durable_wait_ms` | distribution | millisecond | `turn.durable_result` hit, miss, error, timeout, none | Time spent waiting for TURN credentials stored by an earlier page before asking for new ones. | `lib/webrtc/ice.ts` |
| `net.changes` | counter | | `net.event`, `net.type` | The page went online or offline, or its connection changed. | `lib/journeys/game-trace.ts` |

## Camera

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `camera.first_open_ms` | distribution | millisecond | `camera.attempts`, `camera.late` | From the page's first camera open attempt to its first live camera. | `lib/camera.ts` |
| `camera.retry` | counter | | `camera.open` first, recovery, `camera.reason`, `camera.attempt`, `camera.wait_ms`, `camera.trigger` | One scheduled camera retry. | `lib/camera.ts` |
| `camera.reopen` | counter | | `camera.reason` no-frames, `camera.checkpoint` | The camera was reopened because it delivered no frames. | `lib/camera.ts` |
| `camera.reopen_blocked` | counter | | `camera.reason` budget, `camera.checkpoint` | A reopen was skipped because the reopen budget was spent. | `lib/camera.ts` |
| `camera.reuse` | counter | | | The game reused the camera stream opened earlier. | `lib/camera-diagnostics.ts` |
| `camera.age_ms_at_join` | distribution | millisecond | | Age of the camera stream when the game took it. | `lib/camera-diagnostics.ts` |
| `camera.stale_attachment` | counter | | `camera.checkpoint` | The self view showed a stream other than the current one. | `lib/camera-diagnostics.ts` |
| `camera.first_frame_ms` | distribution | millisecond | `camera.checkpoint` | Time to the self view's first frame. | `lib/camera-diagnostics.ts` |
| `camera.self_fps` | gauge | none | `camera.checkpoint` | Frame rate of the self view. | `lib/camera-diagnostics.ts` |
| `camera.no_frames` | counter | | `camera.checkpoint`, `camera.hidden_since_open` | The camera delivered no frames. | `lib/camera-diagnostics.ts` |
| `camera.outbound_fps` | gauge | none | `camera.limitation` | Frame rate actually sent to a peer. | `lib/camera-diagnostics.ts` |
| `video.play_refused` | counter | | | The browser refused to play a video element; it stays hidden until the next tap. | `lib/video-playback.ts` |

## Rendering and the device probe

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `ui.frame_ms` | distribution | millisecond | `scene` (game.round, game.confirm, chest, draw.wheel, waiting), `stat` p50, p95 | Frame interval while a scene was on screen. | `lib/telemetry/smoothness.ts` |
| `ui.slow_frame_pct` | gauge | percent | `scene` | Share of slow frames in that scene. | `lib/telemetry/smoothness.ts` |
| `ui.long_task_ms` | distribution | millisecond | `scene`, `stat` p95, max | Main-thread long tasks (Chromium only). | `lib/telemetry/smoothness.ts` |
| `ui.long_tasks` | counter | | `scene` | Number of long tasks. | `lib/telemetry/smoothness.ts` |
| `ui.moment_frame_ms` | distribution | millisecond | `moment` (intro, play, turned, warn, ending, gap), `stat` avg, max | Frame interval during one part of a round. | `lib/telemetry/smoothness.ts` |
| `ui.js_heap_mb` | gauge | none | | JavaScript heap in MB, where the browser reports it (Chromium). | `lib/telemetry/smoothness.ts` |
| `ui.probe_frame_ms` | distribution | millisecond | `stat` p95, `probe.version`, `probe.rule`, `probe.stage`, `probe.attempts`, `probe.samples`, `probe.borderline_from_ms`, `probe.weak_from_ms` | The device probe's deciding sample, p95 frame time. One point per device. | `lib/device-probe.ts` |
| `ui.probe_frame_median_ms` | distribution | millisecond | as `ui.probe_frame_ms` without `stat` | Median frame time of that sample. | `lib/device-probe.ts` |
| `ui.probe_frames` | distribution | none | as above | Frames in that sample. | `lib/device-probe.ts` |
| `ui.probe_sample_ms` | distribution | millisecond | as `ui.probe_frame_ms`, `probe.sample` | p95 frame time of each probe sample. | `lib/device-probe.ts` |
| `ui.probe_sample_frames` | distribution | none | as above without `stat` | Frames of each probe sample. | `lib/device-probe.ts` |

## App lifecycle

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `app.away_ms` | distribution | millisecond | `app.screen`, `app.screen.from`, `game.stage`, `game.stage.from`, `app.suspended`, `play.started`, `app.return_source`, `notification.moment` | One measured return to the foreground. | `lib/telemetry/foreground.ts` |
| `app.resumed` | counter | | as `app.away_ms` | Every measured foreground return. | `lib/telemetry/foreground.ts` |
| `app.opened_from_notification` | counter | | as `app.away_ms` without the `.from` attributes | An open from a reminder with no measured absence. | `lib/telemetry/foreground.ts` |
| `app.long_return` | counter | | `app.screen`, `game.stage`, `app.reloaded`, `app.suspended` | A return after at least 60 s away. | `lib/resume-reload.ts` |
| `app.long_return_ms` | distribution | millisecond | as `app.long_return` | Duration of that absence. | `lib/resume-reload.ts` |
| `app.self_reload` | counter | | `app.reload_reason`, `app.screen`, `game.stage` | The app reloaded itself. | `lib/self-reload.ts` |
| `app.self_reload_away_ms` | distribution | millisecond | as `app.self_reload` | The absence that caused a self-reload. | `lib/self-reload.ts` |
| `app.self_reload_suppressed` | counter | | as `app.self_reload` | A self-reload refused by the rolling cap, or because its budget could not be stored. | `lib/self-reload.ts` |
| `app.front_door_held` | counter | | `app.route` | A page load that landed past the home page was sent home first. | `components/front-door.tsx` |
| `app.previous_end` | counter | | `previous.end`, `previous.in_game` | How the previous page session ended, read at the next open. | `lib/telemetry/index.ts` |
| `build.check_retries` | counter | | `build.stale` | Extra attempts the stale-build check needed for a definite answer. | `lib/release/use-stale-build.ts` |
| `chat.worker.heartbeat` | counter | | `worker.status`, `worker.release`, `worker.expected_release` | One verdict per app open on the chat worker's heartbeat. | `lib/telemetry/index.ts` |
| `chat.worker.heartbeat_age_ms` | distribution | millisecond | as above | Age of the heartbeat, when it could be read. | `lib/telemetry/index.ts` |

## Chain, sign-up and the game clock

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `chain.health` | distribution | millisecond | `chain.health.where`, `chain.health.outcome`, `chain.health.error_class` | Latency of each chain health probe. | `lib/game-source.ts` |
| `chain.health` | counter | | `chain.health.where`, `chain.health.outcome` | One per probe that was not healthy. Sent under the same name as the distribution above; filter by metric type. | `lib/telemetry/index.ts` |
| `chain.retries` | counter | | `chain.retry_reason`, `chain.retry_operation`, `chain.retry_succeeded` | One recovery from a block that was no longer pinned, or from an interrupted host read. | `lib/chain-retry.ts` |
| `chain.reconnecting_shown` | counter | | `chain.health.where`, `chain.reconnecting_reason` | The "reconnecting" notice was shown. | `lib/use-reconnect-window.ts` |
| `chain.reconnecting_escalated` | counter | | as above | The notice escalated to the restart advice. | `lib/use-reconnect-window.ts` |
| `chain.reconnecting_recovered_ms` | distribution | millisecond | as above | Time from the notice to recovery without a restart. | `lib/use-reconnect-window.ts` |
| `chain.restart_card_shown`, `chain.restart_bar_shown` | counter | | `chain.health.where` | The blocking restart card, or the in-game restart bar, was shown. | `lib/chain-restart.ts` |
| `chain.restart_card_next_probe` | counter | | `chain.health.where`, `chain.restart_card_next_probe` true, false | The first probe after a restart card: whether the chain was healthy. | `lib/chain-restart.ts` |
| `chain.restart_card_visible_ms` | distribution | millisecond | `chain.health.where` | How long a restart card stayed up before a healthy probe cleared it. | `lib/chain-restart.ts` |
| `registration.finalized_lag_ms` | distribution | millisecond | | From seeing a game's registration on the best block to seeing it finalized. | `lib/game-source.ts` |
| `register.blocked` | counter | | `reason`, `surface` app | A sign-up held back until the host granted a game reminder. | `lib/game-source.ts` |
| `reminder.ask` | counter | | `outcome`, `surface` app | The host's answer to a game-reminder request. | `lib/telemetry/index.ts` |
| `signup.retries` | counter | | `signup.retry_reason` | A sign-up attempt that will be retried. | `@individuality/sign-up` via `lib/game-source.ts` |
| `signup.error_surfaced` | counter | | `signup.retry_reason` | A sign-up error shown to the player. | as above |
| `signup.window_check_timeout` | counter | | `signup.retry_reason` | The registration-window read timed out and was treated as open. | as above |
| `signup.landed_ms` | distribution | millisecond | `signup.attempt` | Time for a sign-up to land on chain. | as above |
| `signup.opening_push` | counter | | `outcome` | Whether the game-opening push the chat worker booked was cancelled after a sign-up from the app. | `lib/host/game-registration.ts` |
| `claim.retries` | counter | | `claim.retry_attempt` | A prize claim sent again. | `lib/game-source.ts` |
| `clock.chain_gap_ms` | distribution | millisecond | `clock.check` first-value, first-change | Device time minus block time at a chain check. It moves nothing. | `lib/game-source.ts` |
| `clock.correction_ms` | distribution | millisecond | `clock.via` peer | Each peer-driven move of the game clock's target, signed. | `lib/game-source.ts` |
| `clock.peer_count` | distribution | none | `clock.window` pregame, late, resume, step, `clock.result` few, split, held, dead-band, applied | Peers that answered a clock check window. | `lib/game-source.ts` |
| `clock.peer_offset_ms` | distribution | millisecond | as `clock.peer_count` | Median offset of those peers. | `lib/game-source.ts` |
| `clock.peer_rtt_ms` | distribution | millisecond | `clock.window` | Round trip of each peer's kept reply. | `lib/game-source.ts` |
| `clock.peer_quorum_ms` | distribution | millisecond | `clock.window` | From the window opening to its first usable verdict. | `lib/game-source.ts` |
| `clock.peer_window_ms` | distribution | millisecond | as `clock.peer_count` | From the window opening to its close. | `lib/game-source.ts` |
| `clock.offset_ms` | distribution | millisecond | `clock.window`, `clock.method` none, peer | The game clock's offset when a window closed. | `lib/game-source.ts` |

## Game, report, draw and chest

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `game.tap_sent` | counter | | `round`, `rtc.pair`, `outcome`, `tap.tag`, `tap.seq`, `tap.turn`, `tap.link` | One verdict tap cast on a co-player. | `lib/tap-receipt.ts` |
| `game.tap_received` | counter | | `round`, `rtc.pair`, `outcome`, `tap.tag`, `tap.seq`, `tap.turn`, `tap.accepted`, `tap.receiver_round`, `tap.hidden` | One co-player tap that arrived. The sent and received rows of one tap share `rtc.pair`, `tap.tag` and `tap.seq`. | `lib/tap-receipt.ts` |
| `game.unseen_to_coplayer_ms` | distribution | millisecond | `round`, `turn` | From the game's start to a co-player's first presented frame. | `lib/game-session.ts` |
| `game.recap_coplayer`, `game.recap_unseen` | counter | | | On the confirm screen: co-players this device saw on video, and those it never did. | `lib/game-session.ts` |
| `turn.skipped_cold` | counter | | | Turns sealed without votes because the page loaded while the clock was still settling. | `lib/turn-books.ts` via `lib/game-session.ts` |
| `report.retries` | counter | | `report.retry_attempt` | A report submission sent again. | `lib/game-session.ts` |
| `report.no_video_choice` | counter | | `choice`, `ever_flipped` | The verdict filed for each co-player this device never saw on video. | `lib/journeys/game-trace.ts` |
| `draw.name_lookup` | counter | | `name.outcome`, `name.ticket` winner, other, `name.error` | One chain read of a prize-draw ticket's name. | `lib/draw/draw-name-lookup.ts` |
| `draw.name_lookup_ms` | distribution | millisecond | as `draw.name_lookup` | That read's duration. | `lib/draw/draw-name-lookup.ts` |
| `chest.recovery_ms` | distribution | millisecond | | A chest read that failed and then opened on a later read: time to recovery. | `lib/journeys/game-trace.ts` |

## Telemetry health, storage and failures

| Name | Kind | Unit | Attributes | Meaning | Source |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `failure` | counter | | `failure.kind`, `failure.reason`, `journey.expected` | One reported failure that is not an actionable error event (the matching log carries the detail). Also sent for an unclean exit mid-game, read at the next open. | `lib/telemetry/failures.ts`, `lib/telemetry/index.ts` |
| `invariant` | counter | | `invariant.kind` | A runtime invariant was broken (the detail rides a log). | `lib/invariants.ts` |
| `invariant.value_ms` | gauge | millisecond | `invariant.kind` | The measured value of that invariant, when it has one. | `lib/invariants.ts` |
| `storage.slow` | counter | | `storage.op` | A host-storage read or write that was slow. | `lib/telemetry/index.ts` |
| `game_log.storage_fallback` | counter | | `game_log.storage` | The game-log outbox could not use localStorage and kept parts in memory. | `lib/telemetry/game-log-outbox.ts` |
