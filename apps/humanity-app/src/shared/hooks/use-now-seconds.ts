// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";

const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;
const HOUR_SECONDS = 60 * 60;

/** Wall-clock seconds, re-read on each minute boundary so countdowns stay
 *  honest. Every tick re-aligns to the next whole minute, so the displayed
 *  minute turns over with the clock instead of drifting behind a fixed
 *  interval — and nothing wakes the page in between.
 *
 *  Pass a target Unix timestamp to get second-boundary ticks instead while
 *  it is positive and at most one hour away, so the countdown shows live
 *  seconds. The cadence is re-decided from the clock on every tick, so the
 *  hook drops back to minute ticks the moment the target passes or is more
 *  than an hour out — no second-level wakeups lingering past the deadline. */
export function useNowSeconds(targetSeconds?: number): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const nowMs = Date.now();
      const remaining =
        targetSeconds == null ? undefined : targetSeconds - Math.floor(nowMs / 1000);
      const secondCadence = remaining != null && remaining > 0 && remaining <= HOUR_SECONDS;
      const delay = secondCadence
        ? SECOND_MS - (nowMs % SECOND_MS)
        : MINUTE_MS - (nowMs % MINUTE_MS);
      timer = window.setTimeout(() => {
        setNow(Math.floor(Date.now() / 1000));
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [targetSeconds]);
  return now;
}
