// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { drainStep } from "../../../../lab/shared/imported-game-admission.ts";
import { purseReason } from "../../lab/scenarios/pending-purse.ts";
import { assertPlan, assetKey, downloadArchive, lookupBundle, pinBundle, environmentTimes, guardTests, installPinnedBundle, legMetrics, legSummary, legVerdict, metricsMarkdown, outsideCounts, parseDisk, parseDuration, parseLeg, parseVmstat, readPin, refetchPinnedBundle, scenarioPhases, scenarioRows, type Leg } from "../../scripts/lab/scenarios-ci.mts";

const root = resolve(import.meta.dirname, "../../../..");
const lab = parse(readFileSync(resolve(root, ".github/workflows/humanity-lab.yml"), "utf8"));
const job = lab.jobs.scenarios;
const step = (name: string) => job.steps.find((entry: { name?: string }) => entry.name === name);
const runUrl = "https://github.com/paritytech/individuality-apps/actions/runs/123";

function planned(env: Record<string, string>, script: string = lab.jobs["scenario-legs"].steps[0].run): { legs: Leg[]; skipped: Array<Leg & { skip: string }>; notices: string } {
  const dir = mkdtempSync(join(tmpdir(), "scenario-legs-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  const notices = execFileSync("bash", ["-c", script], { env: { ...process.env, GITHUB_OUTPUT: output, ...env }, encoding: "utf8" });
  const lines = readFileSync(output, "utf8").trimEnd().split("\n");
  expect(lines.map((line) => line.split("=")[0])).toEqual(["legs", "skipped"]);
  const [legs, skipped] = lines.map((line) => JSON.parse(line.slice(line.indexOf("=") + 1)));
  return { legs, skipped, notices };
}
const plan = (env: Record<string, string>): Leg[] => planned(env).legs;
function select(leg: Leg, line = leg.line): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scenario-select-"));
  execFileSync("bash", ["-c", step("Select the leg's scenarios").run], { cwd: root, stdio: "pipe", env: { ...process.env, RUNNER_TEMP: dir,
    LEG_TAGS: leg.tags ?? "", LEG_FEATURE: leg.feature ?? "", LEG_LINE: line === undefined ? "" : String(line), LEG_EXAMPLE: leg.example ?? "", LEG_KIND: leg.kind } });
  return readFileSync(join(dir, "leg-selection"), "utf8").trimEnd().split("\n");
}
const embed = (value: unknown) => ({ mime_type: "application/json", data: Buffer.from(JSON.stringify(value)).toString("base64") });
const passing = (tag: string, line = 3, duration = 2e9) => ({ tags: [{ name: "@environment:paseo-copy" }, { name: `@${tag}` }], elements: [{ type: "scenario", name: tag, line, tags: [{ name: `@${tag}` }], steps: [
  { hidden: true, name: "", result: { status: "passed", duration } },
  { name: drainStep, result: { status: "passed", duration } },
  { name: "Ada is a new actor", result: { status: "passed", duration } },
] }] });
const a6Names = [drainStep, "Ada is a new actor", "Ada is a member", "the lab opens today's draw with a 1 dollar prize that Ada wins", "Ada opens the daily scratch", "Ada scratches today's ticket",
  "Ada's prize claim is finalized on chain to product account 0", "Ada's host Coinage purse answer is still Unsupported", "product account 0 grew by the PrizeClaimed amount", "Ada's Coinage purse grows by the prize within 60 seconds"];
const a6 = () => [{ tags: [{ name: "@A6" }], elements: [{ type: "scenario", name: "Ada's daily scratch pays into her Coinage purse", tags: [{ name: "@A6" }], steps: a6Names.map((name, index) =>
  index === a6Names.length - 1 ? { name, result: { status: "pending", duration: 1e9 }, embeddings: [embed({ status: "pending", reason: purseReason })] } : { name, result: { status: "passed", duration: 1e9 } }) }] }];
const { legs, skipped } = planned({ SCENARIOS: "true", A5_CONTROL: "false" });
const leg = (id: string) => legs.concat(plan({ SCENARIOS: "true", A5_CONTROL: "true" }), skipped).find((entry) => entry.id === id)!;

describe("scenario legs in the workflow", () => {
  it("plans seven legs on pull requests, adds A5-control only by dispatch input, and every leg parses", () => {
    expect(legs.map((entry) => entry.name)).toEqual(["A1+A2", "A3", "A4", "A5 AAAMM", "A5 MMAAA", "A5 AMAMA", "A6"]);
    expect(plan({ SCENARIOS: "true", A5_CONTROL: "true" }).map((entry) => entry.id).at(-1)).toBe("a5-control");
    expect(plan({ SCENARIOS: "false", A5_CONTROL: "true" }).map((entry) => entry.id)).toEqual(["a5-control"]);
    expect(plan({ SCENARIOS: "false", A5_CONTROL: "false" })).toEqual([]);
    for (const entry of [...legs, ...skipped, leg("a5-control")]) expect(parseLeg(JSON.stringify(entry))).toEqual(entry);
    const env = lab.jobs["scenario-legs"].steps[0].env;
    expect(env.A5_CONTROL).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.a5_control }}");
    expect(lab.on.workflow_dispatch.inputs.a5_control).toMatchObject({ type: "boolean", default: false });
  });
  it("runs A3 again now that the lab host takes the truAPI username fix, and a skip reason still keeps a leg out", () => {
    expect(skipped).toEqual([]);
    expect(planned({ SCENARIOS: "true", A5_CONTROL: "false" }).notices).toBe("");
    expect(leg("a3")).toMatchObject({ name: "A3", tags: "@A3", kind: "passed" });
    // Negative control: the planner still honours a skip reason, with workflow-command escaping on its notice.
    const reason = "100% sure\\r\\nWaits on a host";
    const script = (lab.jobs["scenario-legs"].steps[0].run as string).replace('"name": "A3",', '"name": "A3, x: y",').replace('"tags": "@A3"}', `"tags": "@A3", "skip": "${reason}"}`);
    const held = planned({ SCENARIOS: "true", A5_CONTROL: "false" }, script);
    expect(held.legs.map((entry) => entry.id)).not.toContain("a3");
    expect(held.skipped.map((entry) => entry.id)).toEqual(["a3"]);
    expect(held.notices).toBe("::notice title=A3%2C x%3A y SKIPPED::100%25 sure%0D%0AWaits on a host\n");
    expect(planned({ SCENARIOS: "false", A5_CONTROL: "true" }, script).skipped).toEqual([]);
    expect(lab.jobs["scenario-legs"].outputs.skipped).toBe("${{ steps.plan.outputs.skipped }}");
    expect(lab.jobs["scenarios-comment"].steps[1].env.SKIPPED).toBe("${{ needs.scenario-legs.outputs.skipped }}");
  });
  it("shares the opening's gate, runner and timeout, never its concurrency group, and is no gate itself", () => {
    expect(lab.jobs["scenario-legs"].if).toBe(lab.jobs.opening.if);
    expect(lab.jobs["scenario-legs"].needs).toEqual(["sources"]);
    expect(job["runs-on"]).toBe(lab.jobs.opening["runs-on"]);
    expect(job["timeout-minutes"]).toBe(lab.jobs.opening["timeout-minutes"]);
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job.concurrency.group).not.toBe(lab.jobs.opening.concurrency.group);
    expect(job.concurrency.group).toContain("${{ matrix.id }}");
    expect(job.concurrency["cancel-in-progress"]).toBe(lab.jobs.opening.concurrency["cancel-in-progress"]);
    expect(job.permissions).toBeUndefined();
    expect(job.env.PRODUCT_LAB_FORK_PORT_BASE).toBe(lab.jobs.opening.env.PRODUCT_LAB_FORK_PORT_BASE);
    expect(job.env.HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS).toBe("180000");
    expect(step("Run the leg on its own fresh Paseo copy").env.PRODUCT_LAB_FORK_BUNDLE).toBe("keep");
    expect(JSON.stringify(lab)).not.toContain("secrets.");
    for (const upload of job.steps.filter((entry: { uses?: string }) => entry.uses?.startsWith("actions/upload-artifact@"))) {
      expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
      expect(upload.if).toBe("always()");
      expect(upload.with["retention-days"]).toBe(14);
      expect(upload.with.path).not.toMatch(/scenarios-engine|cache|\.pem/);
    }
  });
  it("selects one Examples row per A5 leg and tags for the others", () => {
    expect(select(leg("a1-a2"))).toEqual(["--tags", "@A1 or @A2"]);
    expect(select(leg("a5-mmaaa"))).toEqual(["apps/humanity-app/lab/scenarios/a5-attendance.feature:19"]);
    expect(select(leg("a5-control"))).toEqual(["apps/humanity-app/lab/scenarios/wrong-attendance.feature", "--negative-control"]);
    const feature = readFileSync(resolve(root, "apps/humanity-app/lab/scenarios/a5-attendance.feature"), "utf8").split("\n");
    for (const id of ["a5-aaamm", "a5-mmaaa", "a5-amama"]) expect(feature[leg(id).line! - 1]).toContain(`| ${leg(id).example} `);
  });
  it("@negative-control refuses an A5 line that no longer holds its example", () => {
    expect(() => select(leg("a5-aaamm"), 19)).toThrow();
  });
});

