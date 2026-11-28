// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// GitHub Actions masks only each WHOLE secret string. A value picked out of a
// JSON pool secret ({username: mnemonic}) or handed on through an env var is a
// new string the runner has never seen, so it is printed in clear unless it is
// registered with `::add-mask::` first. Run logs of a public repository are
// world-readable: every place that parses a mnemonic masks it right there,
// before anything can log it.
//
// The workflows' bash steps do the same for the pools (e2e-live.yml "Mask the
// identity pools' mnemonics", attest-previewnet-bots.yml); this is the TS side,
// for the values the bots read from their env.

type Env = Record<string, string | undefined>
type Write = (line: string) => void

const toStdout: Write = (line) => {
  process.stdout.write(line)
}

/** Register every non-empty value (each line of a multi-line one) as a mask. A no-op outside GitHub Actions. */
export function addMasks(values: Iterable<string | undefined>, env: Env = process.env, write: Write = toStdout): number {
  if (env.GITHUB_ACTIONS !== "true") return 0
  let count = 0
  for (const value of values) {
    for (const line of (value ?? "").split(/\r?\n/)) {
      const secret = line.trim()
      if (!secret) continue
      write(`::add-mask::${secret}\n`)
      count++
    }
  }
  return count
}
