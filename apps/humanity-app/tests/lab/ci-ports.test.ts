// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LAB_CLAIM_RANGE, paseoCopy } from "@parity/product-lab/composition";
import { savedForkPorts } from "@parity/product-lab/env-engine";
import { NodeOsPorts } from "@parity/product-lab/system-node";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../../../.github/workflows/humanity-lab.yml", import.meta.url), "utf8"));
const job = workflow.jobs.opening;
afterEach(() => vi.unstubAllEnvs());

function ciFork() {
  vi.stubEnv("PRODUCT_LAB_FORK_PORT_BASE", job.env.PRODUCT_LAB_FORK_PORT_BASE ?? "");
  return paseoCopy()["paseo-copy"]!.choices.map((choice) => {
    const block = choice.environment.ports;
    if (!block || !("from" in block) || !("to" in block)) throw new Error("The fork must declare a whole port block");
    return block;
  });
}

for (const kernelRange of ["15000 65000", "32768 60999"]) {
  it(`keeps both CI fork layouts outside the Linux range read by the lab (${kernelRange})`, async () => {
    const os = new NodeOsPorts({
      platform: "linux",
      files: { readText: (path) => { expect(path).toBe("/proc/sys/net/ipv4/ip_local_port_range"); return kernelRange; } },
      commands: { run: async () => { throw new Error("Linux range should be read from procfs"); } },
    });
    const ephemeral = (await os.ephemeralRange())!;
    for (const block of ciFork()) {
      expect(block.from).toBeGreaterThanOrEqual(1024);
      expect(block.to - block.from).toBe(999);
      expect(block.to < ephemeral.from || block.from > ephemeral.to).toBe(true);
    }
  });
}

it("keeps named services, node allocation and lab sessions disjoint", () => {
  for (const block of ciFork()) {
    const services = Object.values(savedForkPorts(block.from));
    expect(new Set(services).size).toBe(services.length);
    // Dynamic node ports use base+900 through base+949, above the named services.
    expect(services.every((port) => port >= block.from && port < block.from + 900)).toBe(true);
    expect(block.to < LAB_CLAIM_RANGE.from || block.from > LAB_CLAIM_RANGE.to).toBe(true);
    // Ordinary app dev, CLI/dashboard, RPC and database defaults are outside the new block.
    for (const fixed of [5183, 5432, 8090, 8545, 9944]) expect(fixed < block.from || fixed > block.to).toBe(true);
  }
  expect(job.env.PRODUCT_LAB_PORTS).toBeUndefined();
  expect(job.steps.some((step: { run?: string }) => step.run?.includes("cat /proc/sys/net/ipv4/ip_local_port_range"))).toBe(true);
});
