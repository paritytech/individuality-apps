// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveSessionPorts } from '@parity/product-lab/application/orchestration';
import { parseAdapterOptions } from '@parity/product-lab/domain';
import { truapiCliHostOptionsSchema } from '@parity/product-lab/host-truapi-cli';
import { hostPortRange } from '../../../../lab/shared/host-ports.ts';

const profile = JSON.parse(readFileSync(new URL('../../lab/flows/local-ports.json', import.meta.url), 'utf8')) as { PRODUCT_LAB_PORTS: string };
const labEnd = Number(profile.PRODUCT_LAB_PORTS.split('-')[1]);
const sessionPorts = resolveSessionPorts({ fromBlock: false, range: { from: labEnd - 98, to: labEnd } });
const parseHost = (ports: unknown) => parseAdapterOptions(truapiCliHostOptionsSchema, { patches: [], stateRoot: 'offline-host-options', ports }, 'truapi-cli host');

it('@negative-control reproduces the exact provenance-key failure and accepts only the host schema bounds', () => {
  const error = 'Invalid truapi-cli host options:\n- ports: Unrecognized keys: "source", "note"';
  // The resolver adds metadata both with the local profile and without any profile.
  for (const range of [sessionPorts, resolveSessionPorts({ fromBlock: false })]) {
    expect(() => parseHost(range)).toThrow(error);
    const ports = hostPortRange(range);
    expect(Object.keys(ports).sort()).toEqual(Object.keys(truapiCliHostOptionsSchema.shape.ports.unwrap().shape).sort());
    expect(parseHost(ports).ports).toEqual({ from: range.from, to: range.to });
  }
});

it('@negative-control excludes a future unknown range key without weakening host validation', () => {
  const range = { ...sessionPorts, futureAllocatorMetadata: { worker: 2 } };
  expect(() => parseHost(range)).toThrow('Unrecognized keys: "source", "note", "futureAllocatorMetadata"');
  expect(parseHost(hostPortRange(range)).ports).toEqual({ from: range.from, to: range.to });
  expect(range).toHaveProperty('futureAllocatorMetadata');
  expect(() => parseHost(hostPortRange({ from: 0, to: range.to }))).toThrow('Port range must be integers within 1024-65535');
});
