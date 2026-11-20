// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LAB_CLAIM_RANGE, paseoCopy } from "@parity/product-lab/composition";
import { savedForkPorts } from "@parity/product-lab/env-engine";
import { parse } from "yaml";

// The runner's observed ephemeral range (the lab's own warning on #1982) and the default Linux one.
const ephemeralRanges = [{ from: 15000, to: 65000 }, { from: 32768, to: 60999 }];
const read = (name: string) => readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), "utf8");
const flowYaml = read("humanity-dim2-flow.yml");
// Every other lab workflow whose jobs start a fork on a self-hosted runner.
const otherLabs = ["humanity-lab.yml", "jollity-lab.yml", "cross-app-lab.yml"];
afterEach(() => vi.unstubAllEnvs());

type Block = { from: number; to: number };
const overlaps = (a: Block, b: Block) => a.from <= b.to && b.from <= a.to;
const envOf = (yaml: string, job: string) => (parse(yaml).jobs[job].env ?? {}) as Record<string, string | undefined>;

/** The fork blocks the flow job would start with, through the framework's own paseo-copy resolver. */
function flowBlocks(yaml = flowYaml): Block[] {
  // Unset when the job sets nothing, so the framework falls back to its own default as it does on the runner.
  vi.stubEnv("PRODUCT_LAB_FORK_PORT_BASE", envOf(yaml, "flow").PRODUCT_LAB_FORK_PORT_BASE);
  return paseoCopy()["paseo-copy"]!.choices.map((choice) => {
    const block = choice.environment.ports;
    if (!block || !("from" in block) || !("to" in block)) throw new Error("The fork must declare a whole port block");
    return { from: block.from, to: block.to };
  });
}

/** The 1000-port blocks every other lab job sets. */
function otherBlocks(): Array<Block & { where: string }> {
  return otherLabs.flatMap((name) => Object.entries(parse(read(name)).jobs as Record<string, { env?: Record<string, string> }>)
    .filter(([, job]) => job.env?.PRODUCT_LAB_FORK_PORT_BASE !== undefined)
    .map(([id, job]) => { const from = Number(job.env!.PRODUCT_LAB_FORK_PORT_BASE); return { from, to: from + 999, where: `${name} ${id}` }; }));
}

function safe(yaml = flowYaml) {
  const blocks = flowBlocks(yaml), others = otherBlocks();
  return blocks.length > 0 && blocks.every((block) => block.from >= 1024 && block.to - block.from === 999 &&
    ephemeralRanges.every((range) => !overlaps(block, range)) && !overlaps(block, LAB_CLAIM_RANGE) &&
    others.every((other) => !overlaps(block, other)));
}

it("keeps the flow's CI fork block below the runner's ephemeral range and apart from every other lab job", () => {
  expect(envOf(flowYaml, "flow").PRODUCT_LAB_FORK_PORT_BASE).toBe("14000");
  expect(otherBlocks().length).toBeGreaterThan(0);
  expect(safe()).toBe(true);
});

it("keeps the flow fork's named services inside its block and off ordinary local defaults", () => {
  for (const block of flowBlocks()) {
    const services = Object.values(savedForkPorts(block.from));
    expect(new Set(services).size).toBe(services.length);
    expect(services.every((port) => port >= block.from && port < block.from + 900)).toBe(true);
    for (const fixed of [5183, 5432, 8090, 8545, 9944]) expect(fixed < block.from || fixed > block.to).toBe(true);
  }
  expect(envOf(flowYaml, "flow").PRODUCT_LAB_PORTS).toBeUndefined();
});

const withBase = (base: string | undefined) => flowYaml.replace('      PRODUCT_LAB_FORK_PORT_BASE: "14000"\n', base === undefined ? "" : `      PRODUCT_LAB_FORK_PORT_BASE: "${base}"\n`);

it("@negative-control: the framework default 42000 block, used before this change, is rejected", () => {
  expect(withBase(undefined)).not.toContain("PRODUCT_LAB_FORK_PORT_BASE");
  expect(flowBlocks(withBase(undefined))[0]!.from).toBe(42000);
  expect(safe(withBase(undefined))).toBe(false);
  expect(safe(withBase("42000"))).toBe(false);
});

it("@negative-control: a block shared with the other lab jobs or touching the ephemeral range is rejected", () => {
  expect(safe(withBase("10000"))).toBe(false);
  expect(safe(withBase("14500"))).toBe(false);
  expect(safe(withBase("20000"))).toBe(false);
});
