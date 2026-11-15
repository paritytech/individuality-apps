// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE NAME GATE (#456): the player's username linked to the account that holds
 * their draw tickets before Register signs anything. Every surface that signs
 * a player up runs the same gate, each with its own link (`linkName` of
 * ./link.ts, and what only that surface can reach).
 *
 * The rule:
 *  - A SIGN-UP NEVER GOES WITHOUT IT;
 *  - one link at a time, asked for whenever a game is open or scheduled, and
 *    again on the ladder (`retryDelay`) after any link that did not end
 *    linked; a Register tap that waits on it asks at once, past the ladder;
 *  - a link that runs out of time (NAME_LINK_TIMEOUT_MS) starts no further
 *    step, and the next link waits until it has returned, or for
 *    NAME_LINK_GRACE_MS at most;
 *  - `ready` on the link's own word, read at the best block (`linked`,
 *    `already-linked`);
 *  - a link that ends `unowned` (the People chain says nobody owns the
 *    username) holds the gate for NAME_UNOWNED_RETRY_MS: no `request` and no
 *    `clearRetry` starts a link before then, and then one background link
 *    checks again (#1115). Only the player ends it sooner (`recheck`: a chat
 *    tap, a return to the page), at most once per NAME_UNOWNED_RECHECK_MS. A
 *    new gate (a reopened app, a new worker) checks at once.
 *
 * A tap waits at most NAME_TAP_WAIT_MS (`inPlace`): a chat card cannot stay
 * busy for the whole registration window, so its sign-up then ends with a
 * notice to try again, signing nothing, while the link goes on in the
 * background.
 *
 * The state is the gate's: a new one asks again, and a name already linked
 * answers `already-linked` from the link's first read.
 */
import type { LinkOutcome } from "./link"

/** How a link ended: `linkName`'s outcome, or `skipped` when there was nothing to link with. */
export type NameLinkResult = LinkOutcome | "skipped"
/** what asked for a link: in the background, or a Register tap waiting on it */
export type NameLinkTrigger = "background" | "register"

/** one link's deadline: a first link that claims the store and waits for the
 *  PGAS allowance took up to 55 s (21 Oct) */
export const NAME_LINK_TIMEOUT_MS = 90_000
/** How long a link that ran out of time may take to finish its step before
 *  the gate stops waiting for it: a transaction's wait for a block (120 s), or
 *  the player on the root's prompt. A host that never answers holds no gate
 *  for good. */
export const NAME_LINK_GRACE_MS = 120_000
/** how long a tap waits on a link still under way before it ends with a notice */
export const NAME_TAP_WAIT_MS = 120_000
/** while a tap waits, how often a link that ended short goes again, past the ladder */
export const NAME_TAP_RETRY_MS = 5_000
/** how long a link that found nobody owns the username holds the gate before
 *  it checks again: a username lands on chain in minutes at best, and asking
 *  sooner only loads the host (a busy game has asked 134 times in one
 *  window, #1115) */
export const NAME_UNOWNED_RETRY_MS = 10 * 60_000
/** how soon after the last link a player's own ask (`recheck`: a tap, coming
 *  back from Humanity) may end the unowned hold: a username set up a minute
 *  later must not wait out the hold and miss the game */
export const NAME_UNOWNED_RECHECK_MS = 30_000

export interface NameGateOptions {
  /** One link. `signal` aborts once the link runs out of time (NAME_LINK_TIMEOUT_MS):
   *  pass it on to `linkName`, which then starts no further step. */
  link(trigger: NameLinkTrigger, signal: AbortSignal): Promise<NameLinkResult>
  /** the wait before the next link after `failures` links in a row that did not end linked */
  retryDelay(failures: number): number
  /** after each link: how it ended (null when it ran out of time), the
   *  failures in a row so far, and the wait before the next (null once linked).
   *  A link that ran out of time and still ended linked is reported again. */
  onOutcome?(outcome: NameLinkResult | null, failures: number, retryInMs: number | null): void
}

export interface NameGate {
  /** Asks for a link unless one is linked or under way; in the background, not while the ladder waits. */
  request(trigger?: NameLinkTrigger): void
  /** The player asked, with a tap or by coming back (from the Humanity
   *  hand-off): a Register-tap request that also ends the unowned hold, at most
   *  once per NAME_UNOWNED_RECHECK_MS. */
  recheck(): void
  /** Whether Register may go: the name is linked. */
  ready(): boolean
  /** Whether the gate waits on a link: no longer once the link ran out of
   *  time, even while that link is still finishing its step. */
  pending(): boolean
  /** Drops the ladder's wait for the next background link: a caller running
   *  its own retries owns the pause, and the gate adds no attempt between them. */
  clearRetry(): void
  /** Whether the latest link that could tell found that nobody owns the username. */
  unowned(): boolean
  /** Called after every link ends, once the gate's state has moved. */
  subscribe(listener: () => void): () => void
  /** Asks at once and resolves `linked`, or `not-linked` after NAME_TAP_WAIT_MS.
   *  While a link that ended `unowned` holds the gate, it resolves `not-linked`
   *  at once, and so does a wait that a link ends `unowned`. */
  inPlace(): Promise<"linked" | "not-linked">
}

