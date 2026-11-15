// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { hostTelemetryTags, readHostTelemetryContext } from "./host-context"

const ID = "123e4567-e89b-42d3-a456-426614174000"

describe("native host telemetry context", () => {
  it("reads a valid host session and available build identity", () => {
    const bootstrap = {
        hostSessionId: ID,
        appVersion: "1.17.0",
        appBuild: "57",
        appVariant: "nightly",
        sourceCommit: "abc123",
        platform: "ios",
        osVersion: "18.6",
        truapiHostVersion: "0.25.0",
        truapiCoreVersion: "0.18.0",
        codecVersion: "3",
        schemaVersion: "1",
    }
    const root = { __trinityHostTelemetry: bootstrap } as unknown as typeof globalThis

    expect(readHostTelemetryContext(root)).toEqual(bootstrap)
    expect(hostTelemetryTags(readHostTelemetryContext(root))).toMatchObject({
      "host.session_id": ID,
      "host.native_app_version": "1.17.0",
      "host.app_build": "57",
      "truapi.codec_version": "3",
    })
  })

  it("accepts a valid session without optional build fields", () => {
    const root = { __trinityHostTelemetry: { hostSessionId: ID } } as unknown as typeof globalThis
    expect(readHostTelemetryContext(root)).toEqual({ hostSessionId: ID })
  })

  it.each([
    undefined,
    null,
    "context",
    {},
    { hostSessionId: "" },
    { hostSessionId: "not-a-uuid" },
    { hostSessionId: 7 },
  ])("ignores an absent or invalid bootstrap: %j", (value) => {
    const root = { __trinityHostTelemetry: value } as unknown as typeof globalThis
    expect(readHostTelemetryContext(root)).toBeNull()
    expect(hostTelemetryTags(readHostTelemetryContext(root))).toEqual({})
  })

  it("ignores a throwing bootstrap getter", () => {
    const root = Object.defineProperty({}, "__trinityHostTelemetry", {
      get() {
        throw new Error("native bootstrap failed")
      },
    }) as typeof globalThis
    expect(readHostTelemetryContext(root)).toBeNull()
  })

  it("ignores optional fields of the wrong type", () => {
    const root = {
      __trinityHostTelemetry: { hostSessionId: ID, appBuild: 57, schemaVersion: null },
    } as unknown as typeof globalThis
    expect(readHostTelemetryContext(root)).toEqual({ hostSessionId: ID })
  })
})
