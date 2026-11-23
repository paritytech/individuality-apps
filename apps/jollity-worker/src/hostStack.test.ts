// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Guards the host stack against drift by reading the committed package-lock.json.
 *
 * In issue #94 the worker ran `@novasamatech/host-api` on wire codec 1, while
 * the app and the host ran `@parity/truapi` on codec 2. The two stacks cannot
 * exchange a frame, and nothing failed when they drifted. The worker and the
 * app now share one `@parity/product-sdk-host` and one `@parity/truapi`, and
 * these tests fail the moment a second copy of either appears.
 *
 * The tests read only the filesystem and never touch the network.
 */
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"

const WORKER_MANIFEST_URL = new URL("../package.json", import.meta.url)
const ROOT_MANIFEST_URL = new URL("../../jollity-app/package.json", import.meta.url)
const LOCKFILE_URL = new URL("../../../package-lock.json", import.meta.url)
const SOURCE_URL = new URL("./", import.meta.url)

type LockEntry = { version?: string }

function readManifest(url: URL): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(url, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
}

function readLockfile(): { packages: Record<string, LockEntry> } {
  return JSON.parse(readFileSync(LOCKFILE_URL, "utf8")) as { packages: Record<string, LockEntry> }
}

describe("host stack shared by the app and the worker works", () => {
  it("the manifest of the worker carries no @novasamatech/* dependency", () => {
    // Given
    const manifest = readManifest(WORKER_MANIFEST_URL)
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }

    // When
    const novasamatech = Object.keys(dependencies).filter((name) => name.startsWith("@novasamatech/"))

    // Then
    expect(novasamatech).toEqual([])
  })

  it("the root manifest carries none either", () => {
    // Given
    const manifest = readManifest(ROOT_MANIFEST_URL)
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }

    // When
    const novasamatech = Object.keys(dependencies).filter((name) => name.startsWith("@novasamatech/"))

    // Then
    expect(novasamatech).toEqual([])
  })

  it("no source file of the worker imports @novasamatech/*", () => {
    // Given
    const sources = readdirSync(SOURCE_URL).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))

    // When
    const importing = sources.filter((file) => readFileSync(new URL(file, SOURCE_URL), "utf8").includes("@novasamatech/"))

    // Then
    expect(importing).toEqual([])
  })

  it("no @novasamatech/* package is in the tree at all", () => {
    // Given
    const { packages } = readLockfile()

    // When
    const novasamatech = Object.keys(packages).filter((path) => path.includes("@novasamatech/"))

    // Then
    expect(novasamatech).toEqual([])
  })

  it("exactly one @parity/product-sdk-host is resolved for the whole workspace", () => {
    // Given
    const { packages } = readLockfile()

    // When
    const sdkEntries = Object.keys(packages).filter((path) => path.endsWith("node_modules/@parity/product-sdk-host"))

    // Then
    expect(sdkEntries).toEqual(["node_modules/@parity/product-sdk-host"])
  })

  it("exactly one @parity/truapi is resolved for the whole workspace, so the wire version moves in one bump", () => {
    // Given
    const { packages } = readLockfile()

    // When
    const truapiEntries = Object.keys(packages).filter((path) => path.endsWith("node_modules/@parity/truapi"))
    const truapiVersion = packages["node_modules/@parity/truapi"]?.version

    // Then
    expect(truapiEntries).toEqual(["node_modules/@parity/truapi"])
    expect(truapiVersion).toBe("0.32.0")
  })
})

describe("truapi wire codec pin works", () => {
  it("is codec version 3 and wire schema 7c6a3a324db0decd. Bumping either must move with the host, never alone", async () => {
    // Given
    const truapi = await import("@parity/truapi")

    // When
    const { TRUAPI_CODEC_VERSION, TRUAPI_WIRE_SCHEMA_HASH } = truapi

    // Then
    expect(
      TRUAPI_CODEC_VERSION,
      "The truapi wire codec version changed. A peer on the other codec is refused at the handshake, " +
        "not negotiated in band, so this is a bump made together with the host, never a silent update.",
    ).toBe(3)
    expect(
      TRUAPI_WIRE_SCHEMA_HASH,
      "The truapi wire schema hash changed, so a method moved even though the codec did not. " +
        "product-sdk-host 0.35 pairs with truapi 0.32 hosts, whose schema is 7c6a3a324db0decd.",
    ).toBe("7c6a3a324db0decd")
  })
})

describe("decoding the answer of a host older than truapi 0.27 fails", () => {
  it("with a RangeError, which the app and the worker report as the version older than truapi 0.27", async () => {
    // Given
    const { VersionedHostInfoError, VersionedHostInfoResponse } = await import("@parity/truapi")
    const { CallError, Result } = await import("@parity/truapi/scale")
    const answerCodec = Result(VersionedHostInfoResponse, CallError(VersionedHostInfoError))
    const answer = answerCodec.enc({
      success: true,
      value: { tag: "V1", value: { platform: "Ios", name: "Polkadot", version: "1.4.2", truapiVersion: "" } },
    })
    // An empty truapiVersion is its one length byte. slice copies, since the decoder reads past the end of a view.
    const olderAnswer = answer.slice(0, -1)

    // When
    const decode = () => answerCodec.dec(olderAnswer)

    // Then
    expect(
      decode,
      "truapi no longer throws a RangeError on a HostInfo without truapiVersion. readHostInfoResult in the app " +
        "and hostInfo in the worker label an older host by that error, so update both to the new behaviour.",
    ).toThrow(RangeError)
  })
})
