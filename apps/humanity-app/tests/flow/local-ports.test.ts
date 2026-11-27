// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(new URL('../../lab/flows/local-ports.json', import.meta.url), 'utf8')) as Record<string, string>;
type Range = [number, number];
const overlaps = (a: Range, b: Range) => a[0] <= b[1] && b[0] <= a[1];
function safeLocalPorts(env: Record<string, string>) {
  if (Object.keys(env).sort().join(',') !== 'PRODUCT_LAB_FORK_PORT_BASE,PRODUCT_LAB_PORTS') return false;
  const base = Number(env.PRODUCT_LAB_FORK_PORT_BASE);
  const ports = /^(\d+)-(\d+)$/.exec(env.PRODUCT_LAB_PORTS ?? '');
  if (!Number.isInteger(base) || !ports) return false;
  const fork: Range = [base, base + 999], sessions: Range = [Number(ports[1]), Number(ports[2])];
  const ranges: Range[] = [fork, sessions];
  const reserved: Range[] = [[34000, 35999], [48000, 49999], [44438, 44438]];
  return ranges.every(range => range[0] >= 1024 && range[1] < 32768 && range[0] <= range[1] &&
    !reserved.some(block => overlaps(range, block))) && !overlaps(fork, sessions) && sessions[1] - sessions[0] >= 1999;
}

it('keeps the local profile below default Linux and macOS ephemeral ports and outside reserved blocks', () => {
  expect(safeLocalPorts(profile)).toBe(true);
});
it('@negative-control rejects the previous ephemeral fork block', () => {
  expect(safeLocalPorts({ ...profile, PRODUCT_LAB_FORK_PORT_BASE: '52000' })).toBe(false);
});
it('@negative-control rejects the previous ephemeral session block', () => {
  expect(safeLocalPorts({ ...profile, PRODUCT_LAB_PORTS: '54000-55999' })).toBe(false);
});
it('@negative-control rejects overlapping fork or reserved blocks', () => {
  const base = Number(profile.PRODUCT_LAB_FORK_PORT_BASE);
  expect(safeLocalPorts({ ...profile, PRODUCT_LAB_PORTS: `${base}-${base + 1999}` })).toBe(false);
  expect(safeLocalPorts({ ...profile, PRODUCT_LAB_FORK_PORT_BASE: '48000' })).toBe(false);
  expect(safeLocalPorts({ ...profile, PRODUCT_LAB_PORTS: '34000-35999' })).toBe(false);
  expect(safeLocalPorts({ ...profile, PRODUCT_LAB_FORK_PORT_BASE: '34000' })).toBe(false);
  expect(safeLocalPorts({ ...profile, PRODUCT_LAB_FORK_PORT_BASE: '44000' })).toBe(false);
  expect(safeLocalPorts({ ...profile, NODE_OPTIONS: 'unexpected' })).toBe(false);
});
