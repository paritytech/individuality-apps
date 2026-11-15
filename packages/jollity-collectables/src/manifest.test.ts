// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { manifestPicture } from "./manifest"

const bytesOf = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))

const THUMBNAIL = { cid: "bafythumbnail", mime: "image/webp" }
const BASE_IMAGE = { cid: "bafybaseimage", mime: "image/png" }

describe("reading the picture of a manifest works", () => {
  it("picks the thumbnail over the base image", () => {
    // Given
    const bytes = bytesOf({ assets: { thumbnail: THUMBNAIL, baseImage: BASE_IMAGE } })

    // When
    const picture = manifestPicture(bytes)

    // Then
    expect(picture).toEqual(THUMBNAIL)
  })

  it("falls back to the base image when the thumbnail names no CID", () => {
    // Given
    const bytes = bytesOf({ assets: { thumbnail: { mime: "image/webp" }, baseImage: BASE_IMAGE } })

    // When
    const picture = manifestPicture(bytes)

    // Then
    expect(picture).toEqual(BASE_IMAGE)
  })
})

describe("reading the picture of a manifest fails", () => {
  it("is null for bytes that are not JSON", () => {
    // Given
    const bytes = bytesOf("\u0089PNG not a manifest")

    // When
    const picture = manifestPicture(bytes)

    // Then
    expect(picture).toBeNull()
  })

  it.each([
    ["JSON null", "null"],
    ["a JSON number", "7"],
  ])("is null for bytes that are %s rather than a manifest", (_label, text) => {
    // Given
    const bytes = bytesOf(text)

    // When
    const picture = manifestPicture(bytes)

    // Then
    expect(picture).toBeNull()
  })

  it("is null for a manifest that names neither picture", () => {
    // Given
    const bytes = bytesOf({ assets: { animation: { cid: "bafyanimation" } } })

    // When
    const picture = manifestPicture(bytes)

    // Then
    expect(picture).toBeNull()
  })
})
