// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// One claimable Scarcity collection on Previewnet from genesis, which has none: the collection DIM2's chest is
// approved to read (NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS). //Alice, a funded development account there, signs three
// ordinary calls on Asset Hub; no sudo is involved. Shapes as read from the genesis runtime on 12 November 2026
// (Asset Hub metadata): Scarcity.create_collection(), Scarcity.define_item(collection, transferability, metadata),
// NftClaims.set_collection_minter(collection, selection).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Enum } from "polkadot-api";
import type { SessionContext } from "@parity/product-lab";
import { TransactionExecutor } from "@parity/product-lab/chain";
import type { Clock } from "@parity/product-lab/ports/system";
import type { Signer, TransactionSubmitter } from "@parity/product-lab/ports/chain";
import { PapiChainAccess, PapiTransactionSubmitter } from "@parity/product-lab/chain-papi";
import { Sr25519KeyDerivation } from "@parity/product-lab/keys-sr25519";
import { SystemClock } from "@parity/product-lab/system-node";
import { observedSubmitter } from "../../../../lab/shared/transactions.ts";
import { publicKeyHex } from "../../../../lab/shared/upstream/lab/chain/sudo.ts";
import { requireOwnedGenesis } from "./fixture.ts";

export interface CollectionCall { label: string; pallet: string; name: string; args: Record<string, unknown> }
/** The three calls that make collection `id` (Scarcity.NextCollectionId before the first) claimable at random. */
export function claimableCollectionCalls(id: number): CollectionCall[] {
  if (!Number.isSafeInteger(id) || id < 0 || id > 0xffff_ffff) throw new Error("Scarcity collection id is outside the runtime's u32 range");
  return [
    { label: "Scarcity.create_collection", pallet: "Scarcity", name: "create_collection", args: {} },
    { label: `Scarcity.define_item(${id}, Transferable)`, pallet: "Scarcity", name: "define_item", args: { collection: id, transferability: Enum("Transferable"), metadata: [] } },
    { label: `NftClaims.set_collection_minter(${id}, Random)`, pallet: "NftClaims", name: "set_collection_minter", args: { collection: id, selection: Enum("Random") } },
  ];
}
/** The finalized state a claimable collection must have; anything else names what is missing. Addresses compare by
 * public key, since Asset Hub prints them in its own SS58 prefix. */
export function assertClaimable(id: number, owner: string, state: { collection: unknown; minter: unknown }) {
  const collection = state.collection as { owner?: string; item_count?: number } | undefined;
  const minter = state.minter as { selection?: { type?: string } } | undefined;
  if (!collection) throw new Error(`Scarcity collection ${id} does not exist after its creation`);
  if (!collection.owner || publicKeyHex(collection.owner) !== publicKeyHex(owner)) throw new Error(`Scarcity collection ${id} is not owned by the setup account`);
  if (!(Number(collection.item_count) >= 1)) throw new Error(`Scarcity collection ${id} has no item`);
  if (minter?.selection?.type !== "Random") throw new Error(`Scarcity collection ${id} has no random NftClaims minter`);
}
/** What `submitCollectionCalls` needs: the calls' chain, signer and evidence file. */
export interface CollectionSubmission {
  readonly id: number;
  readonly submitter: TransactionSubmitter;
  readonly signer: Signer;
  /** Builds the chain call of one planned step (the Asset Hub API in a run, a stand-in in tests). */
  readonly build: (step: CollectionCall) => unknown;
  readonly evidenceFile: string;
  readonly signal: AbortSignal;
  readonly clock: Clock;
}
/**
 * Send the three calls, finalized, one after another. Every receipt, a failed one too, is written to the evidence
 * file before the executor validates it (`observedSubmitter`), so a failed call leaves its receipt behind.
 */
export async function submitCollectionCalls(submission: CollectionSubmission): Promise<void> {
  const { id, evidenceFile } = submission;
  const receipts: unknown[] = [];
  let current = "";
  // The shared sanitizer redacts labels with "_"; the call's fixed pallet and name say which receipt this is.
  const write = (value: unknown) => {
    receipts.push({ ...(value as object), call: current });
    writeFileSync(evidenceFile, JSON.stringify({ kind: "owned-genesis-collection", collection: id, receipts }) + "\n", { mode: 0o600 });
  };
  const journal = { file: evidenceFile, record() {}, activity() {}, message() {} };
  const executor = new TransactionExecutor(observedSubmitter(submission.submitter, write), journal,
    { signal: submission.signal, chain: "asset-hub", mode: "finalized", clock: submission.clock });
  for (const step of claimableCollectionCalls(id)) {
    current = `${step.pallet}.${step.name}`;
    console.log(`Genesis fixture: ${step.label}`);
    await executor.submit(step.label, submission.build(step) as Parameters<typeof executor.submit>[1], submission.signer);
  }
}
/** Create one claimable collection on the owned genesis Asset Hub; returns its id for the app's approved list. */
export async function prepareClaimableCollection(context: SessionContext): Promise<number[]> {
  requireOwnedGenesis(context);
  const ws = context.environment.routes?.chains["asset-hub"]?.ws;
  if (!ws || !["127.0.0.1", "[::1]"].includes(new URL(ws).hostname)) throw new Error("Collection setup needs the owned loopback Asset Hub endpoint");
  // The public development derivation, accepted only on an owned genesis network (checked above).
  const alice = new Sr25519KeyDerivation().derive("//Alice");
  const evidenceDir = join(context.root, ".product-lab", "opening-reports", "sanitized");
  mkdirSync(evidenceDir, { recursive: true });
  const access = PapiChainAccess.connect(ws);
  try {
    const api = access.api as unknown as Record<string, Record<string, Record<string, (args: unknown) => unknown>>>;
    const head = await access.finalizedHead();
    const id = Number(await access.storage("Scarcity", "NextCollectionId", [], head.hash) ?? 0);
    await submitCollectionCalls({ id, submitter: new PapiTransactionSubmitter(access, {}), signer: alice.signer,
      evidenceFile: join(evidenceDir, `collection-${Date.now()}.json`), signal: context.signal,
      clock: context.system.clock ?? new SystemClock(),
      build: (step) => {
        const call = api.tx?.[step.pallet]?.[step.name];
        if (!call) throw new Error(`Asset Hub has no ${step.pallet}.${step.name}`);
        return call(step.args);
      } });
    const after = await access.finalizedHead();
    assertClaimable(id, alice.address, {
      collection: await access.storage("Scarcity", "Collections", [id], after.hash),
      minter: await access.storage("NftClaims", "CollectionMinters", [id], after.hash),
    });
    return [id];
  } finally { access.close(); }
}
