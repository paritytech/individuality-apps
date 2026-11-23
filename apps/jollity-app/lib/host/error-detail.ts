// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Failures as text an operator can act on.
 *
 * Three shapes reach the doorway and each hides its meaning one level down:
 *
 *  - a HOST refusal is a tagged enum nested twice — TrUAPI wraps every call
 *    error in `CallError`, whose `Domain` variant carries the call's own error,
 *    itself inside a `V<n>` version envelope. `Domain → V1 → NotAllowlisted`
 *    read at the top says "Domain", which distinguishes nothing;
 *  - a DISPATCH error of an included-but-failed extrinsic is `Module` with the
 *    pallet and error name nested under `value`;
 *  - a VALIDITY error of a transaction rejected before inclusion rides papi's
 *    `InvalidTxError.error` as `{ type: "Invalid", value: { type: "Payment" } }`.
 *
 * `describeError` renders a thrown value with its whole `cause` chain, so the
 * sentence a screen chose to show and the refusal underneath both survive into
 * the log. Pure with no host access.
 */

import { walkTags } from "@individuality/people-chain"
import { isHostChannelInterruption } from "./safe-call"

/** enough for signer → host → validity nesting; shallow enough to read */
const MAX_DEPTH = 6
/** a decoded payload fits; a dumped object does not evict the log */
const MAX_LINK = 240

const clamp = (text: string) => (text.length <= MAX_LINK ? text : `${text.slice(0, MAX_LINK - 1)}…`)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * The host refused a read of another product's storage (no grant in that
 * product's manifest, for one). Its message is the line the log has always
 * shown; `reason` is the host's own words for the refusal, kept apart so a
 * reader can tell a refusal from a read that failed and say why.
 */
export class HostReadRefused extends Error {
  constructor(
    readonly product: string,
    readonly reason: string,
  ) {
    super(`${product} refused the read: ${reason}`)
  }
}

/** A host-API error to `Outer.Version.Variant`, plus the leaf's `reason` when
 *  it carries one (`Unknown`, `MalformedFrame`, `HostFailure`). */
export function hostErrorText(error: unknown): string {
  if (!isRecord(error) || !("tag" in error)) return clamp(String(error))
  const { tags, leaf } = walkTags(error, "tag")
  const chain = tags.join(".")
  return isRecord(leaf) && typeof leaf.reason === "string" ? clamp(`${chain}: ${leaf.reason}`) : clamp(chain)
}

/** A dispatch error to `Pallet.ErrorName`; other variants keep their single
 *  word (`Token`, `Arithmetic`). `undefined` means the transaction never
 *  reached a block — a different failure, named as such. */
export function dispatchErrorText(dispatchError: unknown): string {
  if (dispatchError === undefined) return "rejected before inclusion (no dispatch error)"
  if (!isRecord(dispatchError) || typeof dispatchError.type !== "string") return "unknown dispatch error"
  if (dispatchError.type !== "Module") return clamp(dispatchError.type)
  const { tags } = walkTags(dispatchError.value, "type")
  return tags.length === 0 ? "Module" : clamp(tags.join("."))
}

/** papi's `TransactionValidityError` payload to `Invalid.Payment`. */
export function validityErrorText(reason: unknown): string {
  const { tags } = walkTags(reason, "type")
  return tags.length === 0 ? "unknown validity error" : clamp(tags.join("."))
}

function linkText(value: unknown): string {
  if (value === undefined) return "no error reported"
  if (value === null) return "null"
  if (value instanceof Error) {
    const label = value.name === "Error" ? value.message : `${value.name}: ${value.message}`
    // papi's InvalidTxError carries the decoded validity payload on `.error`
    const payload = "error" in value ? walkTags((value as { error?: unknown }).error, "type").tags : []
    return clamp(payload.length === 0 ? label : `${label} [${payload.join(".")}]`)
  }
  if (!isRecord(value)) return clamp(String(value))
  if ("tag" in value) return hostErrorText(value)
  const typed = walkTags(value, "type").tags
  if (typed.length > 0) return clamp(typed.join("."))
  try {
    return clamp(JSON.stringify(value) ?? String(value))
  } catch {
    return clamp(String(value))
  }
}

/** A thrown value and its `cause` chain, outermost first, ` <- ` between links.
 *  Consecutive duplicates collapse — a canned message wrapped around the same
 *  canned message is how detail got lost before. */
export function describeError(error: unknown): string {
  const links: string[] = []
  const seen = new Set<unknown>()
  let node: unknown = error
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (isRecord(node)) {
      if (seen.has(node)) break
      seen.add(node)
    }
    const text = linkText(node)
    if (links[links.length - 1] !== text) links.push(text)
    if (!isRecord(node) || !("cause" in node) || node.cause === undefined) break
    node = node.cause
  }
  if (isHostChannelInterruption(error)) {
    const raw = links.find((link) => link.includes("TrUAPI host connection interrupted")) ?? links.at(-1)
    return raw
      ? `The host channel was interrupted (the app likely resumed). <- ${raw}`
      : "The host channel was interrupted (the app likely resumed)."
  }
  return links.join(" <- ")
}
