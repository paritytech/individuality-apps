// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Serialize the actual tsx-loaded reader into an isolated page realm, without runtime compiler helpers.
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { chestObservation } from '../../../lab/flows/post-game.ts';
const style = { visibility: 'visible', pointerEvents: 'auto', opacity: '1' };
const button = { disabled: false, textContent: 'Continue', parentElement: null, getClientRects: () => [1] };
const canvas = { getClientRects: () => [1] };
const document = { body: { innerText: 'Continue' }, querySelector: () => null, querySelectorAll: (selector: string) =>
  selector === 'button' ? [button] : selector.startsWith('[role=') ? [canvas] : [] };
const view = runInNewContext('(' + chestObservation.toString() + ')()', {
  document, location: { pathname: '/chest', search: '?game=308' }, URLSearchParams, getComputedStyle: () => style,
});
assert.equal(view.path, '/chest'); assert.equal(view.game, '308'); assert.equal(view.scene, true);
assert.equal(view.closing, false); assert.equal(view.buttons.length, 1); assert.equal(view.buttons[0].enabled, true);
style.opacity = '0';
assert.equal(runInNewContext('(' + chestObservation.toString() + ')()', {
  document, location: { pathname: '/chest', search: '?game=308' }, URLSearchParams, getComputedStyle: () => style,
}).buttons[0].enabled, false);
console.log('tsx-loaded chest observation executes in the page realm without compiler helpers');
