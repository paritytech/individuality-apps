// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @jollity/statement-core — People-chain statement-store client.
 *
 * Layers, bottom to top:
 *
 * 1. PRIMITIVES (statement.ts, rpc.ts): SCALE statement encode/decode/prove
 *    (`keypairStatementProver`) and the raw node RPCs
 *    (`statement_submit` / `statement_subscribeStatement`) over an injected
 *    transport, in the wire format the native Polkadot apps use. Beside them
 *    sits `dataChannel.ts`, the in-band data-channel mux frame and its lane
 *    payloads.
 *
 * 2. THE STORE SEAM (store.ts): `StatementStoreLike` — the interface every
 *    policy layer talks to. Hosted, `@parity/product-sdk-host`'s
 *    `getStatementStore()` satisfies it structurally (RFC-10
 *    `createProofAuthorized`, product-account signing, sandbox gossip);
 *    standalone, `nodeStatementStore(rpc, prover)` implements it over layer 1.
 *
 * 3. POLICY (statementTransport.ts): WebRTC signalling over the store. This
 *    is the wire the app signals on: JSON frames (one desc slot per
 *    negotiation generation, coalesced candidate slot, generation gating,
 *    per-boot session id, submit backpressure, heartbeat presence + TTL,
 *    sealing to the peers' on-chain keys with the ECDH helpers in crypto.ts).
 *    Chain-agnostic, DOM-free apart from WebRTC types; works against any
 *    chain running the statement store.
 */
export * from "./statement"
export * from "./dataChannel"
export * from "./rpc"
export * from "./store"
export * from "./transport"
export * from "./statementCommon"
export * from "./statementTransport"
export * from "./storeClock"
export * from "./crypto"

/**
 * 4. HEALTH (health.ts): which layer is broken, as a ladder — internet, TURN
 *    credentials, store write, store read, signalling, ICE, media, camera —
 *    where the first failing rung is the blame. Pure decision logic over the
 *    counters layers 1-3 already produce plus the mesh's own per-peer rows;
 *    it reads no state of its own and talks to nothing.
 */
export * from "./health"
