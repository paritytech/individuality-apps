// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Turn a thrown value into text an operator can act on.
 *
 * Every chain write in this app hands the user a safe, fixed sentence and
 * throws the real failure away: the host's Result error becomes `()`, the
 * decoded validity payload survives only as an unread `cause`, and a canned
 * message is then logged in its place. A report that says "we couldn't reserve
 * your weekly game seat" names the button that was pressed and nothing about
 * why it failed, which is indistinguishable from a chain outage, a missing ring
 * key, a refused signer, and a malformed extension list.
 *
 * The user-facing copy stays exactly as it is. These helpers produce the
 * *second* string — the one that goes to the log and the debug snapshot.
 *
 * String formats deliberately match `@parity/product-sdk-tx`'s
 * `formatDispatchError` / `formatValidityError` (`"Pallet.ErrorName"`,
 * `"Invalid.Payment"`) so panel output stays comparable with the SDK's own.
 * That package is not reachable through the `@parity/product-sdk/*` subpath map
 * this app imports from, and a direct dependency on it for two tagged-enum
 * walks is not worth a second resolution of the SDK tree.
 */

/** Deep enough for signer → host → validity nesting, shallow enough to read. */
const MAX_CAUSE_DEPTH = 6;
/** Enough for a decoded payload; short enough not to evict the log buffer. */
const MAX_LINK_LENGTH = 240;
const CAUSE_SEPARATOR = " <- ";

/** Every link is truncated the same way, or the joined chain has no bound. */
function clamp(text: string): string {
  return text.length <= MAX_LINK_LENGTH
    ? text
    : `${text.slice(0, MAX_LINK_LENGTH - 1)}…`;
}

/**
 * Join a nested tagged enum's `type` chain: `{type:"Invalid",value:{type:
 * "Payment"}}` reads `Invalid.Payment`. Stops at the first link without a
 * string `type`, so a payload carrying real data at the leaf keeps its tags.
 */
function tagChain(value: unknown): string[] {
  const tags: string[] = [];
  let node = value;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof node !== "object" || node === null) break;
    if (!("type" in node) || typeof node.type !== "string") break;
    tags.push(node.type);
    node = "value" in node ? node.value : undefined;
  }
  return tags;
}

/**
 * Decode a host-API `Result` error, following the envelopes it nests.
 *
 * TrUAPI wraps every failure in Rust's derived `CallError<D>`, whose `Domain`
 * variant carries the call's *own* error as its payload rather than describing
 * a domain — and that payload is itself a `V<N>` version envelope around the
 * real variant. A ring-VRF refusal therefore arrives as
 * `Domain → V1 → NotAllowlisted`, and reading only the outer tag reports
 * `Domain`, which says nothing: `RingNotFound`, `NotMember`,
 * `KeyNotRegistered`, `KeyNotInRing`, `NotAllowlisted` and `Rejected` are six
 * different bugs and the outer tag is identical for all of them.
 *
 * So walk the `tag` chain to the leaf and join it, appending the `reason` of a
 * `MalformedFrame` / `HostFailure` / `Unknown` payload when one is there.
 */
export function hostError(error: unknown): string {
  if (typeof error !== "object" || error === null || !("tag" in error)) {
    return clamp(String(error));
  }
  const tags: string[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof node !== "object" || node === null || !("tag" in node)) break;
    tags.push(String(node.tag));
    node = "value" in node ? node.value : undefined;
  }
  const chain = tags.join(".");
  return typeof node === "object" && node !== null && "reason" in node
    ? clamp(`${chain}: ${String(node.reason)}`)
    : clamp(chain);
}

/**
 * Decode the dispatch error of a finalized-but-failed transaction into
 * `"Pallet.ErrorName"`.
 *
 * Only `Module` errors nest; walking the `type` chain of the others would
 * rewrite established single-word formats such as `Token`. A failed result with
 * no `dispatchError` at all was rejected before inclusion — a different failure
 * that says so rather than collapsing to "unknown".
 */
export function dispatchErrorText(result: {
  ok: boolean;
  dispatchError?: unknown;
}): string {
  if (result.ok) return "";
  const { dispatchError } = result;
  if (dispatchError === undefined) {
    return "rejected before inclusion (no dispatch error)";
  }
  if (
    typeof dispatchError !== "object" ||
    dispatchError === null ||
    !("type" in dispatchError) ||
    typeof dispatchError.type !== "string"
  ) {
    return "unknown error";
  }
  if (dispatchError.type !== "Module") return clamp(dispatchError.type);
  const tags = tagChain("value" in dispatchError ? dispatchError.value : undefined);
  return tags.length === 0 ? "Module" : clamp(tags.join("."));
}

/**
 * Decode the `TransactionValidityError` PAPI attaches to `InvalidTxError.error`
 * when a transaction is rejected before inclusion, into `"Invalid.Payment"`.
 */
export function validityErrorText(reason: unknown): string {
  const tags = tagChain(reason);
  return tags.length === 0 ? "unknown validity error" : clamp(tags.join("."));
}

/** One link of the chain: what this value is, plus whatever it decodes to. */
function errorText(value: unknown): string {
  if (value === undefined) return "no error reported";
  if (value === null) return "null";
  if (value instanceof Error) {
    const label =
      value.name === "Error" ? value.message : `${value.name}: ${value.message}`;
    // PAPI's `InvalidTxError` carries the decoded validity payload on `.error`.
    const tags = "error" in value ? tagChain(value.error) : [];
    return clamp(tags.length === 0 ? label : `${label} [${tags.join(".")}]`);
  }
  if (typeof value !== "object") return clamp(String(value));
  if ("tag" in value) return hostError(value);
  const tags = tagChain(value);
  if (tags.length > 0) return clamp(tags.join("."));
  try {
    return clamp(JSON.stringify(value) ?? String(value));
  } catch {
    return clamp(String(value));
  }
}

/**
 * Render a thrown value and its whole `cause` chain, outermost first.
 *
 * The chain is the diagnosis: the outer link is the sentence the feature chose
 * to show, and the innermost is the host or chain refusal that actually
 * happened. Consecutive duplicates collapse, because wrapping a canned message
 * around a canned message is exactly how the detail was lost before.
 */
export function describeError(error: unknown): string {
  const links: string[] = [];
  const seen = new Set<unknown>();
  let node: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof node === "object" && node !== null) {
      if (seen.has(node)) break;
      seen.add(node);
    }
    const text = errorText(node);
    if (links[links.length - 1] !== text) links.push(text);
    if (typeof node !== "object" || node === null || !("cause" in node)) break;
    node = node.cause;
    if (node === undefined) break;
  }
  return links.join(CAUSE_SEPARATOR);
}
