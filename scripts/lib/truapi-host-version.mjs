// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Which `truapi-host` to install, read from the lockfile instead of written
// down. The CLI ships in the same paritytech/trinity-user-agents release
// as the `@parity/truapi` library the apps bundle (tag
// `@parity/truapi@<version>`), and the two speak one wire codec: a skew fails
// the first host call with `Malformed protocol error payload`, which looks
// like "not in a host". So the CLI to install is the version of the one
// `@parity/truapi` package-lock.json resolves. Shared by both products'
// dev-host launchers (scripts/dev-host.mjs, apps/humanity-app/scripts/dev-host.mjs).
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const INSTALLER_URL =
  "https://raw.githubusercontent.com/paritytech/trinity-user-agents/main/scripts/truapi-host-installer.sh"

/** The `@parity/truapi` version package-lock.json at `root` resolves, or null. */
export function lockedTruapiVersion(root) {
  try {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))
    return lock.packages?.["node_modules/@parity/truapi"]?.version ?? null
  } catch {
    return null
  }
}

/** The installer command for one version; the stable release when version is null. */
export function installCommand(version) {
  return `curl -fsSL ${INSTALLER_URL} | ${version ? `TRUAPI_HOST_VERSION=${version} ` : ""}bash`
}

/** "truapi-host 0.26.0" → "0.26.0"; null when no version is in the text. */
export function parseHostVersion(text) {
  return /\b(\d+\.\d+\.\d+[\w.+-]*)/.exec(text ?? "")?.[1] ?? null
}

/** `truapi-host --version` of the CLI on PATH, or null when there is none. */
export function installedHostVersion() {
  const r = spawnSync("truapi-host", ["--version"], { encoding: "utf8" })
  return r.error ? null : parseHostVersion(r.stdout || r.stderr)
}

/**
 * A warning when the installed CLI's major.minor differs from the lockfile's
 * `@parity/truapi` (the codec moves with the minor on 0.x), or null when they
 * agree or either is unknown.
 */
export function versionSkew(installed, locked) {
  if (!installed || !locked) return null
  const mm = (v) => v.split(".").slice(0, 2).join(".")
  if (mm(installed) === mm(locked)) return null
  return (
    `truapi-host ${installed} is installed, but the apps bundle @parity/truapi ${locked} (package-lock.json).\n` +
    "The two speak one wire codec, so host calls may fail with `Malformed protocol error payload`. Install the matching CLI:\n" +
    `  ${installCommand(locked)}`
  )
}
