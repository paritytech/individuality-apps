// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { HealEpisodeEvent } from "../webrtc/heal"

/** Typed scalar attributes for one rtc.heal_episode Logs record.
 *  `rtc.heal_steps_dropped` appears only when the episode outgrew the memory
 *  cap, so a row for a short episode is exactly what it was before the cap. */
export function healEpisodeAttributes(event: HealEpisodeEvent): Record<string, string | number | boolean> {
  return {
    "rtc.heal_ladder": event.ladder,
    "rtc.heal_steps": event.steps,
    ...(event.steps_dropped !== undefined ? { "rtc.heal_steps_dropped": event.steps_dropped } : {}),
    "rtc.heal_episode_healed": event.healed,
    "rtc.heal_end": event.end,
    "rtc.heal_episode_ms": event.ms,
  }
}
