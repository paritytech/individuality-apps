// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PapiChainAccess } from '@parity/product-lab/chain-papi';

type HistoricalReads = Pick<PapiChainAccess, 'historicalStorage'>;

/** Successful absence is evidence; transport, metadata and decoding errors propagate. */
export async function zeroPasAccount(access: HistoricalReads, address: string, at: string, label: string) {
  const account = await access.historicalStorage('System', 'Account', [address], at);
  if (account === undefined) return { account: 'absent' as const, free: '0', reserved: '0' };
  const data = account && typeof account === 'object' && 'data' in account ? account.data : undefined;
  if (!data || typeof data !== 'object' || !('free' in data) || !('reserved' in data) ||
      typeof data.free !== 'bigint' || typeof data.reserved !== 'bigint')
    throw new Error(`Unreadable System.Account on ${label}`);
  if (data.free !== 0n || data.reserved !== 0n) throw new Error(`${label} has native PAS`);
  return { account: 'present' as const, free: '0', reserved: '0' };
}

/** Value-query defaults come from runtime metadata; optional entries remain undefined. */
export async function flowStorage(access: HistoricalReads, pallet: string, item: string, keys: unknown[], at: string) {
  return access.historicalStorage(pallet, item, keys, at, { orDefault: true });
}

export function creditBlocks(value: unknown): readonly number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(block => !Number.isSafeInteger(block) || block < 0))
    throw new Error('Unreadable NftCredits.NftClaimCreditBlocks');
  return value;
}

export function requiredGame(value: unknown) {
  if (!value || typeof value !== 'object' || !('index' in value) || !Number.isSafeInteger(value.index) ||
      !('game_date' in value) || !Number.isSafeInteger(value.game_date) ||
      !('state' in value) || !value.state || typeof value.state !== 'object' || !('type' in value.state) || typeof value.state.type !== 'string')
    throw new Error('Required Game.Game is absent or unreadable');
  return value as { index: number; game_date: number; state: { type: string; value?: { next_player_index?: number } } };
}

export function registrationGame(value: unknown) {
  const game = requiredGame(value), count = game.state.value?.next_player_index;
  if (game.state.type !== 'Registration' || !Number.isSafeInteger(count) || count! < 0)
    throw new Error('Required Game.Game registration is unreadable');
  return { ...game, registered: count! };
}
