// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const app = resolve(__dirname, "../..");
const root = resolve(app, "../..");

/**
 * `setup.ts` probes `bulletin-deploy --version` before it prints the plan, so
 * the runs below put a stand-in on PATH that answers with the minimum version
 * and nothing else. The descriptor cross-check is skipped (no network in tests).
 */
let shimDir: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "humanity-setup-test-"));
  const shim = join(shimDir, "bulletin-deploy");
  writeFileSync(shim, "#!/bin/sh\necho 0.25.0\n");
  chmodSync(shim, 0o755);
});

afterAll(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

/** Runs the script with the deploy variables cleared, whatever `.env` holds. */
function setup(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(app, "scripts/setup.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env["PATH"] ?? ""}`,
        // Set-but-empty beats the app's `.env` cascade, which only fills
        // variables that are absent, so a developer's own key stays out.
        DOTNS_MNEMONIC: "",
        MNEMONIC: "",
        DOTNS_LABEL: "",
        BULLETIN_ENV: "",
        VITE_NETWORK: "",
        HUMANITY_SETUP_SKIP_STACK_CHECK: "1",
        ...env,
      },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("npm run humanity:setup -- --dry-run", () => {
  it("refuses a local build as a public deploy target", () => {
    const run = setup(["--dry-run"], { VITE_NETWORK: "local" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('VITE_NETWORK="local" is not a deployable network.');
  });

  it("plans a preview deploy with no mnemonic and no label set", () => {
    const run = setup(["--env", "preview", "--dry-run"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("domain:           peopl.testnet (DOTNS_LABEL unset; the product's own name)");
    expect(run.stdout).toContain("product domain:   peopl.testnet");
    expect(run.stdout).toContain("deploy key:       none; a deploy needs DOTNS_MNEMONIC");
    expect(run.stdout).toContain("Dry run: nothing was built or deployed.");
  });

  it("plans for the label that is set, and reports a key that is set", () => {
    const run = setup(["--env", "preview", "--dry-run"], {
      DOTNS_LABEL: "peoplnext",
      DOTNS_MNEMONIC: "one two three four five six seven eight nine ten eleven twelve",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("domain:           peoplnext.testnet\n");
    expect(run.stdout).toContain("deploy key:       set (12 words)");
  });

  it("still refuses a malformed phrase", () => {
    const run = setup(["--env", "preview", "--dry-run"], { DOTNS_MNEMONIC: "too short" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Deploy mnemonic has 2 words; expected 12 or 24.");
  });
});

describe("npm run humanity:setup (a deploy)", () => {
  it("refuses without a label, before anything else", () => {
    const run = setup(["--env", "preview", "--skip-build"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("DOTNS_LABEL is required.");
  });

  it("refuses without a mnemonic rather than let the CLI use its dev phrase", () => {
    const run = setup(["--env", "preview", "--skip-build"], { DOTNS_LABEL: "peopl" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("No deploy mnemonic found.");
    expect(run.stderr).toContain("bulletin-deploy would fall back to a shared dev account");
    // The plan was printed, but no deploy step ran: the stand-in CLI only
    // ever answered --version.
    expect(run.stdout).not.toContain("Deployed");
  });
});
