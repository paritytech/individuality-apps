// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE ONE CLASSIFIER of a failed host call, and the one place that says
 * which classes mean the host has lost its chain.
 *
 * A failure reaches a caller in three shapes: a truapi client error (by its
 * name), an SDK wrapper around it (the message, with the cause under it) or a
 * host refusal as a tagged `tag`/`value` chain. The classifier walks every
 * shape once and matches the names first, then the texts, from one table, so
 * the probe, the sign-up, the name lookup and the TURN proof agree on what
 * one failure means. `chainVerdict` then folds a class into what a screen
 * acts on. Pure, with no host access, so a chat worker can share it.
 *
 * The walk reads text under message and reason, and any bare string it
 * reaches. A tag or type is the name of a host variant, so only the rows of
 * the host variants read it, and a variant called Timeout or Connection is
 * not a timeout or a network failure by its name alone. Every name in the
 * chain is matched before any text, in the order of the name table, so a
 * reset anywhere in the chain beats a timeout wrapped around it.
 */

export const HOST_FAILURE_CLASSES = [
  "cannot-get-current-block",
  "subscription-dropped",
  "follow-unknown",
  "block-not-pinned",
  "host-interrupted",
  "timeout",
  "declined",
  "network",
  "unknown",
] as const

export type HostFailureClass = (typeof HOST_FAILURE_CLASSES)[number]

export type ChainVerdict = "lost" | "interrupted" | "unanswered" | "declined" | "unknown"

const MAX_DEPTH = 6
const MAX_NODES = 12

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** Follow a `key`/`value` chain of tagged nodes, collecting the tags. Stops at
 *  the first node without a string under `key` and returns that node as the leaf. */
export function walkTags(value: unknown, key: "tag" | "type"): { tags: string[]; leaf: unknown } {
  const tags: string[] = []
  let node = value
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (!isRecord(node) || typeof node[key] !== "string") break
    tags.push(node[key] as string)
    node = node.value
  }
  return { tags, leaf: node }
}

const BY_NAME: ReadonlyArray<readonly [string, HostFailureClass]> = [
  ["ConnectionResetError", "host-interrupted"],
  ["RequestTimeoutError", "timeout"],
  ["TxSigningRejectedError", "declined"],
]

const BY_TEXT: ReadonlyArray<readonly [RegExp, HostFailureClass]> = [
  [/TrUAPI host connection interrupted/i, "host-interrupted"],
  [/cannot get the current block|CannotGetCurrentBlock/i, "cannot-get-current-block"],
  [/subscription dropped|SubscriptionDropped/i, "subscription-dropped"],
  [/unknown follow subscription id/i, "follow-unknown"],
  [/BlockNotPinned|not pinned/i, "block-not-pinned"],
  [/time(d)? ?out|no answer (after|in) /i, "timeout"],
  [
    /user (?:rejected|declined|denied)|confirmation (?:rejected|declined|denied)|signature (?:rejected|declined|denied)|signing (?:rejected|declined|denied)|signing was rejected|SigningRejected|HostRejected|rejected the request|UnableToSign/i,
    "declined",
  ],
  [/(?:^|createTransaction failed:\s*)Rejected(?:$|\s*<-)/im, "declined"],
  [/network|fetch|socket|disconnect|connection|offline/i, "network"],
]

const TAGGED: ReadonlySet<HostFailureClass> = new Set([
  "cannot-get-current-block",
  "subscription-dropped",
  "block-not-pinned",
  "declined",
])

function gather(value: unknown): { names: string[]; texts: string[]; tags: string[] } {
  const names: string[] = []
  const texts: string[] = []
  const tags: string[] = []
  const seen = new Set<unknown>()
  const pending: unknown[] = [value]
  while (pending.length > 0 && seen.size < MAX_NODES) {
    const node = pending.shift()
    if (typeof node === "string") {
      texts.push(node)
      continue
    }
    if (!isRecord(node) || seen.has(node)) continue
    seen.add(node)
    if (typeof node.name === "string") names.push(node.name)
    for (const key of ["message", "reason"]) {
      if (typeof node[key] === "string") texts.push(node[key] as string)
    }
    for (const key of ["tag", "type"]) {
      if (typeof node[key] === "string") tags.push(node[key] as string)
    }
    for (const key of ["value", "cause", "error"]) {
      if (node[key] !== undefined) pending.push(node[key])
    }
  }
  return { names, texts, tags }
}

/** What one failed host call was, by the name of the error first and its words second. */
export function classifyHostFailure(value: unknown): HostFailureClass {
  const { names, texts, tags } = gather(value)
  for (const [name, failureClass] of BY_NAME) {
    if (names.includes(name)) return failureClass
  }
  const text = texts.join("\n")
  const tagText = tags.join("\n")
  for (const [pattern, failureClass] of BY_TEXT) {
    if (pattern.test(text) || (TAGGED.has(failureClass) && pattern.test(tagText))) return failureClass
  }
  return "unknown"
}

/** What a class says about the chain of the host: lost, a cut link that says
 *  nothing about the chain, no answer within the bound, a no from the player,
 *  or nothing. */
export function chainVerdict(failureClass: HostFailureClass): ChainVerdict {
  switch (failureClass) {
    case "cannot-get-current-block":
    case "subscription-dropped":
    case "follow-unknown":
    case "block-not-pinned":
      return "lost"
    case "host-interrupted":
      return "interrupted"
    case "timeout":
      return "unanswered"
    case "declined":
      return "declined"
    default:
      return "unknown"
  }
}
