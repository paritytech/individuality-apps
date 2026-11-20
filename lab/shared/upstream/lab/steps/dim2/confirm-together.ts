// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

/**
 * DIM2's pallet leaves Reporting as soon as every attendance is decided (#596), so in a three-player game two reports in
 * one block can close the window, and a third report one block behind is shut out (22 October 2026: old-1 and old-2).
 * The players of one game therefore confirm together: each play loop arms its Confirm (every tile turned, the button
 * enabled), waits here until every player still playing has armed, and then presses at once.
 *
 * Only a player whose DIM2 auto-confirm is running ("Confirming in N") waits. DIM2 files that report itself, 7 s after
 * its confirm stage opened and before report_ends (its own last call), so the wait can pull the press earlier but never
 * delay the report. A player that must confirm by hand ("Confirm votes": the auto-confirm is off, e.g. after the page was
 * in the background) or retry ("Vote didn't send") presses at once and counts as armed (`pressing`), so no wait of the
 * lab's can carry a report past report_ends.
 */
export const CONFIRM_HOLD_MS = 15_000;

export interface ConfirmRelease {
  /** Milliseconds this player waited after arming. */
  readonly waitedMs: number;
  /** How many of the game's players had armed when it was released, and how many were still playing. */
  readonly armed: number;
  readonly playing: number;
  /** "every player armed", "the others left the confirm stage" or "the hold ran out". */
  readonly why: string;
}

export interface ConfirmSeat {
  /** Resolves once every player still playing has armed, or `holdMs` after the first arm. */
  armed(signal: AbortSignal): Promise<ConfirmRelease>;
  /** Armed and pressing at once, without waiting: the others no longer wait for this player. */
  pressing(): ConfirmRelease;
  /** The player has left the game (its loop ended, failed or was stopped): the others no longer wait for it. */
  leave(): void;
}

export class ConfirmTogether {
  private readonly playing = new Set<string>();
  private readonly armedPlayers = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private released: { why: string; armed: number; playing: number } | undefined;
  private hold: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly holdMs = CONFIRM_HOLD_MS, private readonly now: () => number = Date.now) {}

  join(player: string): ConfirmSeat {
    this.playing.add(player);
    return {
      armed: (signal) => this.arm(player, signal),
      pressing: () => {
        this.armedPlayers.add(player);
        this.check();
        return { waitedMs: 0, armed: this.armedPlayers.size, playing: this.playing.size, why: "pressed at once (DIM2's auto-confirm is off)" };
      },
      leave: () => this.leave(player),
    };
  }

  private arm(player: string, signal: AbortSignal): Promise<ConfirmRelease> {
    signal.throwIfAborted();
    const armedAt = this.now();
    this.armedPlayers.add(player);
    this.hold ??= setTimeout(() => this.release("the hold ran out"), this.holdMs);
    this.check();
    return new Promise<ConfirmRelease>((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", stopped);
        this.waiters.delete(done);
        resolve({ waitedMs: this.now() - armedAt, ...this.released! });
      };
      const stopped = () => {
        this.waiters.delete(done);
        reject(signal.reason);
      };
      if (this.released) return done();
      this.waiters.add(done);
      signal.addEventListener("abort", stopped, { once: true });
    });
  }

  private leave(player: string): void {
    this.playing.delete(player);
    this.armedPlayers.delete(player);
    if (this.armedPlayers.size > 0) this.check("the others left the confirm stage");
  }

  private check(why = "every player armed"): void {
    if (this.released || this.armedPlayers.size === 0) return;
    if ([...this.playing].every((player) => this.armedPlayers.has(player))) this.release(why);
  }

  private release(why: string): void {
    if (this.released) return;
    clearTimeout(this.hold);
    this.released = { why, armed: this.armedPlayers.size, playing: this.playing.size };
    for (const waiter of [...this.waiters]) waiter();
  }
}
