// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { prepareLockedDotCli } from "./locked-dot-cli.mts";
// Check, prepare or run the current Humanity source flow on an owned local fork.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freemem, totalmem } from "node:os";
import { createRequire } from "node:module";
import { NodeSystem, processEnvironment } from "@parity/product-lab/composition";
import { acquireTruapiHost } from "@parity/product-lab/host-truapi-cli";
import { hostSelection } from "../../lab/opening/session.ts";

import { sourceBuildCommands, sourceBuildEnvironment, assertHumanityDebugPanel } from "../../../../lab/shared/build.ts";
import { writeScenarioSummary } from "../../../../.github/lab-scenario-summary.mts";
import { cutDemos } from "../../lab/flows/demo.mjs";
import { assertFlowReport } from "../../lab/flows/contract.ts";
import { writeFlowRecording } from "../../lab/flows/recording.ts";
import { resetRunReports } from "../../lab/flows/run-reports.ts";
import { validateSourceApps } from "../../../../lab/shared/apps.ts";

const app = fileURLToPath(new URL("../../", import.meta.url));
const root = resolve(app, "../..");
const require = createRequire(join(root, "package.json"));
const cli = join(root, "node_modules/.bin/product-lab");
const state = join(app, ".product-lab");
const reports = join(state, "flow-reports");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const phases: Array<{ command: string; seconds: number; exit: number | null }> = [];
const args = process.argv.slice(2);
const mode = args.shift();
const allowed = mode === "prepare" ? ["--engine", "locked"] : mode === "run" ? ["--fresh", "--negative-control"] : mode === "demo" ? ["--failed", "--plan"] : [];
if (args.some((arg) => !allowed.includes(arg))) throw new Error("Unknown flow argument");
if (mode === "prepare" && args.length && args.join(" ") !== "--engine locked") throw new Error("Only --engine locked is supported");
if (mode === "run" && !args.includes("--fresh")) throw new Error("Use --fresh: players must be created in this run");
process.env.PRODUCT_LAB_CACHE_DIR ??= join(state, "cache");
process.env.PRODUCT_LAB_FORK_BUNDLE = "fresh";
delete process.env.PRODUCT_LAB_KEEP;
for (const key of ["PORT", "PORTS", "PORT_LAST"]) delete process.env[key];
mkdirSync(reports, { recursive: true });


