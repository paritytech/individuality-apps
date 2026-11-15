// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRelease } from "../../scripts/app-release.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const app = new URL("../../package.json", import.meta.url);
const worker = new URL("../../../humanity-worker/package.json", import.meta.url);
const version = (url: URL): string => JSON.parse(readFileSync(url, "utf8")).version;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("Sentry release names", () => {
  it.each([[app, "humanity-app"], [worker, "humanity-worker"]] as const)(
    "keeps the product, version and CI commit for %s",
    (manifest, product) => {
      vi.stubEnv("GITHUB_SHA", "abcdef0123456789abcdef0123456789abcdef0123");
      const release = appRelease(manifest);
      expect(release).toBe(`${product}@${version(manifest)}+abcdef0`);
      expect(release).not.toContain("/");
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it("uses the local git commit when no CI SHA is set", () => {
    vi.stubEnv("GITHUB_SHA", "");
    vi.mocked(execFileSync).mockReturnValue("1234567\n");
    expect(appRelease(app)).toBe(`humanity-app@${version(app)}+1234567`);
  });

  it("retains product and version when git is unavailable", () => {
    vi.stubEnv("GITHUB_SHA", "");
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("git unavailable"); });
    expect(appRelease(app)).toBe(`humanity-app@${version(app)}`);
  });
});
