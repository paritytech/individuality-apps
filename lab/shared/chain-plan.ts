// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createECDH, createHash } from 'node:crypto';
import { HDKD, getPublicKey, secretFromSeed } from '@scure/sr25519';
import { blake2b256, entropyToMiniSecret } from '@polkadot-labs/hdkd-helpers';
import { Sr25519Signer, Sr25519ProductAccounts, Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import { localPhases, type Call } from './upstream/lab/steps/games/fork-setup-plan.ts';
import type { GameParticipant } from './upstream/lab/steps/games/participant.ts';

export const call = (pallet: string, name: string, args: unknown = undefined): Call => ({ type: pallet, value: { type: name, value: args } });
export const rootBatch = (calls: Call[]) => call('Sudo', 'sudo', { call: call('Utility', 'batch_all', { calls }) });
export const shortPhases = { ...localPhases, registration: 180, shuffle: 30, reporting: 300, player_process: 30 };
export function gamePlan(now: number, playsIn: number, registration = true) {
  if (![now, playsIn].every(Number.isSafeInteger) || playsIn < 180) throw Error('Game needs at least 180 seconds of scheduling headroom');
  const phases = { ...shortPhases, registration: registration ? playsIn - 60 : shortPhases.registration };
  const schedule = { game_play_time: now + playsIn, rounds: 1, max_group_size: 4, airdrops: [] };
  return { phases, schedule, opensAt: schedule.game_play_time - phases.shuffle - phases.registration,
    calls: [call('Game', 'set_game_phases', { phases }), call('Game', 'schedule_games', { games_schedules: [schedule] })] };
}

/** RFC product-account index junction is domain separated; a numeric /1 is a different key. */
export function gameParticipant(entropy: Uint8Array, namespace: string, name: string): GameParticipant {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw Error('Invalid network namespace');
  const product = `dim2.${namespace}`, keys = new Sr25519ProductAccounts();
  const expected = keys.productAccount(entropy, product, 1);
  const encoder = new TextEncoder();
  const junction = (word: string) => {
    const bytes = encoder.encode(word), code = new Uint8Array(32);
    if (bytes.length >= 32) throw Error('Product derivation junction is too long');
    code[0] = bytes.length << 2; code.set(bytes, 1); return code;
  };
  let secret: Uint8Array = secretFromSeed(entropyToMiniSecret(entropy));
  for (const word of ['product', product]) secret = HDKD.secretHard(secret, junction(word));
  const index = new Uint8Array(32); new DataView(index.buffer).setUint32(0, 1, true);
  index.set(blake2b256(encoder.encode('product-account-index')).subarray(0, 28), 4);
  secret = HDKD.secretSoft(secret, index);
  const publicKey = getPublicKey(secret);
  const signer = new Sr25519Signer(publicKey, bytes => {
    // Sr25519KeyDerivation keeps the expanded secret in a closure as well.
    return new Sr25519KeyDerivation().derive(`0x${Buffer.from(secret).toString('hex')}`).signer.sign(bytes);
  });
  const address = new Sr25519KeyDerivation().address(publicKey);
  if (address !== expected.address) throw Error('Game signer differs from host product account 1');
  // Game identifiers are uncompressed SEC1 public keys (65 bytes), not AccountId32s.
  const communication = createECDH('secp256k1');
  communication.setPrivateKey(createHash('sha256').update(publicKey).digest());
  return { name, address, signer, identifier: `0x${communication.getPublicKey('hex', 'uncompressed')}` };
}
export function gracePlan(misses: number, window: number) {
  if (!Number.isInteger(misses) || !Number.isInteger(window) || misses < 0 || misses >= window || window > 8) throw Error('Invalid absence grace');
  return call('Score', 'set_absence_grace_schedule', { schedule: [{ population_size_threshold: 0xffff_ffff, allowed_misses: misses, window }] });
}
export function forcedAttendance(account: string, pattern: string, firstIndex: number) {
  if (!/^[AM]{1,8}$/.test(pattern) || !Number.isSafeInteger(firstIndex) || firstIndex < 0 || firstIndex + pattern.length > 0xffff_ffff) throw Error('Invalid attendance pattern or index');
  return [...pattern].map((mark, offset) => call('Score', 'force_set_attendance', { who: { type: 'Account', value: account }, attended: mark === 'A', game_index: firstIndex + offset }));
}
export interface ScoreRecord {
  score: number; streak: { type: 'Attended' | 'Absent'; value: number }; attendance_history: number;
  recognition: { type: string; value?: unknown }; reached_personhood: boolean; last_attended_game?: number;
}
export function scoreRecord(value: unknown): ScoreRecord {
  if (!value || typeof value !== 'object') throw Error('Missing Score.Participants');
  const s = value as ScoreRecord;
  if (!Number.isInteger(s.score) || s.score < 0 || s.score > 21 || !Number.isInteger(s.attendance_history) || s.attendance_history < 0 || s.attendance_history > 255 ||
    !['Attended', 'Absent'].includes(s.streak?.type) || !Number.isInteger(s.streak.value) || s.streak.value < 0 ||
    !['NotRecognized', 'Recognized', 'Suspended', 'ExternallyRecognized'].includes(s.recognition?.type) || typeof s.reached_personhood !== 'boolean' ||
    (s.last_attended_game !== undefined && (!Number.isSafeInteger(s.last_attended_game) || s.last_attended_game < 0))) throw Error('Malformed Score.Participants');
  return s;
}
export function attendanceAfter(before: number, pattern: string) {
  if (!/^[AM]{1,8}$/.test(pattern)) throw Error('Invalid attendance pattern');
  return [...pattern].reduce((byte, mark) => ((byte << 1) | Number(mark === 'A')) & 255, before);
}
export function assertAttendance(before: ScoreRecord, after: ScoreRecord, pattern: string, firstIndex: number) {
  const tail = pattern.match(/(A+|M+)$/)![0]!;
  const same = before.streak.type === (tail[0] === 'A' ? 'Attended' : 'Absent');
  const run = tail.length + (tail.length === pattern.length && same ? before.streak.value : 0);
  const lastA = pattern.lastIndexOf('A');
  if (after.attendance_history !== attendanceAfter(before.attendance_history, pattern) || after.streak.type !== (tail[0] === 'A' ? 'Attended' : 'Absent') || after.streak.value !== run ||
    after.last_attended_game !== (lastA < 0 ? before.last_attended_game : firstIndex + lastA)) throw Error('Finalized attendance, streak or last attended game differs from pattern');
}

export const prizeAsset = { parents: 1, interior: { type: 'X3' as const, value: [
  { type: 'Parachain' as const, value: 1000 }, { type: 'PalletInstance' as const, value: 50 }, { type: 'GeneralIndex' as const, value: 50_000_519n },
] as [{ type: 'Parachain'; value: number }, { type: 'PalletInstance'; value: number }, { type: 'GeneralIndex'; value: bigint }] } };
export const dollar = 1_000_000n;
export function prizeSource(parameter: unknown): string {
  if (parameter === undefined) {
    // AccountIdConversion of PalletId(*b"pop/pads"): b"modl" ++ id ++ zero padding.
    const bytes = new Uint8Array(32); bytes.set(new TextEncoder().encode('modlpop/pads'));
    return new Sr25519KeyDerivation().address(bytes);
  }
  const outer = parameter as { type?: string; value?: { type?: string; value?: unknown } };
  if (outer.type !== 'PeopleAirdrops' || outer.value?.type !== 'PrizeSource' || typeof outer.value.value !== 'string') throw Error('Malformed PeopleAirdrops prize-source parameter');
  return outer.value.value;
}
/** Seconds from the draw's schedule to its registration start and to its draw. The full setup keeps +60/+240; the fast
 * setup's window only has to cover the app's own draw registration (efficiency study (d), A6). */
export const drawWindows = { full: { registration: 60n, draw: 240n }, fast: { registration: 15n, draw: 90n } } as const;
export function drawPlan(nowSeconds: bigint, authority: string, source: string, window: { registration: bigint; draw: bigint } = drawWindows.full) {
  if (nowSeconds < 0n || window.registration < 0n || window.draw <= window.registration || window.draw >= 3_600n) throw Error('Invalid draw time');
  const mint = (beneficiary: string, amount: bigint) => call('Utility', 'dispatch_as_fallible', {
    as_origin: { type: 'system', value: { type: 'Signed', value: authority } },
    call: call('Assets', 'mint', { id: prizeAsset, beneficiary: { type: 'Id', value: beneficiary }, amount }),
  });
  const info = { product_name: new TextEncoder().encode('peopl'), registration_starts: nowSeconds + window.registration, draw_time: nowSeconds + window.draw, end_time: nowSeconds + 3_600n,
    prize: { asset_id: prizeAsset, asset_amount: dollar, max_winners: 1, winner_cap: 1_000_000 } };
  return { info, calls: [call('Assets', 'force_create', { id: prizeAsset, owner: { type: 'Id', value: authority }, is_sufficient: true, min_balance: 1n }),
    mint(authority, 1n), call('Airdrop', 'enable_asset', { asset_id: prizeAsset, source: authority }), mint(source, dollar), call('PeopleAirdrops', 'schedule_draws', { draws: [info] })] };
}
export function peopleDrawId(index: bigint): string {
  if (index < 0n || index > 0xffff_ffff_ffff_ffffn) throw Error('Invalid people draw index');
  const bytes = new Uint8Array(32); bytes.set(new TextEncoder().encode('pop:people-airdrops:    '));
  new DataView(bytes.buffer).setBigUint64(24, index, false); return `0x${Buffer.from(bytes).toString('hex')}`;
}
export function assertPrizeClaim(events: unknown[], id: string, destination: string) {
  const claims = events.flatMap(value => {
    const e = (value as { event?: unknown }).event ?? value;
    const outer = e as { type?: string; value?: { type?: string; value?: { event_id?: string; beneficiary?: string; amount?: bigint; asset_id?: unknown } } };
    return outer.type === 'Airdrop' && outer.value?.type === 'PrizeClaimed' && outer.value.value?.event_id === id ? [outer.value.value] : [];
  });
  if (claims.length !== 1 || claims[0]!.beneficiary !== destination || claims[0]!.amount !== dollar ||
    JSON.stringify(claims[0]!.asset_id, (_, v) => typeof v === 'bigint' ? String(v) : v) !== JSON.stringify(prizeAsset, (_, v) => typeof v === 'bigint' ? String(v) : v)) throw Error('Missing or wrong Airdrop.PrizeClaimed beneficiary, amount or asset');
  return claims[0]!;
}

export function assertClaimExtrinsic(entry: { decoded: string; call?: { pallet: string; name: string }; callArguments?: unknown }, id: string, destination: string) {
  const args = entry.callArguments as { event_id?: string; destination?: string } | undefined;
  if (entry.decoded !== 'complete' || entry.call?.pallet !== 'PeopleAirdrops' || entry.call.name !== 'claim' || args?.event_id !== id || args.destination !== destination) throw Error('Finalized prize extrinsic is not the expected PeopleAirdrops.claim');
}
export function assertUnsupportedPurse(answer: string) {
  if (answer !== 'interrupted: Unsupported') throw Error(`Coinage purse no longer Unsupported: ${answer}`);
}
export function assertPayoutIncrease(before: bigint, after: bigint, amount: bigint) {
  if (amount <= 0n || after !== before + amount) throw Error('Product account 0 did not gain the PrizeClaimed amount');
}

export function thresholdPlan(threshold = 3) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 21) throw Error('Invalid personhood threshold');
  return call('Score', 'set_personhood_threshold_schedule', { schedule: [{ population_size_threshold: 0xffff_ffff, score_threshold: threshold }] });
}

