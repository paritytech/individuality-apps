// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const worker = resolve(import.meta.dirname, "..");
const root = resolve(worker, "../..");
const localEnv = {
  VITE_NETWORK: "local",
  VITE_LOCAL_PEOPLE_WS_URL: "ws://127.0.0.1:9944",
  VITE_LOCAL_PEOPLE_GENESIS_HASH: `0x${"12".repeat(32)}`,
  VITE_LOCAL_ASSET_HUB_WS_URL: "ws://127.0.0.1:9945",
  VITE_LOCAL_ASSET_HUB_GENESIS_HASH: `0x${"34".repeat(32)}`,
};

let fixture: string;
let app: string;

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "humanity-env-config-")));
  app = join(fixture, "apps/humanity-app");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(fixture, "apps/humanity-worker"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  copyFileSync(join(worker, "vite.config.ts"), join(fixture, "apps/humanity-worker/vite.config.ts"));
  copyFileSync(join(worker, "package.json"), join(fixture, "apps/humanity-worker/package.json"));
  copyFileSync(join(root, "apps/humanity-app/scripts/app-release.mjs"), join(app, "scripts/app-release.mjs"));
  writeFileSync(join(fixture, "apps/humanity-worker/.env.local"), "VITE_NETWORK=paseo-next-v2\n");
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function loadConfig(values: Record<string, string>, mode = "production") {
  writeFileSync(join(app, ".env.local"), Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n"));
  // Keep a developer's shell and Vitest's pinned VITE_NETWORK out of the fixture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITE_")));
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { resolveConfig } from "vite";
    const config = await resolveConfig({ root: "apps/humanity-worker", mode: process.argv[1], logLevel: "silent" }, "build");
    console.log(JSON.stringify({ envDir: config.envDir, env: config.env, testNetwork: config.test.env.VITE_NETWORK }));
  `, mode], { cwd: fixture, env: { ...env, GITHUB_SHA: "1234567" }, encoding: "utf8" });
}

describe("worker environment files", () => {
  it("allows pinned unit tests with incomplete local build settings", () => {
    const result = loadConfig({ VITE_NETWORK: "local" }, "test");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).testNetwork).toBe("paseo-next-v2");
  });

  it.each(["local", "previewnet"])("uses the app's %s settings even when the worker folder selects Paseo", (network) => {
    const values = { ...localEnv, VITE_NETWORK: network };
    const result = loadConfig(values);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config.envDir).toBe(app);
    expect(config.env).toMatchObject(values);
  });

  it.each(["production", "development"])("validates local values from the app's env file in %s mode", (mode) => {
    const { VITE_LOCAL_ASSET_HUB_GENESIS_HASH: _missing, ...values } = localEnv;
    const result = loadConfig(values, mode);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("VITE_LOCAL_ASSET_HUB_GENESIS_HASH is required when VITE_NETWORK=local");
  });
});
