// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

const owners = new WeakMap<object, { count: number; original: Console["log"] }>()

/** Silence console.log while a mesh-pair search runs, and return the restore.
 *  Mesh logs every rtc event to the console (rtcLog); in a vitest worker each
 *  call is serialised to the parent over IPC (about a tenth of the search's
 *  CPU), and the parent keeps every line on the test's logs until the run ends
 *  (gigabytes on a long run). devLog still records them, so the room's
 *  log-entry count is unchanged. Only log leaks; info, debug, warn and error
 *  stay, for the explorer's own warnings (progress lines go through writeSync).
 *  Plain assignment, not a spy: a mock would keep every call.
 *
 *  Overlap-safe: the first silence on a target saves the original and installs
 *  the no-op; each restore is idempotent, and the original goes back only when
 *  the last outstanding silence is restored, in whatever order. */
export function silenceConsoleLog(target: Pick<Console, "log"> = console): () => void {
  let owner = owners.get(target)
  if (owner === undefined) {
    owner = { count: 0, original: target.log }
    owners.set(target, owner)
    target.log = () => undefined
  }
  owner.count++
  const held = owner
  let released = false
  return () => {
    if (released) return
    released = true
    if (--held.count === 0) {
      target.log = held.original
      owners.delete(target)
    }
  }
}
