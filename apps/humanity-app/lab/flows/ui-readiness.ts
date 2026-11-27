// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A transient UI contradiction must persist for the bound before it becomes a failure. */
export class UiReadiness {
  private since: number | undefined;
  constructor(private readonly timeoutMs = 15_000) {}
  observe(blocked: boolean, reason: string, now = Date.now()): void {
    if (!blocked) { this.since = undefined; return; }
    this.since ??= now;
    if (now - this.since >= this.timeoutMs) throw new Error(`${reason}; UI condition timed out after ${this.timeoutMs} ms`);
  }
}
