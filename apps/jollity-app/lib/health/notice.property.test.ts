// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { LadderVerdict, LayerResult } from "@jollity/statement-core"
import { healthNoticeVariant, noticeBlame } from "./notice"

const failed = (layer: LayerResult["layer"]): LayerResult => ({ layer, status: "fail", detail: `${layer} failed` })
const verdict = (blame: LayerResult | null): LadderVerdict => ({ rungs: blame ? [blame] : [], blame })

describe("health notice properties", () => {
  it("names a stuck host only when the input proves one without player isolation", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (hostStuck, playerNetworkIsolated, reconnecting) => {
        const variant = healthNoticeVariant(hostStuck, playerNetworkIsolated, reconnecting)

        if (!hostStuck || playerNetworkIsolated) expect(variant).toBe("connection")
        else expect(variant).toBe(reconnecting ? "host-reconnecting" : "host-stuck")
      },
    ))
  })

  it("withholds TURN blame until both signer and path evidence exist", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (hostAnswering, noUsablePath) => {
      const blame = failed("turn-credentials")

      expect(noticeBlame(verdict(blame), hostAnswering, noUsablePath)).toBe(
        hostAnswering && noUsablePath ? blame : null,
      )
    }))
  })

  it("never suppresses an actionable non-TURN layer", () => {
    fc.assert(fc.property(
      fc.constantFrom<LayerResult["layer"]>("internet", "store-write", "store-read", "signalling", "ice", "media", "camera", "device"),
      fc.boolean(),
      fc.boolean(),
      (layer, hostAnswering, noUsablePath) => {
        const blame = failed(layer)

        expect(noticeBlame(verdict(blame), hostAnswering, noUsablePath)).toBe(blame)
      },
    ))
  })

  it("does not invent blame when the ladder has none", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (hostAnswering, noUsablePath) => {
      expect(noticeBlame(verdict(null), hostAnswering, noUsablePath)).toBeNull()
    }))
  })
})
