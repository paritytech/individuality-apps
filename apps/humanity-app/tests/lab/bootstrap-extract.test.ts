// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { scrubBootstrapTail, withBootstrapExtract } from "../../scripts/lab/bootstrap-extract.mts";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(layout = "paseo-copy-light") {
  const root = mkdtempSync(join(tmpdir(), "humanity-extract-"));
  temporary.push(root);
  const forkDirectory = join(root, "fork");
  const network = join(forkDirectory, layout);
  const processes = join(network, "processes");
  mkdirSync(processes, { recursive: true });
  const options = { forkDirectory, sanitized: join(root, "sanitized"), id: "test-positive" };
  const output = join(options.sanitized, `${options.id}-engine-bootstrap.json`);
  const read = () => JSON.parse(readFileSync(output, "utf8"));
  return { root, network, processes, options, output, read };
}

it.each(["paseo-copy-light", "paseo-copy"])("writes a %s bootstrap-exit extract before cleanup, preserving the original failure", async (layout) => {
  const f = fixture(layout);
  writeFileSync(join(f.processes, "engine-bootstrap.log"), "ppn: zombie-cli exited with 101\n");
  // Real post-stop registry: stop() clears error but keeps the stopped record.
  writeFileSync(join(f.processes, "processes.json"), JSON.stringify({ records: [{ id: "engine-bootstrap", desired: "stopped", members: [] }] }));
  writeFileSync(join(f.network, "engine.json"), JSON.stringify({ ports: { PEOPLE_PORT: 10010, DASHBOARD_PORT: 10090, DUB_PORT: 10092, SECRET_PORT: 12345, ETH_RPC_PORT: -1 } }));
  const original = new Error("Engine exited before readiness; private path");
  let cleaned = false;
  try {
    await withBootstrapExtract(f.options, async () => { throw original; });
  } catch (error) { expect(error).toBe(original); }
  finally {
    expect(existsSync(f.output)).toBe(true);
    rmSync(f.options.forkDirectory, { recursive: true });
    cleaned = true;
  }
  expect(cleaned).toBe(true);
  expect(f.read()).toEqual({ phase: "engine-bootstrap", exitStatus: "unavailable: cleared by framework stop", errorClass: "Error", ports: [10010, 10090, 10092], logs: [{ file: "engine-bootstrap.log", status: "read", tail: ["zombie-cli exited with 101"] }] });
});

it("drops planted tokens, credentialed URLs, signer output and unknown lines, including registry fields", async () => {
  const f = fixture();
  const planted = "ghp_PLANTED_NOT_A_REAL_TOKEN";
  const url = "https://user:planted-password@example.test/private";
  writeFileSync(join(f.processes, "engine-bootstrap.log"), [
    `GITHUB_TOKEN=${planted}`, `Authorization: Bearer ${planted}`, `Error: ${url}: address already in use`,
    "signer mnemonic private fixture words", `unknown output ${planted}`, "Error: Permission denied (os error 13)",
    "[product-lab] generate the fork's zombienet config: ppn fork toml private-path; output in /private/engine-bootstrap-prepare-2.log",
  ].join("\n"));
  writeFileSync(join(f.processes, "engine-bootstrap-prepare-2.log"), `${url}\n${planted}\nError: No space left on device (os error 28)\n`);
  writeFileSync(join(f.processes, "processes.json"), JSON.stringify({ records: [{ id: "engine-bootstrap", error: `Exited with code 1 ${planted}`, root: { args: [planted, url] } }] }));
  await expect(withBootstrapExtract(f.options, async () => { throw new TypeError(planted); })).rejects.toBeInstanceOf(TypeError);
  const text = readFileSync(f.output, "utf8");
  for (const forbidden of [planted, url, "planted-password", "fixture words", "private-path", "root", "args"]) expect(text).not.toContain(forbidden);
  expect(f.read().exitStatus).toBe("unavailable: cleared by framework stop");
  expect(f.read().logs.map((row: { tail: string[] }) => row.tail)).toEqual([["permission denied"], ["no space left on device"]]);
});

it("records no log when the bootstrap log or the whole fork directory is absent", async () => {
  for (const absentFork of [false, true]) {
    const f = fixture();
    if (absentFork) rmSync(f.options.forkDirectory, { recursive: true });
    await expect(withBootstrapExtract(f.options, async () => { throw new Error("early failure"); })).rejects.toThrow("early failure");
    expect(f.read().logs).toEqual([{ file: "engine-bootstrap.log", status: "no log", tail: [] }]);
  }
});

it("does not infer the parent status from registry remnants or child exit lines", async () => {
  const f = fixture();
  writeFileSync(join(f.processes, "processes.json"), JSON.stringify({ records: [{ id: "engine-bootstrap", error: "Ended by signal SIGKILL" }] }));
  writeFileSync(join(f.processes, "engine-bootstrap.log"), "ppn: zombie-cli exited with 3\n");
  const original = new Error("private"); original.name = "private-error-name";
  await expect(withBootstrapExtract(f.options, async () => { throw original; })).rejects.toBe(original);
  const result = f.read();
  expect(result).toMatchObject({ exitStatus: "unavailable: cleared by framework stop", errorClass: null });
  for (const key of ["exitCode", "signal", "registryError"]) expect(result).not.toHaveProperty(key);
  expect(result.logs[0].tail).toEqual(["zombie-cli exited with 3"]);
});