/** The name gate a surface's sign-up waits on, running `link` by the rule in the module header. */
export function createNameGate({ link, retryDelay, onOutcome }: NameGateOptions): NameGate {
  let named = false
  let pending = false
  /** the link under way, which the gate may have stopped waiting on (`pending`) */
  let current: symbol | undefined
  /** what asked while a link that ran out of time was still finishing */
  let queued: NameLinkTrigger | undefined
  let failures = 0
  let unowned = false
  /** the wait after an `unowned` link, which only its own timer ends */
  let held = false
  /** when the latest link started, which spaces the re-checks a player asks for */
  let lastStart = Number.NEGATIVE_INFINITY
  let retry: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()

  // a product's hooks never hold the gate
  const report = (outcome: NameLinkResult | null, retryInMs: number | null) => {
    try {
      onOutcome?.(outcome, failures, retryInMs)
    } catch {
      /* the report is the product's */
    }
  }
  const notify = () =>
    listeners.forEach((listener) => {
      try {
        listener()
      } catch {
        /* one listener does not keep the others from hearing */
      }
    })
  const delayAfter = (failures: number) => {
    try {
      return retryDelay(failures)
    } catch {
      return NAME_TAP_RETRY_MS
    }
  }

  const request = (trigger: NameLinkTrigger = "background") => {
    if (named || pending || held) return
    // the ladder's wait stands in the background; a player waiting on it skips it
    if (trigger === "background" && retry !== undefined) return
    // The link that ran out of time is still finishing a step: a root
    // signature the player has not answered, or a transaction not yet in a
    // block. The next link waits for it, so the player is never asked twice
    // and nothing is submitted twice.
    if (current) {
      if (queued !== "register") queued = trigger
      return
    }
    clearTimeout(retry)
    retry = undefined
    pending = true
    lastStart = Date.now()
    const run = Symbol("link")
    current = run
    const stop = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    /** the gate stops counting this link as under way, and what asked meanwhile goes */
    const release = () => {
      clearTimeout(grace)
      if (current !== run) return
      current = undefined
      const next = queued
      queued = undefined
      if (next) request(next)
    }
    const outOfTime = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), NAME_LINK_TIMEOUT_MS)))
    const linking = Promise.resolve()
      .then(() => link(trigger, stop.signal))
      .catch((): NameLinkResult => "failed")
    void linking.then((outcome) => {
      // in time: the race below has it
      if (!timedOut) {
        if (current === run) current = undefined
        return
      }
      // after the deadline a success still counts
      if (!named && (outcome === "linked" || outcome === "already-linked")) {
        named = true
        unowned = false
        held = false
        failures = 0
        clearTimeout(retry)
        retry = undefined
        report(outcome, null)
        notify()
      }
      release()
    })
    void Promise.race([linking, outOfTime]).then((outcome) => {
      clearTimeout(timer)
      if (outcome === null) {
        timedOut = true
        stop.abort(new Error(`the link ran out of time after ${NAME_LINK_TIMEOUT_MS / 1000}s`))
        grace = setTimeout(release, NAME_LINK_GRACE_MS)
      }
      pending = false
      // any answer but unowned means the username's owner was not the reason;
      // a link that ran out of time says nothing either way
      if (outcome !== null) unowned = outcome === "unowned"
      if (outcome === "linked" || outcome === "already-linked") {
        named = true
        failures = 0
        report(outcome, null)
      } else {
        failures += 1
        // nobody owns the username: hold every trigger off until the long check
        held = outcome === "unowned"
        const delay = held ? NAME_UNOWNED_RETRY_MS : delayAfter(failures)
        retry = setTimeout(() => {
          retry = undefined
          held = false
          request()
        }, delay)
        report(outcome, delay)
      }
      // AFTER the state moved: a reader this wakes sees it
      notify()
    })
  }

  /** the player asked: past the unowned hold once NAME_UNOWNED_RECHECK_MS has
   *  gone by since the last link, else as a Register tap */
  const recheck = () => {
    if (held) {
      if (Date.now() - lastStart < NAME_UNOWNED_RECHECK_MS) return
      clearTimeout(retry)
      retry = undefined
      held = false
    }
    request("register")
  }

  return {
    request,
    recheck,
    ready: () => named,
    pending: () => pending,
    unowned: () => unowned,
    clearRetry() {
      // the hold after an unowned link is not the ladder's: it stands
      if (held) return
      clearTimeout(retry)
      retry = undefined
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async inPlace() {
      recheck()
      if (!named && !held) {
        await new Promise<void>((resolve) => {
          const done = () => {
            listeners.delete(check)
            clearTimeout(cap)
            clearInterval(again)
            resolve()
          }
          const check = () => {
            if (named || held) done()
          }
          const again = setInterval(() => request("register"), NAME_TAP_RETRY_MS)
          const cap = setTimeout(done, NAME_TAP_WAIT_MS)
          listeners.add(check)
        })
      }
      return named ? "linked" : "not-linked"
    },
  }
}
