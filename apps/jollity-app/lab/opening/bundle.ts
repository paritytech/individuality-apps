// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
/** Discard only this opening's private bundles. Engine tooling/binaries remain prepared. */
export function discardForkBundles(cache: string) {
  const tooling = join(cache, "engine", "tooling");
  let keys;
  try { keys = readdirSync(tooling, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue;
    const workspace = join(tooling, key.name, "workspace");
    let names;
    try { names = readdirSync(workspace); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) if (name.startsWith("fork-bundle-paseo-next-v2")) rmSync(join(workspace, name), { recursive: true, force: true });
  }
}
