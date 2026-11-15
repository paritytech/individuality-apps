// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"
import { TAG_KEYS } from "./init"
import { SCOPE_TAGS, invalidateScopeTags, scopeTagAttrs, setScopeTags } from "./scope-tags"

const proto = Object.getPrototypeOf(Sentry.getIsolationScope()) as { getScopeData: () => unknown }
let reads: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  for (const key of ["game.index", "device.gpu", "net.type"]) Sentry.getIsolationScope().setTag(key, undefined)
  invalidateScopeTags()
  reads = vi.spyOn(proto, "getScopeData")
})
afterEach(() => reads.mockRestore())

describe("the scope tag snapshot", () => {
  it("reads the scopes once for a burst of points", () => {
    setScopeTags({ "game.index": "4" })
    for (let i = 0; i < 50; i += 1) expect(scopeTagAttrs()).toEqual({ "game.index": "4" })
    expect(reads).toHaveBeenCalledTimes(2) // the isolation and the current scope, once
  })

  it("re-reads after a tag changes through the doorway, and after an invalidate", () => {
    setScopeTags({ "game.index": "4" })
    scopeTagAttrs()
    setScopeTags({ "device.gpu": "Adreno 740", "game.index": undefined })
    expect(scopeTagAttrs()).toEqual({ "device.gpu": "Adreno 740" })
    expect(reads).toHaveBeenCalledTimes(4)
    Sentry.getIsolationScope().setTag("net.type", "wifi") // behind the doorway's back
    invalidateScopeTags()
    expect(scopeTagAttrs()).toEqual({ "device.gpu": "Adreno 740", "net.type": "wifi" })
    expect(reads).toHaveBeenCalledTimes(6)
  })

  it("keeps only the dashboard tags, as strings, and leaves out the unset ones", () => {
    setScopeTags({ "failure.kind": "peer-failed", "net.type": "wifi", "device.model": "" })
    expect(scopeTagAttrs()).toEqual({ "net.type": "wifi" })
  })

  it("carries the host app's name as well as its version", () => {
    expect(SCOPE_TAGS).toContain("host.app")
    expect(SCOPE_TAGS).toContain("host.app_version")
  })

  it("carries the browser engine and its version, so every rtc point says which engine it ran on", () => {
    expect(SCOPE_TAGS).toContain("device.engine")
    expect(SCOPE_TAGS).toContain("device.engine_version")
  })

  it("every scope tag is one the app sets (and the masking test checks)", () => {
    for (const key of SCOPE_TAGS) expect(TAG_KEYS).toContain(key)
  })
})
