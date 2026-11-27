// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import type { SessionContext } from "@parity/product-lab";
import type { HostSessionEvidence } from "@parity/product-lab/ports/host";
export async function readLiteProof(context: SessionContext, evidence: HostSessionEvidence) {
  const hostPort = (evidence as HostSessionEvidence & { hostPort?: number }).hostPort;
  if (!hostPort || !context.system.commands) throw new Error("No owned host frame for the lite proof read");
  const script = fileURLToPath(new URL("../../scripts/lab/proof.mts", import.meta.url));
  const result = await context.system.commands.run({ command: process.execPath,
    args: ["--import", "tsx", script, `ws://127.0.0.1:${hostPort}`, context.environment.routes!.chains.people!.ws],
    cwd: context.root, timeoutMs: 120_000, signal: context.signal });
  const line = result.stdout.split("\n").find((line) => line.startsWith("DIM2_LITE_PROOF "));
  if (result.code !== 0 || !line) throw new Error("DIM2 lite proof read failed: " + result.stderr.slice(-500));
  const proof = JSON.parse(line.slice("DIM2_LITE_PROOF ".length));
  if (proof.readable !== true || !(proof.bytes > 0) || !Number.isInteger(proof.ringIndex) || !Number.isInteger(proof.ringRevision)) throw new Error("Unreadable DIM2 lite proof summary");
  return proof;
}
