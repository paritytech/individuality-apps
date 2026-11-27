// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { setTimeout as delay } from 'node:timers/promises';
import { Blake2256 } from '@polkadot-api/substrate-bindings';
import { fromHex, toHex } from 'polkadot-api/utils';
import type { GamesPeopleConnection } from '../shared/upstream/lab/steps/games/chain.ts';
import { flowStorage } from '../shared/storage.ts';

/** Whether a received socket frame carries the storage key, as JSON hex text or as raw bytes. Pure; payloads are never kept. */
export function frameCarries(payload: string | Buffer | Uint8Array, keyHex: string): boolean {
  const needle = keyHex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64,}$/.test(needle)) throw Error('Storage key needle must be at least 32 hex bytes');
  if (typeof payload === 'string') return payload.toLowerCase().includes(needle);
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return bytes.includes(Buffer.from(needle, 'hex')) || bytes.toString('latin1').toLowerCase().includes(needle);
}

export const extrinsicHash = (hex: string) => toHex(Blake2256(fromHex(hex)));

/**
 * The newest pool sighting among a block's extrinsics: the registration is the last transaction its app sends,
 * after any seat bind. Undefined when the pool poll never caught one of them.
 */
export function submittedMark(blockExtrinsics: readonly string[], pool: ReadonlyMap<string, number>): number | undefined {
  const seen = blockExtrinsics.map(hex => pool.get(extrinsicHash(hex))).filter((at): at is number => at !== undefined);
  return seen.length ? Math.max(...seen) : undefined;
}

type Head = { number: number; hash: string; at: number };
export interface ChainMarks { submitted?: number; included: number; includedBlock: number; includedHash: string; includedRetracted?: true; finalized?: number; finalizedBlock?: number; poolPolls: number; poolMisses: number }

/**
 * Times one account's game registration on People: the node's pool (polled), the best head and the finalized head
 * (both from the lab's own chainHead subscription), reading `Game.Players` at each new head. Read-only.
 */
export class RegistrationWatch {
  private readonly pool = new Map<string, number>();
  private readonly checked = new Set<string>();
  private stops: Array<() => void> = [];
  private included?: Head;
  private finalized?: Head;
  private polls = 0;
  private misses = 0;
  private stopped = false;
  private failure?: unknown;
  constructor(private readonly people: GamesPeopleConnection, private readonly account: string, private readonly pollMs = 200, private readonly qualifies?: (hash: string) => Promise<boolean>) {}

  private async registered(hash: string) {
    if (this.qualifies) return this.qualifies(hash);
    const row = await flowStorage(this.people.access, 'Game', 'Players', [{ type: 'Account', value: this.account }], hash);
    return (row as { registered?: boolean } | undefined)?.registered === true;
  }
  private head(kind: 'best' | 'finalized', block: { number: number; hash: string }) {
    const at = Date.now(), key = `${kind}:${block.hash}`;
    if (this.checked.has(key) || (kind === 'best' ? this.included : this.finalized)) return;
    if (kind === 'finalized' && (!this.included || block.number < this.included.number)) return;
    this.checked.add(key);
    void this.registered(block.hash).then(yes => {
      if (!yes) return;
      const mark = { number: block.number, hash: block.hash, at };
      if (kind === 'best' && (!this.included || at < this.included.at)) this.included = mark;
      if (kind === 'finalized' && (!this.finalized || at < this.finalized.at)) this.finalized = mark;
    }, error => { this.failure ??= error; });
  }
  /** Start before the tap: only pool entries first seen from now on count. */
  start() {
    const client = this.people.access.client;
    const best = client.bestBlocks$.subscribe({ next: blocks => { if (blocks[0]) this.head('best', blocks[0]); }, error: error => { this.failure ??= error; } });
    const finalized = client.finalizedBlock$.subscribe({ next: block => this.head('finalized', block), error: error => { this.failure ??= error; } });
    this.stops.push(() => best.unsubscribe(), () => finalized.unsubscribe());
    void (async () => {
      const before = new Set(((await client._request<string[]>('author_pendingExtrinsics', [])) ?? []).map(extrinsicHash));
      while (!this.stopped && !this.included) {
        try {
          const pending = (await client._request<string[]>('author_pendingExtrinsics', [])) ?? [], at = Date.now();
          this.polls++;
          for (const hex of pending) { const hash = extrinsicHash(hex); if (!before.has(hash) && !this.pool.has(hash)) this.pool.set(hash, at); }
        } catch { this.misses++; }
        await delay(this.pollMs);
      }
    })().catch(error => { this.failure ??= error; });
    return this;
  }
  /** What the watch has seen so far, for a failure message. */
  status() {
    return { includedBlock: this.included?.number ?? null, finalizedBlock: this.finalized?.number ?? null, poolSightings: this.pool.size, poolPolls: this.polls,
      failure: this.failure === undefined ? null : String(this.failure) };
  }
  stop() { this.stopped = true; for (const stop of this.stops.splice(0)) stop(); }
  /** Waits for inclusion, then up to `finalityMs` for finality; a missing finality is reported, not thrown. */
  async marks(signal: AbortSignal, capMs: number, finalityMs = 180_000): Promise<ChainMarks> {
    const until = async (done: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!done() && Date.now() < deadline) { signal.throwIfAborted(); if (this.failure) throw this.failure; await delay(100, undefined, { signal }); }
      return done();
    };
    if (!await until(() => this.included !== undefined, capMs)) throw Error(`Registration never reached a best block within ${capMs} ms`);
    await until(() => this.finalized !== undefined, finalityMs);
    this.stop();
    const included = this.included!;
    // The first best block that showed the result can lose a reorg; once a sibling is finalized the node prunes it and
    // chain_getBlock answers null. Keep the best-head time, say the block was retracted, leave `submitted` unmeasured.
    const block = await this.people.access.client._request<{ block: { extrinsics: string[] } } | null>('chain_getBlock', [included.hash]);
    const submitted = block ? submittedMark(block.block.extrinsics, this.pool) : undefined;
    return { ...(submitted === undefined ? {} : { submitted }), included: included.at, includedBlock: included.number, includedHash: included.hash,
      ...(block ? {} : { includedRetracted: true as const }),
      ...(this.finalized ? { finalized: this.finalized.at, finalizedBlock: this.finalized.number } : {}), poolPolls: this.polls, poolMisses: this.misses };
  }
}

/** Times the first received frame, on the reading app's pages, that carries the key. */
export class FrameProbe {
  readonly hits: number[] = [];
  constructor(private readonly origin: string, private readonly keyHex: string) {}
  readonly listener = (frame: { at: number; url: string; payload: string | Buffer }) => {
    let origin: string; try { origin = new URL(frame.url).origin; } catch { return; }
    if (origin === this.origin && frameCarries(frame.payload, this.keyHex)) this.hits.push(frame.at);
  };
  /** The first hit at or after `from`. */
  first(from: number) { return this.hits.filter(at => at >= from).sort((a, b) => a - b)[0]; }
}
