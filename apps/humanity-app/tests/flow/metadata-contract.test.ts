// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { demoPrizeAsset } from '../../../../lab/shared/upstream/lab/steps/games/fork-setup-plan.ts';

const metadata = unifyMetadata(decAnyMetadata(gunzipSync(readFileSync(new URL('./fixtures/people-3004000.metadata16.scale.gz', import.meta.url)))));
const codecs = getDynamicBuilder(getLookupFn(metadata));
const account = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const who = { type: 'Account', value: account };
it('encodes the People storage-key shapes used through delivered-credit verification', () => {
  const queries: Array<[string, string, unknown[]]> = [
    ['System', 'Account', [account]], ['System', 'Events', []], ['Timestamp', 'Now', []],
    ['PeopleLite', 'AccountToAlias', [account]], ['Game', 'Game', []], ['Game', 'Players', [who]],
    ['Game', 'IndexToPlayer', [[0, 0]]], ['Score', 'Participants', [who]], ['Game', 'ArchivedPlayers', [who]],
    ['NftCredits', 'NftClaimCreditBlocks', [who]], ['NftCredits', 'NftClaimCreditRoots', [1]],
    ['Game', 'GameSchedules', []], ['Game', 'StoredPhaseDurations', []], ['Sudo', 'Key', []],
    ['Assets', 'Asset', [demoPrizeAsset]], ['Assets', 'Account', [demoPrizeAsset, account]], ['Airdrop', 'SupportedAssets', [demoPrizeAsset]],
  ];
  for (const [pallet, item, args] of queries) {
    const storage = codecs.buildStorage(pallet, item);
    expect(storage.keys.enc(...args), `${pallet}.${item}`).toMatch(/^0x[0-9a-f]+$/i);
  }
});
it('encodes the actual credit-proof runtime API arguments against the pinned metadata fixture', () => {
  const api = codecs.buildRuntimeCall('NftCreditsApi', 'nft_claim_credit_proofs');
  expect(api.args.enc([1, who]).length).toBeGreaterThan(0);
  expect(() => codecs.buildStorage('Game', 'Players').keys.enc(account)).toThrow();
});