type Workflow = { jobs: Record<string, { needs?: string[]; env?: Record<string, string>; outputs?: Record<string, string>; steps: Array<{ name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }> }> };
const pinned = "${{ needs.scenario-bundle.outputs.manifest-sha256 }}";
const legKey = "humanity-paseo-bundle-${{ needs.scenario-bundle.outputs.asset-key }}";
const setupKey = "humanity-paseo-bundle-${{ steps.lookup.outputs.asset-key }}";
/** Static check: one setup job looks up the asset, pins the bundle once (downloading only on a miss) and saves it under
 * the asset's key; every leg consumes the pin, restores exactly that key and verifies the pin before its run. */
function bundleViolations(workflow: Workflow): string[] {
  const problems: string[] = [];
  const legs = workflow.jobs.scenarios!, setup = workflow.jobs["scenario-bundle"];
  if (!setup) return ["no setup job"];
  if (!legs.needs?.includes("scenario-bundle")) problems.push("the legs do not need the setup job");
  if (legs.env?.BUNDLE_SHA256 !== pinned) problems.push("the legs do not take the setup job's hash");
  const restores = legs.steps.filter((step) => step.uses?.startsWith("actions/cache/"));
  const restore = restores[0];
  if (restores.length !== 1 || !restore?.uses?.match(/^actions\/cache\/restore@[0-9a-f]{40}$/) || restore.with?.key !== legKey || "restore-keys" in (restore.with ?? {}))
    problems.push("a leg restores something other than exactly the pinned asset's entry");
  const install = legs.steps.findIndex((step) => step.run === "node_modules/.bin/tsx apps/humanity-app/scripts/lab/scenarios-ci.mts bundle-install apps/humanity-app/.product-lab/paseo-bundle");
  const run = legs.steps.findIndex((step) => step.id === "leg");
  if (install < 0 || install < legs.steps.indexOf(restore!) || install > run) problems.push("a leg does not verify the pinned bundle before its run");
  if (legs.steps[install]?.env?.BUNDLE_CACHE_HIT !== "${{ steps.bundle_cache.outputs.cache-hit }}") problems.push("the install step does not know whether the restore hit");
  if (legs.steps[run]?.env?.PRODUCT_LAB_FORK_BUNDLE !== "keep") problems.push("the leg's run may fetch a bundle");
  for (const word of ["fetch-bundle", "bundle-pin", "cache/save", "actions/cache@", "latest", "PPN_BITE_TAG"]) if (JSON.stringify(legs).includes(word)) problems.push(`a leg mentions ${word}`);
  const lookups = setup.steps.filter((step) => step.run?.includes("scenarios-ci.mts bundle-lookup"));
  if (lookups.length !== 1 || lookups[0]!.id !== "lookup" || setup.outputs?.["asset-key"] !== "${{ steps.lookup.outputs.asset-key }}") problems.push("the setup job does not look the asset up exactly once");
  const pins = setup.steps.filter((step) => step.run?.includes("scenarios-ci.mts bundle-pin"));
  if (pins.length !== 1 || pins[0]!.id !== "pin" || setup.outputs?.["manifest-sha256"] !== "${{ steps.pin.outputs.manifest-sha256 }}") problems.push("the setup job does not pin exactly once");
  if (pins[0]?.env?.CACHED !== "${{ steps.pin_cache.outputs.cache-hit == 'true' && steps.bundle_cache.outputs.cache-hit == 'true' }}") problems.push("the pin may skip the download without both cached entries");
  const check = setup.steps.find((step) => step.id === "bundle_cache");
  if (check?.with?.key !== setupKey || check.with?.["lookup-only"] !== true) problems.push("the setup job restores the bundle instead of checking for it");
  const saves = setup.steps.filter((step) => step.uses?.startsWith("actions/cache/save@"));
  const save = saves.find((step) => step.with?.key === setupKey);
  if (saves.length !== 2 || !save || save.with?.path !== restore?.with?.path || saves.some((step) => (step as { if?: string }).if !== "steps.pin.outputs.cached == 'false'"))
    problems.push("the setup job does not save the downloaded bundle under the key the legs restore, and only after a download");
  for (const [name, job] of Object.entries(workflow.jobs)) if (name !== "scenario-bundle" && JSON.stringify(job).includes("scenarios-ci.mts bundle-pin")) problems.push(`${name} pins a bundle`);
  // The cleanup keeps the current asset's entries and prunes only this ref's older ones, after the legs, whatever they did.
  const cleanup = workflow.jobs["scenario-bundle-cleanup"] as Workflow["jobs"][string] & { if?: string } | undefined;
  const prune = cleanup?.steps.find((step) => step.run?.includes("gh cache delete"));
  if (!cleanup || !cleanup.needs?.includes("scenarios") || !cleanup.if?.startsWith("${{ always()") || prune?.env?.KEEP !== legKey ||
    prune.env?.KEEP_PIN !== "humanity-paseo-bundle-pin-${{ needs.scenario-bundle.outputs.asset-key }}" || !prune.run?.includes('--ref "$REF"')) problems.push("the cleanup may delete the entry the legs restore, or another ref's entries");
  return problems;
}

