// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { it, expect } from 'vitest';
import { requireScenarioTarget } from '../../../../lab/shared/target.ts';
import type { ImportedGamesTarget } from '../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts';
const endpoint = 'ws://127.0.0.1:27010';
function target(mode: 'fork' | 'genesis') {
  return { offer: { local: true }, endpoints: { people: endpoint }, humanity: { network: { kind: 'owned', session: {
    schemaVersion: 1, mode, network: mode === 'fork' ? 'paseo-next-v2' : 'previewnet', ownership: 'owned', chains: {
      people: { ws: endpoint, codeHash: '0x69e7126f098bdf708302e52b892fd76c5d2477627bce47cbfcee7fcd5db17871' },
      'asset-hub': { codeHash: '0xd1ee06e7e13dee315971e5d7c7634390e43afd802b588faefb0cc910a790d031' },
    },
  } } } } as unknown as ImportedGamesTarget;
}
it('admits only the owned Paseo copy or the v0.3.4 local genesis route', () => {
  expect(requireScenarioTarget(target('fork'))).toBe('fork'); expect(requireScenarioTarget(target('genesis'))).toBe('genesis');
  for (const mode of ['fork', 'genesis'] as const) {
    const publicTarget = target(mode); (publicTarget as { endpoints: { people: string } }).endpoints.people = 'wss://people.example';
    expect(() => requireScenarioTarget(publicTarget)).toThrow();
    const attached = target(mode); (attached.humanity!.network as { kind: string }).kind = 'attached';
    expect(() => requireScenarioTarget(attached)).toThrow(/owned/);
  }
  const wrongRuntime = target('genesis');
  (wrongRuntime.humanity!.network as { session: { chains: { people: { codeHash: string } } } }).session.chains.people.codeHash = '0x01';
  expect(() => requireScenarioTarget(wrongRuntime)).toThrow(/v0.3.4/);
});
it.each([{ schemaVersion: 2 }, { ownership: 'attached' }])('refuses an owned-looking target with invalid session evidence: %j', change => {
  const candidate = target('fork');
  const network = candidate.humanity!.network as { session: { schemaVersion: number; ownership: string } };
  Object.assign(network.session, change);
  expect(() => requireScenarioTarget(candidate)).toThrow('Humanity scenarios require an owned local chain');
});
