// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Test support: the fingerprint walk as it was before the room wrote the
 * canonical text directly (room.ts canonicalFingerprintValue), kept verbatim
 * as the oracle the streamed walk must match byte for byte: build the
 * canonical value, then JSON.stringify it. Saved census keys, witnesses and
 * known-gap state keys are digests of this text. Only the hooks are adapted
 * to the new signature (the key, then a lazy path).
 */
import { createHash } from "node:crypto"
import { HarnessError, type FingerprintWalkHooks } from "./room"

const bytes = (value: ArrayBuffer | ArrayBufferView): Uint8Array => value instanceof ArrayBuffer
  ? new Uint8Array(value)
  : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

/** the path text of the reference walk as the new hooks' FingerprintPath */
const pathAt = (path: string) => {
  const segments = path.split("/")
  let at: { parent: ReturnType<typeof pathAt> | undefined; segment: string } | undefined
  for (const segment of segments) at = { parent: at, segment }
  return at!
}

export function referenceFingerprintValue(root: unknown, newHooks: FingerprintWalkHooks = {}): string {
  const hooks = {
    transform: newHooks.transform === undefined
      ? undefined
      : (value: unknown, path: string, key?: string) => newHooks.transform!(value, key, pathAt(path)),
    orderKey: newHooks.orderKey,
  }
  const seen = new WeakMap<object, string>()
  const walk = (value: unknown, path: string, key?: string): unknown => {
    const transformed = hooks.transform?.(value, path, key)
    if (transformed !== undefined) return transformed.value
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
    if (typeof value === "bigint") return { $bigint: value.toString() }
    if (typeof value === "undefined") return { $undefined: true }
    if (typeof value === "function" || typeof value === "symbol") return undefined
    if (value instanceof Promise) return { $promise: true }
    if (value instanceof ArrayBuffer || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
      return { $bytes: createHash("sha256").update(bytes(value)).digest("hex") }
    }
    if (value instanceof DataView) throw new HarnessError("fingerprint: exotic object: DataView")
    if (value instanceof Date) return { $date: value.getTime() }
    const object = value as object
    const prior = seen.get(object)
    if (prior !== undefined) return { $ref: prior }
    seen.set(object, path)
    if (Array.isArray(value)) return value.flatMap((item, index) => {
      const walked = walk(item, `${path}/${index}`)
      return walked === undefined ? [] : [walked]
    })
    if (value instanceof Map) {
      const entries = hooks.orderKey === undefined
        ? [...value]
        : [...value].sort(([left], [right]) => hooks.orderKey!(left).localeCompare(hooks.orderKey!(right)))
      return { $map: entries.map(([mapKey, item], index) => [walk(mapKey, `${path}/k${index}`), walk(item, `${path}/v${index}`)]) }
    }
    if (value instanceof Set) {
      const values = hooks.orderKey === undefined
        ? [...value]
        : [...value].sort((left, right) => hooks.orderKey!(left).localeCompare(hooks.orderKey!(right)))
      return { $set: values.map((item, index) => walk(item, `${path}/${index}`)).filter((item) => item !== undefined) }
    }
    const keys = Object.keys(value as object).sort()
    const constructor = (value as { constructor?: { name?: string } }).constructor
    if (constructor !== Object && keys.length === 0) throw new HarnessError(`fingerprint: exotic object: ${constructor?.name ?? "unknown"}`)
    return Object.fromEntries(keys.flatMap((key) => {
      const walked = walk((value as Record<string, unknown>)[key], `${path}/${key}`, key)
      return walked === undefined ? [] : [[key, walked]]
    }))
  }
  return JSON.stringify(walk(root, "$"))
}