describe("one pinned Paseo bundle for every leg", () => {
  it("passes the static check: the setup job pins once and every leg consumes its hash", () => {
    expect(bundleViolations(lab)).toEqual([]);
    expect(lab.jobs["scenarios-comment"].steps[1].env.BUNDLE_SHA256).toBe(pinned);
  });
  it("@negative-control the static check rejects a leg that could resolve or restore another bundle", () => {
    const mutants: Array<(workflow: Workflow) => void> = [
      (workflow) => { workflow.jobs.scenarios!.steps.find((step) => step.id === "bundle_cache")!.with!.key = "humanity-paseo-bundle-latest"; },
      (workflow) => { workflow.jobs["scenario-bundle-cleanup"]!.steps[0]!.env!.KEEP = "humanity-paseo-bundle-${{ needs.scenario-bundle.outputs.manifest-sha256 }}"; },
      (workflow) => { workflow.jobs["scenario-bundle-cleanup"]!.steps[0]!.run = workflow.jobs["scenario-bundle-cleanup"]!.steps[0]!.run!.replace('--ref "$REF" ', ''); },
      (workflow) => { workflow.jobs["scenario-bundle"]!.steps.find((step) => step.id === "pin")!.env!.CACHED = "${{ steps.pin_cache.outputs.cache-hit == 'true' }}"; },
      (workflow) => { delete workflow.jobs["scenario-bundle"]!.steps.find((step) => step.id === "bundle_cache")!.with!["lookup-only"]; },
      (workflow) => { delete (workflow.jobs["scenario-bundle"]!.steps.find((step) => step.uses?.startsWith("actions/cache/save@")) as { if?: string }).if; },
      (workflow) => { delete workflow.jobs.scenarios!.steps.find((step) => step.id === "bundle")!.env; },
      (workflow) => { (workflow.jobs["scenario-bundle-cleanup"] as { if?: string }).if = "${{ success() }}"; },
      (workflow) => { workflow.jobs.scenarios!.steps.find((step) => step.id === "bundle_cache")!.with!["restore-keys"] = "humanity-paseo-bundle-"; },
      (workflow) => { workflow.jobs.scenarios!.steps.find((step) => step.id === "bundle")!.run = "node_modules/.bin/tsx apps/humanity-app/scripts/lab/scenarios-ci.mts bundle-pin apps/humanity-app/.product-lab/paseo-bundle"; },
      (workflow) => { workflow.jobs.scenarios!.env!.BUNDLE_SHA256 = ""; },
      (workflow) => { workflow.jobs.scenarios!.needs = ["scenario-legs"]; },
      (workflow) => { workflow.jobs.scenarios!.steps.find((step) => step.id === "leg")!.env!.PRODUCT_LAB_FORK_BUNDLE = "fresh"; },
    ];
    for (const mutate of mutants) {
      const workflow = structuredClone(lab) as Workflow;
      mutate(workflow);
      expect(bundleViolations(workflow)).not.toEqual([]);
    }
  });
  it("requires GitHub's SHA-256 digest for the asset key", () => {
    expect(assetKey({ digest: `sha256:${"ab".repeat(32)}` })).toBe("ab".repeat(32));
  });
  it("@negative-control refuses missing, malformed and non-sha256 digests", async () => {
    for (const digest of [undefined, null, "md5:abc", `sha512:${"ab".repeat(64)}`, "sha256:abc"]) {
      expect(() => assetKey({ digest })).toThrow(/requires a sha256: digest/);
      const api = vi.fn<typeof fetch>(async () => Response.json({ assets: [{ name: "fork-bundle-paseo-next-v2.tar.gz", digest }] }));
      await expect(lookupBundle({ repository: "owner/engine", tag: "bites" }, api)).rejects.toThrow(/requires a sha256: digest/);
      expect(api).toHaveBeenCalledTimes(1);
    }
  });
  it("@negative-control a late manifest cannot cause an archive read during metadata lookup", async () => {
    const { publishedBundle, MANIFEST_SEARCH_BYTES } = await import("@parity/product-lab/env-engine");
    const header = (name: string, size: number) => {
      const h = Buffer.alloc(512);
      h.write(name); h.write("0000644", 100); h.write(size.toString(8).padStart(11, "0"), 124);
      h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
      h.fill(32, 148, 156);
      h.write(h.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
      return h;
    };
    // Incompressible first entry puts manifest.json beyond the old compressed 48 MiB range.
    const snapshot = randomBytes(MANIFEST_SEARCH_BYTES + 1024 * 1024);
    const manifest = Buffer.from(JSON.stringify({ bittenAt: "2026-11-09T18:41:00Z" }));
    const archive = gzipSync(Buffer.concat([header("snapshots/relay.tgz", snapshot.length), snapshot,
      header("manifest.json", manifest.length), manifest, Buffer.alloc(512 - manifest.length + 1024)]), { level: 0 });
    const digest = createHash("sha256").update(archive).digest("hex");
    const release = { assets: [{ name: "fork-bundle-paseo-next-v2.tar.gz", digest: `sha256:${digest}`, browser_download_url: "https://example.invalid/bundle" }] };
    const publishedFetch = vi.fn<typeof fetch>(async (url) => String(url).startsWith("https://api.github.com/")
      ? Response.json(release) : new Response(archive.subarray(0, MANIFEST_SEARCH_BYTES)));
    const { NodeSystem, processEnvironment } = await import("@parity/product-lab/composition");
    const published = await publishedBundle({ files: new NodeSystem(processEnvironment()).files, checkout: ".", network: "paseo-next-v2", fetch: publishedFetch });
    expect(published.digest).toBe(`sha256:${digest}`);
    expect(published.snapshot).toBeUndefined();
    expect(publishedFetch).toHaveBeenCalledTimes(1);
    const metadataOnly = vi.fn<typeof fetch>(async (url) => {
      expect(url).toBe("https://api.github.com/repos/owner/engine/releases/tags/nightly%2Fbites");
      return Response.json(release);
    });
    const out = mkdtempSync(join(tmpdir(), "lookup-output-"));
    vi.stubEnv("GITHUB_OUTPUT", join(out, "outputs"));
    try {
      await lookupBundle({ repository: "owner/engine", tag: "nightly/bites" }, metadataOnly);
      expect(metadataOnly).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(out, "outputs"), "utf8")).toContain(`asset-key=${digest}\n`);
      expect(readFileSync(join(out, "outputs"), "utf8")).not.toContain("asset-bitten-at");
    } finally { vi.unstubAllEnvs(); }
  });
  it("checks the retained download's exact bytes", async () => {
    const bytes = Buffer.from("the complete downloaded tarball");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const file = join(mkdtempSync(join(tmpdir(), "archive-")), "bundle.tar.gz");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(bytes));
    await downloadArchive("https://example.invalid/bundle", file, digest, fetchImpl);
    expect(readFileSync(file)).toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("@negative-control refuses a changed download before publishing a bundle or pin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changed-bundle-"));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("different bytes"));
    const download = async () => {
      await downloadArchive("https://example.invalid/bundle", join(dir, "bundle.tar.gz"), "a".repeat(64), fetchImpl);
      throw Error("must not reach extraction or installation");
    };
    await expect(pinBundle(join(dir, "out"), join(dir, "pins"), "a".repeat(64), false, download)).rejects.toThrow("The published bundle changed during the download; re-run");
    expect(existsSync(join(dir, "out"))).toBe(false);
    expect(existsSync(join(dir, "pins"))).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("keeps the pin format and installed bite time after a verified download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "new-pin-")), target = join(dir, "installed"), key = "a".repeat(64);
    mkdirSync(target);
    writeFileSync(join(target, "manifest.json"), "{}");
    const download = vi.fn(async () => ({ target, pin: "b".repeat(64), source: "Engine release", bittenAt: "2026-11-09T18:41:00Z" }));
    vi.stubEnv("GITHUB_OUTPUT", join(dir, "outputs"));
    try {
      await pinBundle(join(dir, "out"), join(dir, "pins"), key, false, download);
      expect(download).toHaveBeenCalledTimes(1);
      expect(readPin(readFileSync(join(dir, "pins", "pin.json"), "utf8"), key)).toEqual({
        manifestSha256: "b".repeat(64), source: "Engine release", bittenAt: "2026-11-09T18:41:00Z", assetKey: key,
      });
      expect(readFileSync(join(dir, "out", "manifest.json"), "utf8")).toBe("{}");
    } finally { vi.unstubAllEnvs(); }
  });
  it("names the cached pin without a download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cached-pin-")), key = "a".repeat(64);
    const pin = { manifestSha256: "c".repeat(64), source: "Engine release", bittenAt: "2026-11-05T18:38:00Z", assetKey: key };
    writeFileSync(join(dir, "pin.json"), JSON.stringify(pin));
    const download = vi.fn(async () => { throw Error("cache hit must not download"); });
    vi.stubEnv("GITHUB_OUTPUT", join(dir, "outputs"));
    try {
      await pinBundle(join(dir, "unused"), dir, key, true, download);
      expect(download).not.toHaveBeenCalled();
      const result = readFileSync(join(dir, "outputs"), "utf8");
      expect(result).toContain(`manifest-sha256=${pin.manifestSha256}\n`);
      expect(result).toContain(`bitten-at=${pin.bittenAt}\n`);
      expect(result).toContain("cached=true\n");
      expect(result).toContain("seconds=0\n");
    } finally { vi.unstubAllEnvs(); }
  });
  it("accepts a cached pin only for the asset it was made for", () => {
    const pin = { manifestSha256: "c".repeat(64), source: "Engine release", bittenAt: "2026-11-05T18:38:00Z", assetKey: "k1" };
    expect(readPin(JSON.stringify(pin), "k1")).toEqual(pin);
    expect(() => readPin(JSON.stringify(pin), "k2")).toThrow(/not this bundle/);
    expect(() => readPin(JSON.stringify({ ...pin, manifestSha256: "latest" }), "k1")).toThrow(/not this bundle/);
  });
  it("re-fetches a missed bundle and uses it only when its manifest is the pin", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "refetch-")), "paseo-bundle");
    const fetched = (pin: string) => async () => { const target = mkdtempSync(join(tmpdir(), "fetched-")); writeFileSync(join(target, "manifest.json"), "{}"); return { target, pin }; };
    await expect(refetchPinnedBundle(out, "a".repeat(64), fetched("b".repeat(64)))).rejects.toThrow(/not the run's pinned/);
    expect(() => readFileSync(join(out, "manifest.json"))).toThrow();
    await refetchPinnedBundle(out, "a".repeat(64), fetched("a".repeat(64)));
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe("{}");
    await expect(refetchPinnedBundle(out, "a".repeat(64), fetched("a".repeat(64)))).rejects.toThrow(/restored bundle is present/);
    await expect(refetchPinnedBundle(out, "latest", fetched("a".repeat(64)))).rejects.toThrow(/No pinned/);
  });
  it("installs only a restored bundle whose manifest is the pin, and never downloads one", async () => {
    const restored = mkdtempSync(join(tmpdir(), "restored-bundle-"));
    writeFileSync(join(restored, "manifest.json"), "{}");
    await expect(installPinnedBundle(restored, "0".repeat(64), null)).rejects.toThrow(/not the pinned/);
    await expect(installPinnedBundle(restored, "latest", null)).rejects.toThrow(/No pinned/);
    expect(installPinnedBundle.toString()).not.toMatch(/spawn|fetch-bundle|ppn/);
  });
  it("fails a leg whose bundle after the run is not the pinned one", () => {
    const input = { rawExit: 0, classifierExit: 0, seconds: 60, videos: "", report: "" };
    const bundle = { pinned: "a".repeat(64), cacheHit: true, restoreSeconds: 40, used: "a".repeat(64) };
    expect(legSummary(leg("a3"), [passing("A3")], { ...input, bundle }).verdict).toBe("pass");
    expect(legSummary(leg("a3"), [passing("A3")], { ...input, bundle: { ...bundle, used: "b".repeat(64) } }).verdict).toBe("fail");
    expect(legSummary(leg("a3"), [passing("A3")], { ...input, bundle: { ...bundle, used: null } }).verdict).toBe("fail");
  });
});

