// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  installCommand,
  lockedTruapiVersion,
  parseHostVersion,
  versionSkew,
} from "./lib/truapi-host-version.mjs"

const root = resolve(__dirname, "..")

describe("the truapi-host version comes from the lockfile", () => {
  it("reads the one @parity/truapi the repository resolves", () => {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))
    expect(lockedTruapiVersion(root)).toBe(lock.packages["node_modules/@parity/truapi"].version)
  })

  it("is null without a lockfile or without the package", () => {
    const dir = mkdtempSync(join(tmpdir(), "truapi-lock-"))
    expect(lockedTruapiVersion(dir)).toBeNull()
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: {} }))
    expect(lockedTruapiVersion(dir)).toBeNull()
  })

  it("pins the installer to that version, or takes the stable release without one", () => {
    expect(installCommand("0.26.0")).toMatch(/trinity-user-agents\/main\/scripts\/truapi-host-installer\.sh \| TRUAPI_HOST_VERSION=0\.26\.0 bash$/)
    expect(installCommand(null)).toMatch(/installer\.sh \| bash$/)
  })

  it("parses what `truapi-host --version` prints", () => {
    expect(parseHostVersion("truapi-host 0.26.0\n")).toBe("0.26.0")
    expect(parseHostVersion("truapi-host 0.27.0-rc.1")).toBe("0.27.0-rc.1")
    expect(parseHostVersion("")).toBeNull()
  })

  it("warns only when major.minor differ", () => {
    expect(versionSkew("0.26.3", "0.26.0")).toBeNull()
    expect(versionSkew(null, "0.26.0")).toBeNull()
    expect(versionSkew("0.23.0", null)).toBeNull()
    const warning = versionSkew("0.23.0", "0.26.0")
    expect(warning).toContain("truapi-host 0.23.0 is installed")
    expect(warning).toContain("TRUAPI_HOST_VERSION=0.26.0")
  })
})