it("recognizes the real prefixed relay and service port refusals from locked Engine", () => {
  const relay = "ppn: something is already listening on 10000 (the relay's RPC port).\n" +
    "       `ppn kill` first, or point this run at another machine.";
  const services = "ppn: 2 service port(s) this network needs are in use, and nothing was stopped:\n" +
    "       10090 (DASHBOARD_PORT) — node(123)\n       10092 (DUB_PORT) — dub(456)\n" +
    "       `ppn kill` stops a previous run of this workspace; otherwise stop the holder or move the port in config/ports.env.";
  expect(scrubBootstrapTail(relay)).toEqual(["relay RPC port occupied: 10000"]);
  expect(scrubBootstrapTail(relay.replace("ppn: ", ""))).toEqual(["relay RPC port occupied: 10000"]);
  expect(scrubBootstrapTail(services)).toEqual(["service ports are in use"]);
});

it("wires the actual opening operation to extraction inside try, before finally deletes the fork", () => {
  const source = ts.createSourceFile("opening.mts", readFileSync(new URL("../../scripts/lab/opening.mts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "withBootstrapExtract") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.arguments[0]!.getText(source)).toContain("forkDirectory");
  expect(call.arguments[1]!.getText(source)).toContain('await command("node", [cli, "test"');
  expect(call.arguments[1]!.getText(source)).toContain("assertOpeningReport");
  let owner: ts.Node | undefined = call.parent;
  while (owner && !ts.isTryStatement(owner)) owner = owner.parent;
  if (!owner || !ts.isTryStatement(owner)) throw new Error("Extraction must wrap the opening inside try/finally");
  expect(call.pos > owner.tryBlock.pos && call.end < owner.tryBlock.end).toBe(true);
  expect(owner.finallyBlock?.getText(source)).toContain("rmSync(forkDirectory");
  expect(call.end).toBeLessThan(owner.finallyBlock!.pos);
});

it("does not mask failures or prevent cleanup when diagnostic output cannot be written", async () => {
  const f = fixture();
  writeFileSync(f.options.sanitized, "not a directory");
  const original = new Error("original failure");
  let cleaned = false;
  await expect(withBootstrapExtract(f.options, async () => { throw original; }).finally(() => {
    rmSync(f.options.forkDirectory, { recursive: true }); cleaned = true;
  })).rejects.toBe(original);
  expect(cleaned).toBe(true);
});

it("bounds native tails and refuses symlinks instead of following them into private files", async () => {
  const f = fixture();
  const privateFile = join(f.root, "private.log");
  writeFileSync(privateFile, "ppn: zombie-cli exited with 99\n");
  symlinkSync(privateFile, join(f.processes, "engine-bootstrap.log"));
  await expect(withBootstrapExtract(f.options, async () => { throw new Error("failed"); })).rejects.toThrow();
  expect(f.read().logs[0].status).toBe("no log");
  expect(scrubBootstrapTail("unknown\n".repeat(100) + "ppn: zombie-cli exited with 1\n".repeat(100))).toHaveLength(40);
});

it("reads only a bounded tail and at most four referenced prepare logs", async () => {
  const f = fixture();
  const references = Array.from({ length: 8 }, (_, i) => `output in engine-bootstrap-prepare-${i + 1}.log`).join("\n");
  writeFileSync(join(f.processes, "engine-bootstrap.log"), "ppn: zombie-cli exited with 99\n" + "unknown output\n".repeat(8000) + references + "\nppn: zombie-cli exited with 1\n".repeat(100));
  await expect(withBootstrapExtract(f.options, async () => { throw new Error("failed"); })).rejects.toThrow();
  const result = f.read();
  expect(result.logs).toHaveLength(5);
  expect(result.logs[0].tail).toEqual(Array(40).fill("zombie-cli exited with 1"));
  expect(result.logs.slice(1).map((row: { file: string }) => row.file)).toEqual([5, 6, 7, 8].map((n) => `engine-bootstrap-prepare-${n}.log`));
});

it("does not follow a processes-directory symlink outside this fork", async () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "engine-bootstrap.log"), "ppn: zombie-cli exited with 99\n");
  rmSync(f.processes, { recursive: true });
  symlinkSync(outside, f.processes);
  await expect(withBootstrapExtract(f.options, async () => { throw new Error("failed"); })).rejects.toThrow();
  expect(f.read().logs).toEqual([{ file: "engine-bootstrap.log", status: "no log", tail: [] }]);
});

it("does not write an extract for a successful opening", async () => {
  const f = fixture();
  expect(await withBootstrapExtract(f.options, async () => 42)).toBe(42);
  expect(existsSync(f.output)).toBe(false);
});
