// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Receipt, TransactionSubmitter } from '@parity/product-lab/ports/chain';

const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const hash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) ? v : undefined;
const word = (v: unknown) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v) ? v : undefined;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
/** Dispatch errors contain enum names and module codes only. No arbitrary event payload is retained. */
function dispatch(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  const v = object(value);
  if (typeof value === 'number') return number(value);
  if (typeof value === 'string') return undefined;
  return { type: word(v.type), index: number(v.index), error: typeof v.error === 'string' && /^0x[0-9a-f]{8}$/i.test(v.error) ? v.error : undefined,
    ...(v.value === undefined ? {} : { value: dispatch(v.value, depth + 1) }) };
}
export function transactionEvidence(label: string, stage: 'included' | 'finalized', receipt: Receipt) {
  // Labels are lab-authored, but never retain a path, URI, free-form error, key or signed bytes.
  const safeLabel = /^[A-Za-z0-9 #'(),.:-]{1,180}$/.test(label) ? label : 'redacted label';
  return { kind: 'receipt', label: safeLabel, stage, at: Date.now(), txHash: hash(receipt.txHash), ok: receipt.ok === true,
    block: { hash: hash(receipt.block.hash), number: number(receipt.block.number), index: number(receipt.block.index) },
    dispatchError: receipt.dispatchError ? dispatch(receipt.dispatchError) : undefined,
    events: receipt.events.flatMap<Record<string, unknown>>(event => {
      if (event.type === 'Sudo' && event.value.type === 'Sudid') {
        const result = object(object(event.value.value).sudo_result);
        return [{ pallet: 'Sudo', event: 'Sudid', success: result.success === true, error: result.success === false ? dispatch(result.value) : undefined }];
      }
      if (event.type === 'Utility' && ['BatchInterrupted', 'ItemFailed'].includes(event.value.type)) {
        const v = object(event.value.value);
        return [{ pallet: 'Utility', event: event.value.type, index: number(v.index), error: dispatch(v.error) }];
      }
      return [];
    }) };
}
/** Observe both stages BEFORE executor validation, including failed inner dispatches. Never swallow a rejection. */
export function observedSubmitter(inner: TransactionSubmitter, write: (value: unknown) => void): TransactionSubmitter {
  return { ...(inner.nonces ? { nonces: inner.nonces } : {}), async submit(request) {
    const tracked = await inner.submit(request);
    const observe = (stage: 'included' | 'finalized', promise: Promise<Receipt>) => {
      const result = promise.then(receipt => { write(transactionEvidence(request.label, stage, receipt)); return receipt; });
      void result.catch(() => undefined);
      return result;
    };
    return { included: observe('included', tracked.included), finalized: observe('finalized', tracked.finalized) };
  } };
}
export function transactionWriter(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return (value: unknown) => appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
}
