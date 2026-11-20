// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { verify } from '@scure/sr25519';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { Sr25519KeyDerivation, Sr25519ProductAccounts } from '@parity/product-lab/keys-sr25519';
import { gamePlan, gameParticipant, gracePlan, thresholdPlan, forcedAttendance, scoreRecord, attendanceAfter, assertAttendance,
  drawPlan, prizeSource, peopleDrawId, rootBatch, prizeAsset, dollar, assertPrizeClaim, assertClaimExtrinsic, assertUnsupportedPurse, assertPayoutIncrease } from '../../../../lab/shared/chain-plan.ts';
import { jsonEvidence } from '../../../../lab/shared/observations.ts';
import { assertSetupReceipt } from '../../../../lab/shared/upstream/lab/steps/games/fork-setup-plan.ts';

const root = new Sr25519KeyDerivation().derive('//Alice');
const metadata = unifyMetadata(decAnyMetadata(gunzipSync(readFileSync(new URL('../flow/fixtures/people-3004000.metadata16.scale.gz', import.meta.url)))));
const builder = getDynamicBuilder(getLookupFn(metadata));
const codec = builder.buildCall('Sudo', 'sudo').codec;
const normalized = jsonEvidence;
const score = (overrides = {}) => scoreRecord({ score: 6, attendance_history: 255, streak: { type: 'Attended', value: 3 }, recognition: { type: 'Recognized', value: 1n }, reached_personhood: true, last_attended_game: 2, ...overrides });

