// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { stampSecondsOf, type StampReadings } from "../../webrtc/ice"

const SKEWS = [null, -120_000, -1, 0, 1, 999, 1000, 75_000] as const
const SKEW_BASES = [0, 1_700_000_000_000, 1_700_000_000_999] as const
const GAPS = [null, -75_000, -1, 0, 1, 999, 75_000, 600_000] as const
const DEVICES = [1_700_000_000_000, 1_700_000_000_500, 1_700_000_075_000] as const
const CHAINS = [null, 1_699_999_925, 1_700_000_000] as const
const NO_GAPS = [false, true] as const

type Case = { skew: number | null; base: number; gap: number | null; device: number; chain: number | null; noGap: boolean }
const cases: Case[] = []
for (const skew of SKEWS) for (const base of SKEW_BASES) for (const gap of GAPS) for (const device of DEVICES) for (const chain of CHAINS) for (const noGap of NO_GAPS)
  cases.push({ skew, base, gap, device, chain, noGap })

const readings = (c: Case): StampReadings => ({ serverSkewMs: c.skew, skewBaseMs: () => c.base, gapMs: () => c.gap, deviceNowMs: () => c.device, chainSeconds: () => c.chain })
const expected = (c: Case) =>
  c.skew !== null ? { seconds: Math.floor((c.base + c.skew) / 1000), fromGap: false }
  : !c.noGap && c.gap !== null ? { seconds: Math.floor((c.device - c.gap) / 1000), fromGap: true }
  : c.chain !== null ? { seconds: c.chain, fromGap: false }
  : { seconds: Math.floor(c.device / 1000), fromGap: false }

describe("C3 TURN stamp sweep", () => {
  it("sweeps all 3456 combinations", () => { expect(cases).toHaveLength(3456) })
  it("follows the four rules in priority order for every combination", () => {
    for (const c of cases) expect(stampSecondsOf(readings(c), c.noGap), JSON.stringify(c)).toEqual(expected(c))
  })
  it("never reads the gap when the issuer's skew is known", () => {
    for (const c of cases.filter((c) => c.skew !== null)) {
      const gapMs = vi.fn(() => c.gap)
      stampSecondsOf({ ...readings(c), gapMs }, c.noGap)
      expect(gapMs, JSON.stringify(c)).not.toHaveBeenCalled()
    }
  })
  it("gives the same stamp for every gap value when noGap is true", () => {
    for (const c of cases.filter((c) => c.noGap)) expect(stampSecondsOf(readings(c), true)).toEqual(stampSecondsOf(readings({ ...c, gap: null }), true))
  })
  it("stamps chain time for a phone 75 s fast with no readable Date header (#1399)", () => {
    expect(stampSecondsOf(readings({ skew: null, base: 0, gap: 75_000, device: 1_700_000_075_000, chain: null, noGap: false }), false)).toEqual({ seconds: 1_700_000_000, fromGap: true })
    expect(stampSecondsOf(readings({ skew: null, base: 0, gap: 75_000, device: 1_700_000_075_000, chain: 1_700_000_000, noGap: true }), true)).toEqual({ seconds: 1_700_000_000, fromGap: false })
  })
})
