// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Throttled vibration haptics. */

let lastBuzz = 0;

export function buzz(pattern: number | number[], minGap = 50): void {
  const now = performance.now();
  if (now - lastBuzz < minGap) return;
  lastBuzz = now;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* vibration unsupported */
  }
}