/** The play deposit plus fee headroom, as GameRepository.fundLocalGameAccounts funds a game account. */
export const fundingHeadroom = 10_000_000_000n;
/** Fast setup: the authority's transfers to accounts short of the minimum, as root calls for the schedule's batch. */
export function fundingPlan(authority: string, deposit: bigint, accounts: ReadonlyArray<{ address: string; free: bigint }>) {
  if (deposit < 0n || new Set(accounts.map(a => a.address)).size !== accounts.length) throw Error('Invalid game account funding');
  const minimum = deposit + fundingHeadroom;
  return accounts.filter(a => a.free < minimum).map(a => call('Balances', 'force_transfer', {
    source: { type: 'Id', value: authority }, dest: { type: 'Id', value: a.address }, value: minimum - a.free }));
}
/**
 * Fast setup: the imported-game drain as one root batch, removals before the cancellation as the sequential drain
 * sends them. Undefined means the batch cannot be used: with no game, the runtime may promote a schedule between the
 * read and the block, and a game past Shuffle cannot be cancelled. The sequential drain handles both.
 */
export function drainPlan(game: { state: { type: string } } | undefined, schedules: ReadonlyArray<{ game_play_time: number }>): Call[] | undefined {
  if (!game) return schedules.length ? undefined : [];
  if (!['Registration', 'Shuffle'].includes(game.state.type)) return undefined;
  return [...schedules.map(s => call('Game', 'remove_scheduled_game', { game_play_time: s.game_play_time })), call('Game', 'cancel_game')];
}
/** Fast setup's member: `attended` forced marks on the indices just below the fixture's game (G-N ... G-1), so a real
 * game G played afterwards lines up with the app's attendance anchor. */
export function memberMarks(account: string, attended: number, gameIndex: number) {
  if (!Number.isInteger(attended) || attended < 2 || attended > 8 || !Number.isSafeInteger(gameIndex) || gameIndex < attended) throw Error('Invalid member fixture');
  return { firstIndex: gameIndex - attended, calls: forcedAttendance(account, 'A'.repeat(attended), gameIndex - attended) };
}