it('encodes game, threshold, grace, forced-attendance and draw root batches against People spec 3004000', () => {
  const plans = [gamePlan(1_793_800_000, 240).calls, [gracePlan(1, 3)], [thresholdPlan()], forcedAttendance(root.address, 'AMAMA', 4), drawPlan(1_793_800_000n, root.address, prizeSource(undefined)).calls];
  for (const calls of plans) {
    const args = rootBatch(calls).value.value;
    expect(normalized(codec.dec(codec.enc(args)))).toEqual(normalized(args));
  }
});
it('keeps registration in the future, open for three minutes, with a distinct next-game date', () => {
  const plan = gamePlan(1000, 240), next = gamePlan(1400, 600, false);
  expect(plan.opensAt).toBe(1030); expect(plan.phases.registration).toBe(180);
  expect(plan.schedule.game_play_time - plan.phases.shuffle).toBe(1210);
  expect(plan.schedule.rounds).toBe(1); expect(plan.schedule.max_group_size).toBe(4);
  expect(plan.schedule.airdrops).toEqual([]); expect(next.opensAt).toBe(1790);
  const a1 = gamePlan(1000, 480); expect(a1.phases.registration).toBe(420); expect(a1.opensAt).toBe(1030);
  expect(() => gamePlan(1000, 179)).toThrow(/headroom/);
  expect(() => gamePlan(NaN, 240)).toThrow(/headroom/);
});
it('derives the host index-1 game signer including the domain-separated soft junction', () => {
  const entropy = new Uint8Array(32).fill(0x61), player = gameParticipant(entropy, 'paseo', 'Ada');
  const expected = new Sr25519ProductAccounts().productAccount(entropy, 'dim2.paseo', 1);
  expect(player.address).toBe(expected.address);
  const message = new TextEncoder().encode('offline signing control');
  const signer = player.signer as { publicKey: Uint8Array; sign: (value: Uint8Array) => Uint8Array };
  expect(verify(message, signer.sign(message), signer.publicKey)).toBe(true);
  expect(player.identifier).toMatch(/^0x04[0-9a-f]{128}$/);
  expect(gameParticipant(entropy, 'testnet', 'Ada').address).not.toBe(player.address);
  expect(gameParticipant(new Uint8Array(32).fill(0x62), 'paseo', 'Lab1').address).not.toBe(player.address);
  expect(() => gameParticipant(entropy, 'paseo/live', 'Ada')).toThrow(/namespace/);
});
it('keeps grace population-total and rejects invalid window and miss ratios', () => {
  expect(gracePlan(1, 3).value.value.schedule).toEqual([{ population_size_threshold: 0xffff_ffff, allowed_misses: 1, window: 3 }]);
  for (const [misses, window] of [[-1, 3], [3, 3], [1, 9], [0, 0]]) expect(() => gracePlan(misses!, window!)).toThrow(/grace/);
});
describe('forced attendance is oldest first and keeps the whole rolling byte', () => {
  for (const [pattern, byte, streakType, run, last] of [['AAAMM', 252, 'Absent', 2, 5], ['MMAAA', 231, 'Attended', 3, 7], ['AMAMA', 245, 'Attended', 1, 7]] as const) {
    it(pattern, () => {
      const before = score(), after = score({ attendance_history: byte, streak: { type: streakType, value: run }, last_attended_game: last });
      const calls = forcedAttendance(root.address, pattern, 3);
      expect(calls.map(c => c.value.value.attended)).toEqual([...pattern].map(c => c === 'A'));
      expect(calls.map(c => c.value.value.game_index)).toEqual([3, 4, 5, 6, 7]);
      expect(calls[0]!.value.value.who).toEqual({ type: 'Account', value: root.address });
      expect(attendanceAfter(255, pattern)).toBe(byte);
      expect(() => assertAttendance(before, after, pattern, 3)).not.toThrow();
      expect(() => assertAttendance(before, { ...after, last_attended_game: 999 }, pattern, 3)).toThrow(/last attended/);
    });
  }
  it('extends an unbroken attended streak and preserves last_attended_game on absence', () => {
    expect(() => assertAttendance(score(), score({ streak: { type: 'Attended', value: 5 }, last_attended_game: 4 }), 'AA', 3)).not.toThrow();
    expect(() => assertAttendance(score(), score({ streak: { type: 'Absent', value: 1 }, attendance_history: 254 }), 'M', 3)).not.toThrow();
    expect(() => forcedAttendance(root.address, 'X', 3)).toThrow(/pattern/);
    expect(() => forcedAttendance(root.address, 'AM', 0xffff_ffff)).toThrow(/index/);
  });
});
it('decodes Score records strictly rather than treating missing or corrupt state as zero', () => {
  expect(score().recognition.value).toBe(1n);
  for (const bad of [undefined, {}, { ...score(), attendance_history: 256 }, { ...score(), streak: { type: 'Other', value: 0 } }, { ...score(), reached_personhood: 'true' }]) expect(() => scoreRecord(bad)).toThrow(/Score/);
});
it('funds the configured PeopleAirdrops source, not Game.AirdropSource, with one dollar', () => {
  const fallback = prizeSource(undefined), bytes = new Sr25519KeyDerivation().publicKey(fallback);
  expect(new TextDecoder().decode(bytes.subarray(0, 12))).toBe('modlpop/pads');
  expect(bytes.subarray(12).every(b => b === 0)).toBe(true);
  expect(prizeSource({ type: 'PeopleAirdrops', value: { type: 'PrizeSource', value: root.address } })).toBe(root.address);
  const { calls, info } = drawPlan(1000n, root.address, fallback);
  expect(info.registration_starts).toBe(1060n); expect(info.draw_time).toBe(1240n); expect(info.end_time).toBe(4600n);
  expect(info.prize).toEqual({ asset_id: prizeAsset, asset_amount: 1_000_000n, max_winners: 1, winner_cap: 1_000_000 });
  expect(calls.map(c => `${c.type}.${c.value.type}`)).toEqual(['Assets.force_create', 'Utility.dispatch_as_fallible', 'Airdrop.enable_asset', 'Utility.dispatch_as_fallible', 'PeopleAirdrops.schedule_draws']);
  expect(calls[3]!.value.value.call.value.value.beneficiary.value).toBe(fallback);
  expect(calls[3]!.value.value.call.value.value.amount).toBe(dollar);
  expect(() => prizeSource({ type: 'Game', value: root.address })).toThrow(/parameter/);
});
it('builds people draw ids as the 24-byte prefix plus a big-endian u64', () => {
  const id = peopleDrawId(0x0102030405060708n);
  expect(id).toHaveLength(66); expect(id.endsWith('0102030405060708')).toBe(true);
  expect(new TextDecoder().decode(Buffer.from(id.slice(2, 50), 'hex'))).toBe('pop:people-airdrops:    ');
  expect(() => peopleDrawId(-1n)).toThrow(/index/);
});
it('requires the exact finalized claim call, destination, asset and amount', () => {
  const id = peopleDrawId(1n), claim = { decoded: 'complete', call: { pallet: 'PeopleAirdrops', name: 'claim' }, callArguments: { event_id: id, destination: root.address } };
  const event = { type: 'Airdrop', value: { type: 'PrizeClaimed', value: { event_id: id, beneficiary: root.address, asset_id: prizeAsset, amount: dollar } } };
  expect(() => assertClaimExtrinsic(claim, id, root.address)).not.toThrow();
  expect(assertPrizeClaim([{ event }], id, root.address).amount).toBe(dollar);
  expect(() => assertClaimExtrinsic({ ...claim, call: { pallet: 'Game', name: 'claim_airdrop' } }, id, root.address)).toThrow(/PeopleAirdrops/);
  expect(() => assertClaimExtrinsic(claim, id, 'other')).toThrow(/PeopleAirdrops/);
  expect(() => assertPrizeClaim([event], id, 'other')).toThrow(/beneficiary/);
  expect(() => assertPrizeClaim([{ ...event, value: { ...event.value, value: { ...event.value.value, amount: 1n } } }], id, root.address)).toThrow(/amount/);
  expect(() => assertPrizeClaim([event, event], id, root.address)).toThrow(/Missing or wrong/);
});
it('keeps the M3 unsupported tripwire and payout increase independent of the pending purse', () => {
  expect(() => assertUnsupportedPurse('interrupted: Unsupported')).not.toThrow();
  expect(() => assertUnsupportedPurse('subscribed')).toThrow(/no longer Unsupported/);
  expect(() => assertUnsupportedPurse('interrupted: PermissionDenied')).toThrow(/no longer Unsupported/);
  expect(() => assertPayoutIncrease(9n, dollar + 9n, dollar)).not.toThrow();
  expect(() => assertPayoutIncrease(9n, 0n, dollar)).toThrow(/did not gain/);
  expect(jsonEvidence({ amount: dollar, nested: [1n] })).toEqual({ amount: '1000000', nested: ['1'] });
});
it('@negative-control: a success outer receipt with a swallowed inner failure is rejected', () => {
  const event = (type: string, name: string, value?: unknown) => ({ type, value: { type: name, value } });
  const events = [event('Utility', 'ItemCompleted'), event('Utility', 'BatchCompleted'), event('Sudo', 'Sudid', { sudo_result: { success: true } })];
  expect(() => assertSetupReceipt({ ok: true, events }, 1)).not.toThrow();
  expect(() => assertSetupReceipt({ ok: true, events: [...events, event('Utility', 'ItemFailed')] }, 1)).toThrow(/failed/);
});

it('builds a population-total threshold and rejects values outside the runtime score range', () => {
  expect(thresholdPlan().value.value.schedule).toEqual([{ population_size_threshold: 0xffff_ffff, score_threshold: 3 }]);
  for (const value of [0, 22, 1.5, NaN]) expect(() => thresholdPlan(value)).toThrow(/threshold/);
});
