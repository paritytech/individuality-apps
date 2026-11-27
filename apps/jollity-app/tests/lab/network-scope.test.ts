// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ScenarioNetwork } from '../../../../lab/shared/network.ts';
import { jollityNetworkScope } from '../../lab/scenarios/session.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const network = () => { const dir = mkdtempSync(join(tmpdir(), 'jollity-network-')); dirs.push(dir); return new ScenarioNetwork(dir, jollityNetworkScope); };
const tagsOf = (file: string) => readFileSync(new URL(`../../lab/scenarios/${file}`, import.meta.url), 'utf8').split('\n').find((line) => line.trim() && !line.trim().startsWith('#'))!.trim().split(/\s+/);

// The first live run failed every row in the Before hook: the shared evidence accepted only Humanity's tags and ada-N actors.
it('labels every Jollity scenario feature with exactly one tag, as the Before hook requires', () => {
  for (const file of ['b1-home.feature', 'b2-registration.feature', 'b3-play.feature', 'b4-results.feature', 'b5-prize.feature', 'b6-permissions.feature', 'wrong-home.feature'])
    expect(() => network().beginTag(tagsOf(file)), file).not.toThrow();
});
it('accepts the named actors the Jollity session creates, and still refuses Humanity tags and odd actors', () => {
  const evidence = network();
  for (const actor of ['ada-1', 'bob-2', 'cara-3']) expect(() => evidence.forActor(actor), actor).not.toThrow();
  expect(() => evidence.forActor('Ada 1')).toThrow('Invalid network actor');
  expect(() => evidence.beginTag(['@A1'])).toThrow('exactly one Jollity scenario tag');
  expect(() => evidence.beginTag(['@jollity-home', '@jollity-results'])).toThrow('exactly one Jollity scenario tag');
});
it('keeps the Humanity default unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'humanity-network-')); dirs.push(dir);
  const evidence = new ScenarioNetwork(dir);
  expect(() => evidence.beginTag(['@A1'])).not.toThrow();
  expect(() => evidence.beginTag(['@jollity-home'])).toThrow('exactly one Humanity scenario tag');
  expect(() => evidence.forActor('bob-2')).toThrow('Invalid network actor');
});
it('the Jollity session builds its network evidence with the Jollity scope', () => {
  const source = readFileSync(new URL('../../lab/scenarios/session.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/new ScenarioNetwork\(join\(directory, 'network'\), jollityNetworkScope\)/);
});
