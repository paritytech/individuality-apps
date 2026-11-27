// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Run both copies of the chest read, as tsx loads them, in an isolated page realm on the same DOM fixture
// as Humanity's tests/flow/fixtures/chest-observation.mts, plus the album, heading and notice variants.
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { chestObservation, readChest } from '../../../../../lab/shared/post-game.ts';

let inline: (() => unknown) | undefined;
await readChest({ evaluate: async (read: () => unknown) => { inline = read; return null; } } as unknown as BrowserPage);
if (!inline) throw Error('readChest did not hand a callback to the page');
const read = inline;

type Fixture = { style: Record<string, string>; text: string; album?: boolean; heading?: boolean; notices?: string[] };
function realm(fixture: Fixture) {
  // Humanity's fixture: one visible Continue and one visible chest scene, no album.
  const button = { disabled: false, textContent: 'Continue', parentElement: null, getClientRects: () => [1] };
  const canvas = { getClientRects: () => [1] };
  const albumButton = { disabled: false, textContent: 'Continue', parentElement: null, getClientRects: () => [1] };
  const album = { querySelectorAll: (selector: string) => selector === 'button' ? [albumButton] : [] };
  const heading = { getClientRects: () => [1], textContent: ' The chest ' };
  const document = { body: { innerText: fixture.text }, querySelector: (selector: string) => fixture.album && selector.split(', ').includes('.album-close') ? album : null,
    querySelectorAll: (selector: string) => selector === 'button' ? [button] : selector.startsWith('[role=') ? [canvas]
      : selector === 'h1' && fixture.heading ? [heading]
      : fixture.notices?.some(id => selector === `[data-testid="${id}"]`) ? [{ getClientRects: () => [1] }] : [] };
  return { document, location: { pathname: '/chest', search: '?game=308' }, URLSearchParams, getComputedStyle: () => fixture.style };
}
const run = (fn: () => unknown, fixture: Fixture) => JSON.stringify(runInNewContext('(' + fn.toString() + ')()', realm(fixture)));
const visible = { visibility: 'visible', pointerEvents: 'auto', opacity: '1' };
const fixtures: Fixture[] = [
  { style: visible, text: 'Continue' },
  { style: { ...visible, opacity: '0' }, text: 'Continue' },
  { style: { ...visible, pointerEvents: 'none' }, text: 'Continue' },
  { style: visible, text: 'Game #308\nContinue', album: true, heading: true },
  { style: visible, text: 'No player identity here', notices: ['chest-slow', 'chest-restart'] },
];
for (const fixture of fixtures) assert.equal(run(read, fixture), run(chestObservation, fixture), JSON.stringify(fixture));
const first = JSON.parse(run(read, fixtures[0]!));
assert.equal(first.path, '/chest'); assert.equal(first.game, '308'); assert.equal(first.scene, true); assert.equal(first.buttons[0].enabled, true);
assert.equal(JSON.parse(run(read, fixtures[1]!)).buttons[0].enabled, false);
assert.equal(JSON.parse(run(read, fixtures[3]!)).closing, true);
assert.equal(JSON.parse(run(read, fixtures[4]!)).slow, true);
console.log(`readChest's inline read equals chestObservation on ${fixtures.length} page fixtures`);