describe("leg metrics", () => {
  const vmstat = ["procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----", " r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu",
    " 1  0      0 900000  10000  90000    0    0     1     1    1    1  5  1 94  0  0  0", " 4  0      0 500000  10000  90000    0    0     1     1    1    1 60 10 30  0  0  0",
    " 2  0      0 700000  10000  90000    0    0     1     1    1    1 20  5 75  0  0  0"].join("\n");
  it("reads whole-runner CPU and memory from vmstat, dropping the since-boot line", () => {
    expect(parseVmstat(vmstat, 2048000)).toEqual({ samples: 2, cpuPercent: { peak: 70, average: 47.5 }, memoryUsedMiB: { peak: 1414.1, average: 1316.4 }, memoryTotalMiB: 2000, memoryHeadroomMiB: 585.9 });
    expect(parseVmstat("", null)).toMatchObject({ samples: 0, cpuPercent: null, memoryUsedMiB: null });
  });
  it("reads the workspace disk's peak use and least free space, ignoring malformed lines", () => {
    expect(parseDisk("1700000000 1048576 9437184\n1700000005 2097152 8388608\nFilesystem 1024-blocks Used\n1700000010 1572864\n")).toEqual({ samples: 2, usedPeakMiB: 2048, availableMinMiB: 8192, totalMiB: 10240 });
    expect(parseDisk("")).toEqual({ samples: 0, usedPeakMiB: null, availableMinMiB: null, totalMiB: null });
  });
  it("reads the Paseo copy's start and stop from the run's log", () => {
    expect(parseDuration("8 min 17 s")).toBe(497);
    expect(parseDuration("25.8 s")).toBe(25.8);
    expect(parseDuration("1 h 2 min")).toBe(3720);
    expect(environmentTimes("Start\n  ✓ start the environment (5 min 17 s)\n  started in 5 min 17 s\nEnd\n  ✓ stop the environment (28.1 s)\n")).toEqual({ startSeconds: 317, starts: 1, stopSeconds: 28.1 });
  });
  it("splits each scenario's step times into the Given preconditions and the journey, and names steps it cannot classify", () => {
    const keywords = ["Given", "And", "And", "And", "When", "And", "Then", "And", "And", "And"];
    const report = a6();
    const steps = report[0]!.elements[0]!.steps as Array<Record<string, unknown>>;
    steps.forEach((step, index) => { step.keyword = `${keywords[index]} `; });
    steps.unshift({ keyword: "Before", hidden: true, name: "", result: { status: "passed", duration: 5e8 } });
    steps.push({ name: "an unlabelled step", result: { status: "passed", duration: 1e9 } });
    const [phases] = scenarioPhases(report, leg("a6"));
    expect(phases).toMatchObject({ label: "A6", preconditionSeconds: 4, journeySeconds: 6, hookSeconds: 0.5, unclassified: ["an unlabelled step"] });
    expect(phases!.steps.filter((step) => step.kind === "precondition").map((step) => step.name)).toEqual(a6Names.slice(0, 4));
    const metrics = legMetrics(leg("a6"), report, { vmstat, memTotalKiB: 2048000, cpus: 8, intervalSeconds: 5, samplerCpuSeconds: 0.4, phases: { "npm ci": 77 },
      log: "✓ start the environment (5 min 17 s)", bundle: { pinned: "a".repeat(64), cacheHit: true, restoreSeconds: 41 }, disk: "1700000000 1048576 9437184\n", setup: "fast" });
    const markdown = metricsMarkdown(metrics);
    for (const text of ["| CPU busy, peak / average (whole runner, 8 CPUs) | 70 % / 47.5 % |", "| Paseo copy start, start command to ready | 317 s |", "| Bundle restore and verification (cache hit) | 41 s |",
      "| Memory headroom at the peak | 585.9 MiB |", "| Workspace disk used, peak / least available (of 10240 MiB, 1 samples) | 1024 MiB / 9216 MiB |", "| Chain setup | fast |",
      "### A6: preconditions 4 s, journey 6 s, hooks 0.5 s", "| Given the lab drains imported games before the scenario | precondition |", "Unclassified steps: an unlabelled step"]) expect(markdown).toContain(text);
  });
});

