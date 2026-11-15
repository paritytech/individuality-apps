// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One chain read as a `chain.read` span under the flow in flight, so a slow
 * card load shows *which* storage query took the time and not one bar.
 *
 * Host calls attach themselves in `host-api.ts` because every one of them
 * goes through one function; chain reads are `api.query.X.Y.getValue(…)`
 * calls spread across the read modules, with no common seam, so each read
 * worth a line in the trace is named at its call site. `name` is stable
 * text — `Score.Participants`, `ring.standing` — never an address.
 */
import { childSpan, errorKind } from "@humanity/shared/telemetry/flow.ts";

export async function tracedRead<T>(name: string, read: () => Promise<T>): Promise<T> {
  const end = childSpan("chain.read", name);
  try {
    const value = await read();
    end({ ok: true });
    return value;
  } catch (error) {
    end({ ok: false, detail: errorKind(error) });
    throw error;
  }
}
