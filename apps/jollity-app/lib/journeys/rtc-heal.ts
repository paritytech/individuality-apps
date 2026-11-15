// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SELF-HEAL AS TELEMETRY (lib/webrtc/heal.ts has the attempts): one
 * `rtc.heal_ms` point per finished attempt, healed or not, in ms from the
 * attempt starting. Success rate = count where `rtc.healed` is "true" over
 * count; time to recover = p50/p95 of the healed points. Its attributes name
 * the trigger (`rtc.heal_trigger`), what was done (`rtc.heal_action`: an ICE
 * restart, a rebuild, or answering a rejoin offer), the attempt number, the
 * outcome and how it ended (`rtc.healed`, `rtc.heal_end`). The same attributes
 * go on an `rtc.heal` step, whose span runs from the attempt's start to its end.
 */
import { recordDistribution } from "../telemetry"
import type { HealEvent } from "../webrtc/heal"

export function healAttrs(event: HealEvent): Record<string, string> {
  return {
    "rtc.heal_trigger": event.trigger,
    "rtc.heal_action": event.action,
    ...(event.detail ? { "rtc.heal_detail": event.detail } : {}),
    "rtc.heal_attempt": String(event.attempt),
    "rtc.healed": String(event.healed),
    "rtc.heal_end": event.end,
  }
}

/** `attrs` are the link's: pair, peer index, round */
export function recordHeal(event: HealEvent, attrs: Record<string, string>): void {
  recordDistribution("rtc.heal_ms", event.healMs, "millisecond", { ...healAttrs(event), ...attrs })
}