describe("leg classification", () => {
  it("uses the classifier's exit codes: A6 pending is not a failure, exit 2 is not run", () => {
    expect(legVerdict("passed", 0, 0)).toBe("pass");
    expect(legVerdict("passed", 1, 0)).toBe("fail");
    expect(legVerdict("a6", 1, 0)).toBe("pending");
    expect(legVerdict("a6", 1, 1)).toBe("fail");
    // @negative-control: a raw exit other than the pending-only run's 1 fails A6 even when the classifier passes.
    expect(legVerdict("a6", 0, 0)).toBe("fail");
    expect(legVerdict("a6", 2, 0)).toBe("fail");
    expect(legVerdict("a6", null, 0)).toBe("fail");
    // @negative-control: a pending A6 whose copy failed to stop also exits 1; the cleanup report fails it.
    expect(legVerdict("a6", 1, 0, true)).toBe("fail");
    expect(legVerdict("passed", 0, 0, true)).toBe("fail");
    expect(legSummary(leg("a6"), a6(), { rawExit: 1, classifierExit: 0, seconds: 1, videos: "", report: "", cleanupFailed: true }).verdict).toBe("fail");
    expect(legVerdict("passed", 1, 2)).toBe("not-run");
    expect(legVerdict("negative", 0, 0)).toBe("pass");
    expect(legVerdict("passed", 0, null)).toBe("fail");
  });
  it("rows each scenario alone, labels A5 by its example and reports absent scenarios as not run", () => {
    const report = [passing("A1", 3, 2e9), passing("A2")];
    report[1]!.elements[0]!.steps[2]!.result.status = "failed";
    expect(scenarioRows(report, leg("a1-a2"))).toEqual([{ label: "A1", result: "pass", seconds: 6 }, { label: "A2", result: "fail", seconds: 6 }]);
    expect(scenarioRows([], leg("a1-a2")).map((entry) => entry.result)).toEqual(["not-run", "not-run"]);
    expect(scenarioRows([passing("A5", 19)], leg("a5-mmaaa"))).toEqual([{ label: "A5 MMAAA", result: "pass", seconds: 6 }]);
    expect(scenarioRows(a6(), leg("a6"))).toEqual([{ label: "A6", result: "pending", seconds: 10 }]);
    const refused = passing("A3");
    refused.elements[0]!.steps[1]!.result = { status: "failed", error_message: "not run: imported game drain: reporting", duration: 1 } as never;
    refused.elements[0]!.steps[2]!.result.status = "skipped";
    expect(scenarioRows([refused], leg("a3"))[0]!.result).toBe("not-run");
  });
  it("fails a leg whose report lacks one of its scenarios, even when the classifier passes the rest", () => {
    const input = { rawExit: 0, classifierExit: 0, seconds: 60, videos: "", report: "" };
    expect(legSummary(leg("a1-a2"), [passing("A1"), passing("A2")], input).verdict).toBe("pass");
    expect(legSummary(leg("a1-a2"), [passing("A1")], input).verdict).toBe("fail");
    expect(legSummary(leg("a3"), [], { ...input, classifierExit: 2 }).verdict).toBe("not-run");
  });
  it("@negative-control fails the A1+A2 leg on its guard tests, even when every scenario passes", () => {
    expect([guardTests("true", "success"), guardTests("true", "failure"), guardTests("true", "cancelled"), guardTests("true", "skipped"), guardTests("true", "")]).toEqual(["pass", "fail", "fail", "not-run", "fail"]);
    expect([guardTests("false", "skipped"), guardTests(undefined, undefined)]).toEqual([null, null]);
    const input = { rawExit: 0, classifierExit: 0, seconds: 60, videos: "", report: "" }, report = [passing("A1"), passing("A2")];
    expect(legSummary(leg("a1-a2"), report, { ...input, guardTests: "pass" })).toMatchObject({ verdict: "pass", guardTests: "pass" });
    const failed = legSummary(leg("a1-a2"), report, { ...input, guardTests: "fail" });
    expect(failed).toMatchObject({ verdict: "fail", guardTests: "fail" }); expect(failed.scenarios.map((entry) => entry.result)).toEqual(["pass", "pass"]);
    expect(legSummary(leg("a1-a2"), report, { ...input, guardTests: "not-run" }).verdict).toBe("fail");
    expect(legSummary(leg("a3"), [passing("A3")], input)).toMatchObject({ verdict: "pass", guardTests: null });
    // The summary step reads the guard step's outcome under the guard step's own leg condition.
    const guard = step("Run the real-browser guard tests"), summary = step("Summarize the leg");
    expect(guard.id).toBe("guard"); expect(guard.if).toContain("matrix.id == 'a1-a2'");
    expect(summary.env.GUARD_TESTS_EXPECTED).toBe("${{ matrix.id == 'a1-a2' }}"); expect(summary.env.GUARD_TESTS).toBe("${{ steps.guard.outcome }}");
    expect(job.steps.indexOf(guard)).toBeLessThan(job.steps.indexOf(summary));
  });
  it("@negative-control a dry run that plans another selection is refused", () => {
    expect(() => assertPlan([passing("A1"), passing("A2")], leg("a1-a2"))).not.toThrow();
    expect(() => assertPlan([passing("A1")], leg("a1-a2"))).toThrow(/plans A1, not A1, A2/);
    expect(() => assertPlan([passing("A5", 18), passing("A5", 19)], leg("a5-aaamm"))).toThrow();
  });
  it("counts outside requests once across snapshots and keeps not-blocked records visible", () => {
    const record = (id: number, decision: string, extra = {}) => ({ tag: "@A6", actor: "ada-1", id, at: `t${id}`, host: "https://example.invalid", source: "context", outside: true, decision, ...extra });
    const first = { productLab: "humanity-scenario-network", requests: [record(1, "blocked"), record(2, "sentry-local"), { ...record(9, "allowed"), outside: false }] };
    const last = { productLab: "humanity-scenario-network", requests: [...first.requests, record(3, "pending"), record(4, "allowed", { outsideFrameViolations: 2 })] };
    const report = a6();
    report[0]!.elements[0]!.steps[1]!.embeddings = [embed(first), embed({ productLab: "other" })] as never;
    report[0]!.elements[0]!.steps[2]!.embeddings = [embed(last)] as never;
    expect(outsideCounts(report)).toEqual({ attempted: 4, blocked: 1, sentryLocal: 1, pending: 1, notBlocked: 1, socketFrameViolations: 2, summaries: 2 });
    expect(outsideCounts([passing("A1")])).toBeNull();
  });
});

