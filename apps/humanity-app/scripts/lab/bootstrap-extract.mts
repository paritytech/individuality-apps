// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Project private Engine diagnostics into a bounded, fail-closed public extract.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 40;
const PORT_KEYS = ["RELAY_ALICE_PORT", "PEOPLE_PORT", "ASSET_HUB_PORT", "BULLETIN_PORT", "DASHBOARD_PORT", "DUB_PORT", "DUB_POSTGRES_PORT", "ETH_RPC_PORT", "IPFS_GATEWAY_PORT", "IPFS_API_PORT"];
const ERROR_CLASSES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "EngineNodeLost", "ChainsNotReadyError"]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const port = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;

function bounded(file: string, tail = false): string | undefined {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (!tail && stat.size > MAX_BYTES)) return;
      const offset = tail ? Math.max(0, stat.size - MAX_BYTES) : 0;
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, offset)).toString("utf8");
      // Drop a cut-off first line rather than recognize a fragment as a complete diagnostic.
      return offset ? (text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "") : text;
    } finally { closeSync(fd); }
  } catch { return; }
}
function json(file: string): Record<string, unknown> {
  try { return object(JSON.parse(bounded(file) ?? "null")); } catch { return {}; }
}

export function scrubBootstrapTail(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/token|secret|password|mnemonic|signer|wallet|session|authorization|bearer|cookie|[a-z][a-z0-9+.-]*:\/\/|\b[A-Z][A-Z0-9_]*=/i.test(line)) continue;
    const exited = /^ppn: zombie-cli exited with (\d{1,3})$/.exec(line);
    const occupied = /^(?:ppn: )?something is already listening on (\d{2,5}) \(the relay's RPC port\)\.$/.exec(line);
    if (exited && Number(exited[1]) <= 255) lines.push(`zombie-cli exited with ${Number(exited[1])}`);
    else if (occupied && port(Number(occupied[1]))) lines.push(`relay RPC port occupied: ${Number(occupied[1])}`);
    else if (/^(?:ppn: )?\d{1,3} service port\(s\) this network needs are in use, and nothing was stopped:$/.test(line)) lines.push("service ports are in use");
    else if (/^thread '(?:main|tokio-runtime-worker)' panicked(?: at\b.*)?$/.test(line)) lines.push("native process panicked");
    else {
      // Emit fixed descriptions only, never arbitrary portions of a native error or path.
      for (const [pattern, description] of [
        [/address already in use/i, "address already in use"],
        [/cannot allocate memory/i, "cannot allocate memory"],
        [/no space left on device/i, "no space left on device"],
        [/too many open files/i, "too many open files"],
        [/permission denied/i, "permission denied"],
        [/no such file or directory/i, "no such file or directory"],
        [/^ppn: no zombienet config at /, "missing zombienet config"],
        [/^ppn: zombie-cli is not in /, "missing zombie-cli binary"],
        [/Engine exited before readiness/, "Engine exited before readiness"],
      ] as const) {
        if (pattern.test(line)) { lines.push(description); break; }
      }
    }
  }
  return lines.slice(-MAX_LINES);
}

export interface BootstrapExtractOptions { forkDirectory: string; sanitized: string; id: string }
function writeBootstrapExtract(options: BootstrapExtractOptions, error: unknown): void {
  try {
    if (!/^[\w-]+$/.test(options.id)) return;
    let network: string | undefined;
    let processes: string | undefined;
    try {
      const root = realpathSync(options.forkDirectory);
      for (const layout of ["paseo-copy-light", "paseo-copy"]) {
        try {
          const candidate = realpathSync(join(root, layout));
          const directory = realpathSync(join(candidate, "processes"));
          if ([candidate, directory].every((value) => { const path = relative(root, value); return !path.startsWith("..") && !isAbsolute(path); })) {
            network = candidate;
            processes = directory;
            break;
          }
        } catch { /* The other layout may be the one selected for this run. */ }
      }
    } catch { /* No fork directory is a legitimate early failure. */ }
    const config = object(network ? json(join(network, "engine.json")).ports : undefined);
    const ports = PORT_KEYS.map((key) => config[key]).filter(port);
    const main = processes ? bounded(join(processes, "engine-bootstrap.log"), true) : undefined;
    const references = [...new Set(main?.match(/engine-bootstrap-prepare-[1-9]\d{0,2}\.log\b/g) ?? [])].slice(-4);
    const logs = ["engine-bootstrap.log", ...references].map((file) => {
      const text = file === "engine-bootstrap.log" ? main : processes ? bounded(join(processes, file), true) : undefined;
      return { file, status: text === undefined ? "no log" : "read", tail: scrubBootstrapTail(text ?? "") };
    });
    const errorClass = error instanceof Error && ERROR_CLASSES.has(error.name) ? error.name : null;
    mkdirSync(options.sanitized, { recursive: true });
    writeFileSync(join(options.sanitized, `${options.id}-engine-bootstrap.json`), JSON.stringify({
      // The child framework stops/reconciles bootstrap before returning here, clearing record.error.
      // A zombie-cli exit line is a child's result, not the bootstrap Node process's status.
      phase: "engine-bootstrap", exitStatus: "unavailable: cleared by framework stop", errorClass,
      ports: [...new Set(ports)].sort((a, b) => a - b), logs,
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch { /* Diagnostic I/O must not replace the failure or prevent cleanup. */ }
}

export async function withBootstrapExtract<T>(options: BootstrapExtractOptions, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    writeBootstrapExtract(options, error);
    throw error;
  }
}
