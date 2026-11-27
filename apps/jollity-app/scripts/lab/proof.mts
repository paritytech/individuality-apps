// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Read and mint a lite proof through this run's DIM2 host. No transaction is submitted.
import { connectProductSdk } from "../../../../scripts/lib/host-session.mts";
import { createPeopleClient } from "@jollity/game-chain";
import { fromPapi, litePeopleRing, readScoreContext } from "@parity/product-sdk-individuality";
const [frame, people] = process.argv.slice(2);
if (!frame || !people || [frame, people].some((url) => !["127.0.0.1", "[::1]"].includes(new URL(url).hostname))) throw new Error("Proof reader requires local endpoints");
try {
  const sdk = await connectProductSdk(frame);
  const accounts = await sdk.getAccountsProvider();
  if (!accounts) throw new Error("No DIM2 accounts provider");
  const { hostPersonhoodProver } = await import("@parity/product-sdk-individuality/host");
  const chain = createPeopleClient(people);
  try {
    const score = await readScoreContext(fromPapi(chain.client, chain.api));
    if (!score.ok || score.value.tag !== "ProductDerived") throw new Error("Unreadable product-derived lite context");
    const { genesisHash } = await chain.client.getChainSpecData();
    const ring = { key: "lite" as const, owner: score.value.productId, ring: litePeopleRing(genesisHash as `0x${string}`) };
    const prover = hostPersonhoodProver(accounts);
    if (!await prover.holds(ring)) throw new Error("DIM2 host cannot read the lite personhood key");
    const proof = await prover.prove(ring, { productId: score.value.productId, suffix: { tag: "Index", value: 0 } }, new TextEncoder().encode("DIM2 source opening read-only proof"));
    if (!proof.proof.length) throw new Error("DIM2 lite proof is empty");
    console.log("DIM2_LITE_PROOF " + JSON.stringify({ readable: true, bytes: proof.proof.length, ringIndex: proof.ringIndex, ringRevision: proof.ringRevision }));
  } finally { chain.client.destroy(); }
  process.exit(0);
} catch (error) {
  // No raw host responses or wallet paths are retained in shareable output.
  console.error(error instanceof Error ? error.message : "Lite proof failed");
  process.exit(1);
}