describe("scenarios section of the shared lab comment", () => {
  const writer = lab.jobs["scenarios-comment"].steps[1].with.script as string;
  const marker = "<!-- lab-opening-comment:v1 -->";
  const opening = "<!-- lab-opening:humanity:start -->\n## Humanity opening\n<!-- lab-opening:humanity:end -->";
  function store(initial?: string) {
    const comments = initial ? [{ id: 1, body: initial, user: { login: "github-actions[bot]", type: "Bot" } }] : [];
    let creates = 0;
    const issues = {
      listComments: () => {},
      getComment: async ({ comment_id }: { comment_id: number }) => ({ data: { ...comments.find((comment) => comment.id === comment_id)! } }),
      updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => { comments.find((comment) => comment.id === comment_id)!.body = body; },
      createComment: async ({ body }: { body: string }) => { creates++; comments.push({ id: comments.length + 1, body, user: { login: "github-actions[bot]", type: "Bot" } }); },
    };
    return { comments, creates: () => creates, github: { rest: { issues }, paginate: async () => comments.map((comment) => ({ ...comment })) }, core: { warning: () => {} } };
  }
  function summaries(entries: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "scenario-summaries-"));
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) writeFileSync(join(dir, `${(entry as { id: string }).id}.json`), JSON.stringify(entry));
    return dir;
  }
  async function execute(memory: ReturnType<typeof store>, env: Record<string, string>, runId = 123, source = writer) {
    const process = { env: { RESULT: "success", BUNDLE_RESULT: "success", LEGS: JSON.stringify(legs), GITHUB_RUN_ATTEMPT: "1", GITHUB_SERVER_URL: "https://github.com", BUNDLE_SHA256: pin, BUNDLE_SOURCE: "paritytech/previewnet-engine@bites fork-bundle-paseo-next-v2.tar.gz", BUNDLE_BITTEN_AT: "2026-11-06T02:00:00Z", BUNDLE_SECONDS: "95", ...env } };
    const context = { runId, repo: { owner: "paritytech", repo: "individuality-apps" }, issue: { number: 1661 } };
    await new Function("github", "context", "core", "process", "require", `return (async () => { ${source}\n })()`)(memory.github, context, memory.core, process, createRequire(import.meta.url));
    return memory.comments[0]!.body;
  }
  const pin = "c".repeat(64);
  const a6Summary = legSummary(leg("a6"), a6(), { rawExit: 1, classifierExit: 0, seconds: 1800, videos: `${runUrl}/artifacts/7`, report: `${runUrl}/artifacts/8`, bundle: { pinned: pin, cacheHit: true, restoreSeconds: 41, used: pin } });
  const a1Summary = legSummary(leg("a1-a2"), [passing("A1"), passing("A2")], { rawExit: 0, classifierExit: 0, seconds: 1380, videos: "https://elsewhere.invalid/1", report: `${runUrl}/artifacts/9` });

  it("adds its own section beside the opening's, with each scenario's result, duration and video", async () => {
    const memory = store(`${marker}\n\n# Local fork openings\n\n${opening}\n`);
    const body = await execute(memory, { SUMMARIES: summaries([a6Summary, a1Summary]) });
    expect(memory.creates()).toBe(0);
    expect(body).toContain(opening);
    expect(body).toContain("## Humanity scenarios A");
    expect(body).toContain(`[Run 123, attempt 1](${runUrl}) · Result: **PASS** · 1 PENDING`);
    expect(body).toContain(`| A6 | PENDING | 0 min 10 s | [Video](${runUrl}/artifacts/7) |`);
    expect(body).toContain("| A1 | PASS | 0 min 06 s | unavailable |");
    expect(body).toContain("| A4 | NOT RUN | unavailable | unavailable |");
    expect(body).toContain(`| A1+A2 | PASS | 23 min 00 s | unavailable | unavailable | unavailable |`);
    expect(body).toContain(`| A6 | PENDING | 30 min 00 s | hit | 0 min 41 s | yes | [Report](${runUrl}/artifacts/8) |`);
    expect(body).toContain("| A4 | UNAVAILABLE | unavailable | unavailable | unavailable | unavailable | unavailable |");
    expect(body).toContain("| A4 | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |");
    expect(body).toContain(`Paseo bundle: manifest SHA-256 \`${pin}\``);
    expect(body).toContain("downloaded once by the setup job in 1 min 35 s; every leg uses only this bundle.");
    // The per-leg metrics stay in each leg's artifact, never in the comment.
    expect(body).not.toMatch(/CPU|Memory|precondition|Paseo copy start/);
    expect(body).toContain("not a statement that nothing left the machine");
  });
  it("shows a skipped leg and its scenarios as SKIPPED with the plan's reason, escaped, after the legs that ran", async () => {
    // A3 ran skipped like this until the host took trinity-user-agents #1974; the comment must still show any held leg.
    const held = [{ ...leg("a3"), skip: "Waits on a truAPI release that includes trinity-user-agents #1974: main registers usernames under peopl/0 and the lab host still uses uid/0." }];
    const body = await execute(store(), { SUMMARIES: summaries([a6Summary, a1Summary]), SKIPPED: JSON.stringify(held), LEGS: JSON.stringify(legs.filter((entry) => entry.id !== "a3")) });
    expect(body).toContain(`[Run 123, attempt 1](${runUrl}) · Result: **PASS** · 1 PENDING · SKIPPED: A3`);
    const reason = held[0]!.skip.replace(/[&<>@[\]()*_`#|\r\n:~$!\\]/g, (char) => `&#${char.charCodeAt(0)};`);
    expect(body).toContain(`| A3 | SKIPPED: ${reason} | not run | none |`);
    expect(body).toContain("| A3 | SKIPPED | not run | not run | not run | not run | none |");
    expect(body.indexOf("| A3 | SKIPPED:")).toBeGreaterThan(body.indexOf("| A6 | PENDING |"));
    expect(body).not.toMatch(/\| A3 \| (NOT RUN|UNAVAILABLE|unavailable)/);
    const injected = [{ ...held[0], name: "A3 @everyone", scenarios: ["A3 <!-- x -->"], skip: "[l](u) @team" }];
    expect(await execute(store(), { SUMMARIES: summaries([]), SKIPPED: JSON.stringify(injected) })).not.toMatch(/<!-- x|@everyone|@team|\[l\]/);
    expect(await execute(store(), { SUMMARIES: summaries([]) })).not.toContain("SKIPPED");
  });
  it("keeps a newer run's section, creates the comment when absent and escapes labels", async () => {
    const memory = store();
    const first = await execute(memory, { SUMMARIES: summaries([]) }, 200);
    expect(memory.creates()).toBe(1);
    expect(first.startsWith(marker)).toBe(true);
    expect(await execute(memory, { SUMMARIES: summaries([a6Summary]) }, 100)).toBe(first);
    const injected = { ...a6Summary, scenarios: [{ label: "A6 <!-- x --> @everyone [l](u)", result: "pass", seconds: 1 }] };
    const body = await execute(store(), { SUMMARIES: summaries([injected]) });
    expect(body).not.toMatch(/<!-- x|@everyone|\[l\]/);
  });
  it("shows a leg on another bundle as NO and an unpinned run as unavailable", async () => {
    const other = { ...a6Summary, bundle: { ...a6Summary.bundle!, used: "d".repeat(64) } };
    expect(await execute(store(), { SUMMARIES: summaries([other]) })).toContain("| A6 | PENDING | 30 min 00 s | hit | 0 min 41 s | NO |");
    expect(await execute(store(), { SUMMARIES: summaries([a6Summary]), BUNDLE_SHA256: "not-a-hash" })).toContain("Paseo bundle: unavailable (no pinned manifest).");
    // A failed pin skips every leg; the section still replaces the older run's and says no leg ran.
    const unpinned = await execute(store(), { SUMMARIES: summaries([]), RESULT: "skipped", BUNDLE_RESULT: "failure", BUNDLE_SHA256: "" });
    expect(unpinned).toContain("Result: **FAIL**");
    expect(unpinned).toContain("Paseo bundle: the pin job failed, so no leg ran.");
    expect(unpinned).not.toContain("| A6 | PASS");
  });
  it("@negative-control names failed guard tests in the headline and the leg's row while its scenario rows pass", async () => {
    const report = [passing("A1"), passing("A2")], input = { rawExit: 0, classifierExit: 0, seconds: 1380, videos: "", report: `${runUrl}/artifacts/9` };
    const guardFailed = legSummary(leg("a1-a2"), report, { ...input, guardTests: "fail" });
    const body = await execute(store(), { SUMMARIES: summaries([guardFailed, a6Summary]), RESULT: "failure" });
    expect(body).toContain(`[Run 123, attempt 1](${runUrl}) · Result: **FAIL** · A1+A2 guard tests failed · 1 PENDING`);
    expect(body).toContain("| A1 | PASS | 0 min 06 s | unavailable |"); expect(body).toContain("| A2 | PASS | 0 min 06 s | unavailable |");
    expect(body).toContain("| A1+A2 | FAIL: guard tests failed | 23 min 00 s |");
    const unreached = await execute(store(), { SUMMARIES: summaries([legSummary(leg("a1-a2"), report, { ...input, guardTests: "not-run" })]), RESULT: "failure" });
    expect(unreached).toContain("Result: **FAIL** · A1+A2 guard tests did not run");
    // A leg failed by its scenarios, with passing guard tests, is not blamed on them.
    const scenarioFailed = await execute(store(), { SUMMARIES: summaries([legSummary(leg("a1-a2"), report, { ...input, rawExit: 1, guardTests: "pass" })]), RESULT: "failure" });
    expect(scenarioFailed).toContain("| A1+A2 | FAIL | 23 min 00 s |"); expect(scenarioFailed).not.toContain("guard tests");
    // The earlier writer, a bare FAIL beside all-PASS scenario rows, is caught.
    const mutant = writer.replace("const note = guardNote(summary);", "const note = '';");
    expect(mutant).not.toBe(writer);
    expect(await execute(store(), { SUMMARIES: summaries([guardFailed]), RESULT: "failure" }, 123, mutant)).not.toContain("guard tests failed");
  });
  it("@negative-control a writer that shows A6 pending as PASS is caught", async () => {
    const mutant = writer.replace("pending: 'PENDING'", "pending: 'PASS'");
    expect(mutant).not.toBe(writer);
    const body = await execute(store(), { SUMMARIES: summaries([a6Summary]) }, 123, mutant);
    expect(body).not.toContain("| A6 | PENDING |");
  });
});

