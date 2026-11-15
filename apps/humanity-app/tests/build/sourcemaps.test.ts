// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, type Plugin } from "vite";
import { sentrySourceMaps } from "../../scripts/sourcemaps.ts";

// Replace only the upload boundary; run the real plugin's artifact preparation.
const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve("@sentry/vite-plugin/package.json"));
const bundlerDir = dirname(pluginRequire.resolve("@sentry/bundler-plugins/package.json"));
const { SentryCliAdapter } = await import(
  pathToFileURL(join(bundlerDir, "build/esm/core/cli.js")).href
) as {
  SentryCliAdapter: { prototype: {
    uploadSourcemaps(release: string, targets: { directory: string }[]): Promise<void>;
  } };
};

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root != null) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  vi.stubEnv("SENTRY_AUTH_TOKEN", "");
  vi.stubEnv("SENTRY_ORG", "");
  vi.stubEnv("SENTRY_PROJECT", "");
  vi.stubEnv("SENTRY_CLI_NO_TELEMETRY", "0");
  root = await mkdtemp(join(tmpdir(), "humanity-sourcemaps-"));
  await mkdir(join(root, "public/nested"), { recursive: true });
  await writeFile(join(root, "public/nested/copied.map"), "not for publication");
  await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, "main.js"), 'import("./lazy.js").then(m => m.probe());');
  await writeFile(join(root, "lazy.js"), 'export function probe() { throw new Error("map probe"); }');
  return root;
}

function fixtureBuild(root: string, plugins: Plugin[] = []) {
  return build({
    root,
    configFile: false,
    envDir: false,
    logLevel: "silent",
    plugins: [...sentrySourceMaps("humanity-test@1"), ...plugins],
    build: { outDir: "output", sourcemap: "hidden" as const },
  });
}

function runtimeDebugId(code: string): string | undefined {
  return /sentry-dbid-([\da-f-]{36})/.exec(code)?.[1];
}

async function publishedScripts(root: string): Promise<string[]> {
  const files = await readdir(join(root, "output"), { recursive: true });
  expect(files.some((file) => file.endsWith(".map"))).toBe(false);
  const scripts: string[] = [];
  for (const file of files.filter((file) => file.endsWith(".js"))) {
    const code = await readFile(join(root, "output", file), "utf8");
    expect(code).not.toMatch(/\/[/*][#@]\s*sourceMappingURL=/);
    expect(code).toContain("_sentryDebugIds");
    expect(runtimeDebugId(code)).toBeDefined();
    scripts.push(code);
  }
  expect(scripts).toHaveLength(2);
  return scripts;
}

describe("published source maps", () => {
  it.each(["no credentials", "incomplete credentials"])("keeps debug IDs and strips every map with %s", async (credentials) => {
    const root = await fixture();
    if (credentials === "incomplete credentials") vi.stubEnv("SENTRY_AUTH_TOKEN", "local-test-only");
    const captured = new Map<string, string>();
    const capture: Plugin = {
      name: "test:capture-before-deletion",
      writeBundle: {
        order: "pre",
        sequential: true,
        async handler() {
          for (const file of await readdir(join(root, "output/assets"))) {
            captured.set(file, await readFile(join(root, "output/assets", file), "utf8"));
          }
        },
      },
    };
    await fixtureBuild(root, [capture]);
    for (const code of await publishedScripts(root)) {
      const id = runtimeDebugId(code);
      expect(/debugId=([\da-f-]{36})/.exec(code)?.[1]).toBe(id);
      const maps = [...captured].filter(([name]) => name.endsWith(".map"));
      expect(maps.some(([, text]) => JSON.parse(text).debug_id === id)).toBe(true);
    }
  });

  it.each([false, true])("uploads exact debug-ID maps before deletion (failure=%s)", async (failUpload) => {
    const root = await fixture();
    vi.stubEnv("SENTRY_AUTH_TOKEN", "local-test-only");
    vi.stubEnv("SENTRY_ORG", "local-org");
    vi.stubEnv("SENTRY_PROJECT", "local-project");
    const preparedIds: string[] = [];
    const upload = vi.spyOn(SentryCliAdapter.prototype, "uploadSourcemaps").mockImplementation(async (release, targets) => {
      expect(release).toBe("humanity-test@1");
      expect(process.env["SENTRY_CLI_NO_TELEMETRY"]).toBe("1");
      const originalMaps = (await readdir(join(root, "output"), { recursive: true })).filter((f) => f.endsWith(".map"));
      expect(originalMaps).toHaveLength(3);
      for (const target of targets) {
        for (const file of await readdir(target.directory)) {
          if (!file.endsWith(".js.map")) continue;
          const map = JSON.parse(await readFile(join(target.directory, file), "utf8"));
          const code = await readFile(join(target.directory, file.slice(0, -4)), "utf8");
          expect(map.debug_id).toBe(runtimeDebugId(code));
          preparedIds.push(map.debug_id);
        }
      }
      expect(preparedIds).toHaveLength(2);
      if (failUpload) throw new Error("deliberate local upload failure");
    });
    if (failUpload) {
      await expect(fixtureBuild(root)).rejects.toThrow("deliberate local upload failure");
    } else {
      await fixtureBuild(root);
    }
    expect(upload).toHaveBeenCalledTimes(1);
    const scripts = await publishedScripts(root);
    expect(scripts.map(runtimeDebugId).sort()).toEqual(preparedIds.sort());
  });

  it("preserves an early build error when no output directory exists", async () => {
    const root = await fixture();
    await writeFile(join(root, "main.js"), 'import "./missing-module.js";');
    await expect(fixtureBuild(root)).rejects.toThrow(/missing-module/);
    await expect(readdir(join(root, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
