// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The statement-store seam. `statementTransport` (and any other policy layer)
 * talks to a `StatementStoreLike` and never cares who provides it:
 *
 * - HOSTED (truapi container): `@parity/product-sdk-host`'s
 *   `getStatementStore()` result satisfies this interface structurally —
 *   pass `() => getStatementStore()` as the `ResolveStore` and the host
 *   signs with the allowance-bearing product account (RFC-10
 *   `createProofAuthorized`) and gossips over the sandbox bridge.
 *
 * - STANDALONE (own WS + own keys): `nodeStatementStore(rpc, prover)` below
 *   implements the same interface over the raw node RPCs (`statement_submit`
 *   / `statement_subscribeStatement`) with a local `StatementProver`
 *   (`keypairStatementProver` from statement.ts).
 *
 * The `proof` value is deliberately OPAQUE (`unknown`): each implementation's
 * `submit` consumes whatever its own `createProofAuthorized` produced (hex
 * SCALE proof from a host; a `StatementProof` object locally). Policy layers
 * pass it through untouched.
 */
import {
  decodeStatement,
  encodeStatement,
  type StatementFields,
  type StatementProof,
  type StatementProver,
} from "./statement"
import { isSubmitSuccess, type StatementRpc } from "./rpc"

export const toHex = (bytes: Uint8Array): string =>
  "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

export const fromHex = (hex: string): Uint8Array => {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex
  const out = new Uint8Array(stripped.length / 2)
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Statement fields at the store boundary — hex strings, product-sdk shape. */
export interface WireStatement {
  expiry: bigint
  channel: string // 0x… (32 bytes)
  topics: string[] // 0x… (32 bytes each)
  data: string // 0x…
}

export interface StatementPage {
  statements: Array<{ data?: string }>
}

export interface StatementSubscription {
  unsubscribe?: () => void
}

/** What a policy layer needs from a statement store. Structurally equal to
 *  product-sdk-host's `HostStatementStore` for the calls used here. */
export interface StatementStoreLike {
  /** Sign `wire` as the allowance-bearing account; returns an opaque proof. */
  createProofAuthorized(wire: WireStatement): Promise<unknown>
  /** Submit the signed statement. Throws/rejects on rejection. */
  submit(wire: WireStatement & { proof: unknown }): Promise<unknown>
  /** Stream statements whose topics match any of `filter.matchAny` (hex). */
  subscribe(
    filter: { matchAny: string[] },
    onPage: (page: StatementPage) => void,
  ): StatementSubscription
}

/** Async store resolution: `null` = no store available (e.g. host without a
 *  statement-store bridge) — the transport then reports `storeLive: false`
 *  instead of throwing. */
export type ResolveStore = () => Promise<StatementStoreLike | null>

function wireToFields(wire: WireStatement): StatementFields {
  if (wire.topics.length !== 1)
    throw new Error(
      `nodeStatementStore supports exactly one topic per statement (got ${wire.topics.length})`,
    )
  return {
    expiry: wire.expiry,
    channel: fromHex(wire.channel),
    topic1: fromHex(wire.topics[0]!),
    data: fromHex(wire.data),
  }
}

/**
 * A `StatementStoreLike` over the raw node RPCs — the standalone counterpart
 * of a truapi host's statement store. Signing is local (`prover`), transport
 * is whatever `createStatementRpc` was given (a plain WS in a browser or
 * Node, a papi client, …).
 */
export function nodeStatementStore(
  rpc: StatementRpc,
  prover: StatementProver,
): StatementStoreLike {
  return {
    async createProofAuthorized(wire) {
      return prover.prove(wireToFields(wire))
    },
    async submit(wire) {
      const encoded = encodeStatement(
        wire.proof as StatementProof,
        wireToFields(wire),
      )
      const result = await rpc.submit(encoded)
      if (!isSubmitSuccess(result))
        throw new Error(`statement rejected: ${JSON.stringify(result)}`)
      return result
    },
    subscribe(filter, onPage) {
      const unsubs = filter.matchAny.map((topic) =>
        rpc.subscribeStatements(fromHex(topic), (statements) => {
          const page: StatementPage = {
            statements: statements.flatMap((encoded) => {
              try {
                return [{ data: toHex(decodeStatement(encoded).data) }]
              } catch {
                return [] // not one of ours / undecodable — skip
              }
            }),
          }
          if (page.statements.length > 0) onPage(page)
        }),
      )
      return {
        unsubscribe: () => {
          for (const u of unsubs) u()
        },
      }
    },
  }
}