describe("chain setup per event", () => {
  const setupFor = (expression: string, event: string) => expression === "${{ github.event_name == 'pull_request' && 'fast' || 'full' }}" ? (event === "pull_request" ? "fast" : "full") : "unknown";
  it("takes the fast setup on pull requests only; dispatched runs keep the full real setup", () => {
    expect(setupFor(job.env.HUMANITY_SCENARIOS_SETUP, "pull_request")).toBe("fast");
    expect(setupFor(job.env.HUMANITY_SCENARIOS_SETUP, "workflow_dispatch")).toBe("full");
    expect(lab.jobs["scenarios-comment"].steps[1].env.SETUP).toBe(job.env.HUMANITY_SCENARIOS_SETUP);
    expect(job.env.HUMANITY_SCENARIOS_VIDEO_SIZE).toBe("640x360");
    // The nightly and local runs set nothing, which is the full setup.
    expect(JSON.stringify(lab.jobs.opening)).not.toContain("HUMANITY_SCENARIOS_SETUP");
  });
  it("@negative-control a switch that is fast for every event is refused", () => {
    expect(setupFor("fast", "workflow_dispatch")).toBe("unknown");
    expect(setupFor("${{ 'fast' }}", "pull_request")).toBe("unknown");
  });
  it("uploads the disk samples and stops the disk sampler by its recorded start time", () => {
    expect(step("Upload the leg's report").with.path).toContain("disk.log");
    expect(step("Start the leg's resource sampler").run).toContain('df -Pk "$GITHUB_WORKSPACE"');
    const stop = step("Stop the leg's resource sampler");
    expect(stop.env.DISK_STARTED).toBe("${{ steps.sampler.outputs.disk_started }}");
    expect(stop.run).toContain('"$DISK_STARTED"');
  });
});
