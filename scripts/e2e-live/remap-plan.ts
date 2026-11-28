// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure planning for rebuild-previewnet.sh: which new username replaces each old previewnet one. */

export type Remap = { map: Record<string, string>; unusedRegular: string[] }

/** Base of a username: "jollylaenus.78" -> "jollylaenus". */
export const baseOf = (username: string): string => username.split(".")[0]

/**
 * Old previewnet names are replaced in first-appearance order. A name whose base is a dedicated persona base takes
 * the new persona with that base; every other name takes the next unused regular bot. Throws when a persona is
 * missing or the pool is too small, so a half-built pool never rewrites the repo.
 */
export const planRemap = (oldNames: string[], newRegular: string[], newPersonas: Record<string, string>): Remap => {
  const map: Record<string, string> = {}
  const regular = [...newRegular]
  for (const old of oldNames) {
    const persona = newPersonas[baseOf(old)]
    if (baseOf(old) in newPersonas) {
      if (!persona) throw new Error(`no new persona for base ${baseOf(old)}`)
      map[old] = persona
    } else {
      const next = regular.shift()
      if (!next) throw new Error(`pool too small: no regular bot left for ${old}`)
      map[old] = next
    }
  }
  const targets = Object.values(map)
  if (new Set(targets).size !== targets.length) throw new Error("two old names map to one new name")
  return { map, unusedRegular: regular }
}

/** One simultaneous pass, so a new name that equals another old name is never rewritten twice. */
export const applyRemap = (text: string, map: Record<string, string>): string => {
  const olds = Object.keys(map)
  if (!olds.length) return text
  const pattern = new RegExp(`(?<![A-Za-z0-9.])(${olds.map((name) => name.replace(/\./g, "\\.")).join("|")})(?![A-Za-z0-9])`, "g")
  return text.replace(pattern, (hit) => map[hit])
}
