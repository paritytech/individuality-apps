// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The release string a build stamps into `envConfig.telemetry.release`
 * (`__APP_RELEASE__`): `<product>@<version>+<short sha>`, so a Sentry issue
 * names the shipped version and the commit behind it. The sha comes from
 * `GITHUB_SHA` (a GitHub Actions build) or `git`; with neither it is left off
 * rather than invented.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function appRelease(packageJsonUrl) {
  const { name, version } = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  // Relay removes releases containing slashes; the upload API rejects them too.
  const product = name.replace(/^@/, "").replaceAll("/", "-");
  let sha = (process.env["GITHUB_SHA"] ?? "").slice(0, 7);
  if (sha === "") {
    try {
      sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      sha = "";
    }
  }
  return sha === "" ? `${product}@${version}` : `${product}@${version}+${sha}`;
}
