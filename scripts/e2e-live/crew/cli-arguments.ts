// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export function flagArguments(argv: string[], allowed: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowed.includes(flag) || !value || value.startsWith("--")) throw new Error(`unknown or incomplete argument ${flag}`)
    if (values.has(flag)) throw new Error(`duplicate argument ${flag}`)
    values.set(flag, value)
  }
  return values
}

export function requiredFlag(values: ReadonlyMap<string, string>, flag: string, usage: string): string {
  const value = values.get(flag)
  if (!value) throw new Error(usage)
  return value
}

export function deterministicClock(values: ReadonlyMap<string, string>, environmentFlag: string): Date {
  const requested = values.get("--now")
  if (requested && process.env[environmentFlag] !== "1") throw new Error("--now is available only to the deterministic test harness")
  const clock = requested ? new Date(requested) : new Date()
  if (!Number.isFinite(clock.getTime())) throw new Error("--now must be an ISO timestamp")
  return clock
}