async function command(file: string, argv: string[], cwd = app, capture = false, environment = process.env): Promise<string> {
  const started = Date.now();
  const child = spawn(file, argv, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; if (!capture) process.stdout.write(chunk); });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
    phases.push({ command: (file === "node" ? argv[0] ?? file : file).replaceAll("\\", "/").split("/").at(-1) ?? "unknown", seconds: (Date.now() - started) / 1000, exit: code });
    console.log(`${phases.at(-1)!.command}: ${((Date.now() - started) / 1000).toFixed(1)}s, exit ${code}`);
    if (code !== 0) throw new Error(`${phases.at(-1)!.command} failed (${code})`);
    return stdout;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  }
}
function versions() {
  if (spawnSync("node", ["--version"], { encoding: "utf8" }).stdout?.trim() !== process.version) throw new Error("PATH node differs from the running Node version");
  const manifest = read(join(root, "package.json"));
  const lock = read(join(root, "package-lock.json"));
  if (manifest.devDependencies["@parity/product-lab"] !== "0.6.0" || manifest.overrides["@parity/product-lab"]?.["@parity/truapi-host"] !== "0.27.0") throw new Error("The lab pin or scoped host override drifted");
  for (const [name, version] of [["@parity/product-sdk-host", "0.31.0"], ["@parity/truapi", "0.27.0"], ["@parity/truapi-host", "0.27.0"], ["@parity/product-lab", "0.6.0"]]) {
    const rows = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
    if (rows.length !== 1 || (rows[0]![1] as { version: string }).version !== version) throw new Error(`Expected one ${name} ${version} in the root lock`);
    const installed = read(join(root, rows[0]![0], "package.json"));
    if (installed.version !== version) throw new Error(`Installed ${name} differs from the qualified version`);
  }
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function bindingReport(directory: string) {
  const paths = files(directory).filter((path) => path.endsWith(".json"));
  if (!paths.length) throw new Error("No feature binding report");
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    if (/"status"\s*:\s*"(?:undefined|ambiguous)"/i.test(text)) throw new Error(`Unbound or ambiguous steps: ${path}`);
  }
}
async function cleanup() {
  const system = new NodeSystem(processEnvironment());
  const result = await system.processes.reapAbandoned(state, { maxDepth: 12 });
  if (result.failed.length) throw new Error("Owned process cleanup failed");
  return result;
}
function resourceSample() {
  const optional = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
  const processes = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu="], { encoding: "utf8", timeout: 5000 }).stdout;
  const rows = (processes ?? "").trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) if (pid && parent && descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
  }
  const tree = rows.filter(([pid]) => pid !== undefined && descendants.has(pid));
  const disk = statfsSync(root);
  return { at: new Date().toISOString(), totalMemory: totalmem(), freeMemory: freemem(),
    linuxMemory: optional("/proc/meminfo"), oomEvents: optional("/sys/fs/cgroup/memory.events"),
    processRssKiB: tree.reduce((sum, row) => sum + (row[2] ?? 0), 0),
    cpuPercent: tree.reduce((sum, row) => sum + (row[3] ?? 0), 0),
    availableDisk: disk.bavail * disk.bsize };
}
async function main() {
  if (mode === "cleanup") { await cleanup(); return; }
  versions();
  validateSourceApps();
  if (mode === "demo") {
    const run = read(join(reports, "last-run.json"));
    if ((!run.passed || run.control) && !args.includes("--failed")) throw new Error("A failed run or negative control demo requires --failed");
    const result = cutDemos({ runsDir: run.recordingsDirectory, out: process.env.HUMANITY_FLOW_DEMO_DIR ?? join(state, "flow-demo", run.id), workDir: join(state, "flow-edit", run.id), failed: args.includes("--failed"), plan: args.includes("--plan") });
    if (result.errors.length || result.demos.length !== 3) throw new Error(`Flow demo needs all three actors: ${JSON.stringify(result.errors)}`);
    return;
  }
  if (mode === "check") {
    await command("node", [join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.flow.json", "--noEmit"]);
    await command("node", [join(root, "node_modules/.bin/vitest"), "run", "tests/flow"]);
    await command("node", [cli, "check", "--config", "lab.flow.config.ts"]);
    await command("node", [cli, "lint", "--config", "lab.flow.config.ts"]);
    for (const control of [false, true]) {
      const directory = join(reports, control ? "plan-control" : "plan-positive");
      rmSync(directory, { recursive: true, force: true });
      await command("node", [cli, "test", `lab/flows/humanity-dim2${control ? "-wrong-credits" : ""}.feature`, "--config", "lab.flow.config.ts", "--dry-run", "--report-dir", directory, ...(control ? ["--negative-control"] : [])]);
      bindingReport(directory);
    }
    return;
  }
  if (mode !== "prepare" && mode !== "run") throw new Error("Use check, prepare, run, demo or cleanup");
  const disk = statfsSync(root);
  if (disk.bavail * disk.bsize < 30e9) throw new Error("At least 30 GB free is required before a fork run");
  // Repository-local exclusion; shared machines must additionally use their machine slot command around this wrapper.
  const lock = join(state, "flow.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const samples = [resourceSample()];
  const sampler = setInterval(() => samples.push(resourceSample()), 5000);
  const jobStarted = Date.now();
  try {
    if (mode === "run") resetRunReports(reports);
    const system = new NodeSystem(processEnvironment());
    const host = await acquireTruapiHost({ ...hostSelection, commands: system.commands, patches: [] });
    writeFileSync(join(reports, "host.json"), JSON.stringify(host, null, 2) + "\n");
    if (mode === "prepare") {
      prepareLockedDotCli(root, process.env.PRODUCT_LAB_CACHE_DIR!);
      await command("node", [cli, "fetch", "--config", "lab.flow.config.ts", "--environment", "paseo-copy"]);
      const playwright = join(createRequire(require.resolve("@parity/product-lab/package.json")).resolve("playwright/package.json"), "../cli.js");
      await command("node", [playwright, "install", "chromium"]);
      await command("node", [cli, "doctor", "--config", "lab.flow.config.ts", "--environment", "paseo-copy"]);
      return;
    }
    const control = args.includes("--negative-control");
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${control ? "control" : "positive"}`;
    const directory = join(reports, id);
    const forkDirectory = join(state, "forks", id);
    mkdirSync(directory, { recursive: true });
    process.env.HUMANITY_FLOW_FORK_DIRECTORY = forkDirectory;
    const recordingsDirectory = join(process.env.PRODUCT_LAB_RECORDINGS_DIR ?? join(state, "flow-recordings"), id);
    process.env.PRODUCT_LAB_RECORDINGS_DIR = recordingsDirectory;
    process.env.PRODUCT_LAB_RECORDINGS = "frames";
    process.env.PRODUCT_LAB_RECORDINGS_HOST_LOGS = "off";
    // Both source builds happen on every run, before any fork starts. Never select a released counterpart.
    Object.assign(process.env, sourceBuildEnvironment);
    for (const key of ["NEXT_PUBLIC_TRUAPI_HOST_PORT", "NEXT_PUBLIC_PEOPLE_WS", "NEXT_PUBLIC_BASE_PATH"]) delete process.env[key];
    const buildEnvironment = { ...process.env };
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) delete buildEnvironment[key];
    for (const build of sourceBuildCommands) await command(build.command, [...build.args], root, false, buildEnvironment);
    assertHumanityDebugPanel(join(app, "dist"));
    const started = Date.now();
    const source = {
      commit: (await command("git", ["rev-parse", "HEAD"], root, true)).trim(),
      tree: (await command("git", ["rev-parse", "HEAD^{tree}"], root, true)).trim(),
      patchSha256: sha(await command("git", ["diff", "HEAD", "--binary"], root, true)),
      lockSha256: sha(readFileSync(join(root, "package-lock.json"))),
    };
    let passed = false;
    try {
      await command("node", [cli, "test", `lab/flows/humanity-dim2${control ? "-wrong-credits" : ""}.feature`, "--config", "lab.flow.config.ts", "--own-lab", "--video", "--report-dir", directory, ...(control ? ["--negative-control"] : [])]);
      assertFlowReport(read(join(directory, "product-lab-test.json")), control);
      passed = true;
    } finally {
      // Never upload a fork, host wallet, raw host logs or saved players.
      const sanitized = join(reports, "sanitized");
      mkdirSync(sanitized, { recursive: true });
      const reportFile = join(directory, "product-lab-test.json");
      // Product-lab 0.1.0 made no feature record for this actor-setup/custom-only feature, and 0.1.2's own one is not
      // what the demo cuts.
      // This app-owned record uses measured timings and actual page-video descriptors, never guessed filenames.
      try { writeFlowRecording(recordingsDirectory, read(reportFile), readFileSync(join(app, `lab/flows/humanity-dim2${control ? "-wrong-credits" : ""}.feature`), "utf8"), `lab/flows/humanity-dim2${control ? "-wrong-credits" : ""}.feature`, id); }
      // Name the refusal: the record's own checks give fixed messages, never assertion data or secrets.
      catch (error) { console.warn(`Flow demo recording: not produced (incomplete measured evidence: ${error instanceof Error ? error.message : String(error)})`); }
      const scenarios = writeScenarioSummary(reportFile, join(app, `lab/flows/humanity-dim2${control ? "-wrong-credits" : ""}.feature`), sanitized, true);
      const notRun = scenarios.find(scenario => scenario.reason === "not run: imported game in Reporting")?.reason;
      if (notRun) { passed = false; process.exitCode = 1; console.error(notRun); }
      let cleaned = false;
      try { await cleanup(); cleaned = true; }
      finally {
        if (!cleaned) { passed = false; process.exitCode = 1; }
        writeFileSync(join(sanitized, `${id}.json`), JSON.stringify({ source, apps: { peopl: { mode: "source", ...source }, dim2: { mode: "source", ...source } }, selection: control ? "wrong-credits" : "positive", passed, result: notRun ?? (passed ? "passed" : "failed"), seconds: (Date.now() - started) / 1000, hostVersion: host.version, hostArchiveSha256: host.archiveSha256 }, null, 2) + "\n");
        writeFileSync(join(reports, "last-run.json"), JSON.stringify({ id, passed, control, recordingsDirectory }, null, 2) + "\n");
        rmSync(forkDirectory, { recursive: true, force: true });
      }
    }
  } finally {
    clearInterval(sampler);
    samples.push(resourceSample());
    const sanitized = join(reports, "sanitized");
    mkdirSync(sanitized, { recursive: true });
    writeFileSync(join(sanitized, `${mode}-${jobStarted}-resources.json`), JSON.stringify({ seconds: (Date.now() - jobStarted) / 1000, phases, samples }, null, 2) + "\n");
    rmSync(lock, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
