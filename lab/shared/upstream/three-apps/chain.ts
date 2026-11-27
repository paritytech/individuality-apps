// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// The three-apps journey's chain readers: what a DIM2 game awarded each player (NftCredits on People, delivered to
// Asset Hub's NftClaims), the piece a credit minted (NftClaims.claim: the leaf bit, the CreditClaimed event, the purse
// holding it in Scarcity.NftsByOwner) and where a sent piece went (Scarcity.Transferred, both purses after it).
// Every read is the lab's own, at a finalized block, through the lab's connection: never the app's client or its
// cache. Copied and cut down from product-lab examples/humanity lab/full-journey (strict-credits.ts,
// strict-ownership.ts at 7edbe8fce); what the journey does not need (two games, Merkle profiles, the extrinsic
// decoder) is left out, and its limits are said where they apply.
import { blake2b } from "@noble/hashes/blake2.js";
import { Enum } from "polkadot-api";
import { fail } from "@parity/product-lab";
import { accountKey } from "../lab/full-journey/identity.ts";

export interface BlockRef { readonly number: number; readonly hash: string }
/** What a reader needs from one chain: finalized head, canonical blocks and decoded storage, all at a block hash. */
export interface ChainReads {
  finalized(): Promise<BlockRef>;
  blockAt(number: number): Promise<BlockRef | undefined>;
  storage(pallet: string, entry: string, keys: readonly unknown[], at: string): Promise<unknown>;
  /** A runtime API call pinned at `at` (People only: NftCreditsApi). */
  runtimeCall?(api: string, method: string, args: readonly unknown[], at: string): Promise<unknown>;
}

export interface Credit {
  /** The People block whose credit tree holds it; the claim names it. */
  readonly awardBlock: number;
  readonly game: number;
  readonly leaf: number;
  readonly credit: string;
  /** The co-player whose Person vote awarded it, when the hash matches one of the given peers. */
  readonly peer?: string;
  /** The same root is on Asset Hub (NftClaims.CreditTrees): it can be claimed there. */
  readonly delivered: boolean;
  readonly claimed: boolean;
}
export interface CreditReading { readonly people: BlockRef; readonly assetHub: BlockRef; readonly account: string; readonly credits: readonly Credit[] }

export interface Holding { readonly instance: string; readonly nonce: string; readonly collection: number; readonly item: number }
export interface Piece extends Holding { readonly purse: string }

const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("not-on-chain", `${what} is unreadable`);
  return value as Record<string, unknown>;
};
const integer = (value: unknown, what: string): number => {
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("not-on-chain", `${what} is not an unsigned integer`);
  return value;
};
export function hex(value: unknown, what: string): string {
  if (typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value)) return value.toLowerCase();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  if (value && typeof value === "object" && "asHex" in value && typeof value.asHex === "function") return hex(value.asHex(), what);
  fail("not-on-chain", `${what} has no encoded bytes`);
}
export function sameAccount(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  try { return accountKey(a) === accountKey(b); } catch { return false; }
}

/** The credit DIM2 awards `attestee` when `attester` votes them Person in round 0 of `game` (strict-credits.ts). */
export function creditHash(game: number, attester: string, attestee: string): string {
  if (!Number.isSafeInteger(game) || game < 0 || game > 0xffff_ffff) fail("scenario-refused", "Credit game index is outside u32");
  const index = Buffer.alloc(4); index.writeUInt32LE(game);
  const bytes = Buffer.concat([Buffer.from("polkadot-pop-game"), index, Buffer.of(0, 0),
    Buffer.from(accountKey(attester).slice(2), "hex"), Buffer.of(0), Buffer.from(accountKey(attestee).slice(2), "hex")]);
  return `0x${Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex")}`;
}

/** Bit `leaf` of a ClaimedLeaves bitmap, least significant bit first; an absent bitmap (read successfully) is empty. */
export function leafClaimed(bitmap: unknown, leaf: number): boolean {
  integer(leaf, "Credit leaf");
  if (bitmap == null) return false;
  const bytes = Buffer.from(hex(bitmap, "Claimed-leaf bitmap").slice(2), "hex");
  return ((bytes[leaf >> 3] ?? 0) & (1 << (leaf & 7))) !== 0;
}

function creditRoot(value: unknown, what: string) {
  const root = object(value, what);
  const encoded = hex(root.root, `${what} hash`);
  if (!/^0x[0-9a-f]{64}$/.test(encoded)) fail("not-on-chain", `${what} is not 32 bytes`);
  return { game: integer(root.game_index, `${what} game`), root: encoded, leaves: integer(root.leaf_count, `${what} leaf count`) };
}

/**
 * Every credit `account` (the DIM2 game account the player registered with) holds, at one finalized People block and
 * one finalized Asset Hub block: its leaf, whether Asset Hub has the identical root, and whether the leaf is spent.
 * `peers` names the co-players: a credit whose hash matches none of them, or one from another game than `game`, is a
 * hard failure (a fresh player in this journey earns only from this game's co-players).
 */
export async function readCredits(options: { people: ChainReads; assetHub: ChainReads; account: string; game?: number; peers?: readonly string[] }): Promise<CreditReading> {
  const { people, assetHub, account, peers } = options;
  if (!people.runtimeCall) fail("unsupported-here", "Reading credit proofs needs People's runtime API");
  const [peopleAt, hubAt] = await Promise.all([people.finalized(), assetHub.finalized()]);
  const who = Enum("Account", account);
  const blocks = await people.storage("NftCredits", "NftClaimCreditBlocks", [who], peopleAt.hash) ?? [];
  if (!Array.isArray(blocks)) fail("not-on-chain", "The claimant's credit blocks are unreadable");
  if (blocks.length > 64) fail("scenario-refused", "More than 64 credit blocks: not a fresh player of this journey");
  const credits: Credit[] = [];
  for (const raw of blocks) {
    const block = integer(raw, "Credit award block");
    const root = creditRoot(await people.storage("NftCredits", "NftClaimCreditRoots", [block], peopleAt.hash), "People credit root");
    if (options.game !== undefined && root.game !== options.game) fail("not-on-chain", `${account} holds a credit from game ${root.game}, not this journey's game ${options.game}`);
    const deliveredRaw = await assetHub.storage("NftClaims", "CreditTrees", [block], hubAt.hash);
    const delivered = deliveredRaw != null;
    if (delivered && JSON.stringify(creditRoot(deliveredRaw, "Asset Hub credit root")) !== JSON.stringify(root))
      fail("not-on-chain", `The credit root of People block ${block} arrived on Asset Hub different`);
    const reply = object(await people.runtimeCall!("NftCreditsApi", "nft_claim_credit_proofs", [block, who], peopleAt.hash), "Credit proofs reply");
    if (reply.success !== true || !Array.isArray(reply.value)) fail("not-on-chain", "People's credit proof API did not succeed");
    const bitmap = delivered ? await assetHub.storage("NftClaims", "ClaimedLeaves", [block], hubAt.hash) : undefined;
    for (const entry of reply.value) {
      const row = object(entry, "Credit proof");
      const credit = hex(row.credit, "Credit hash"), leaf = integer(row.leaf_index, "Credit leaf");
      if (leaf >= root.leaves) fail("not-on-chain", `Credit leaf ${leaf} is outside its tree of ${root.leaves}`);
      const peer = peers?.find((candidate) => creditHash(root.game, candidate, account) === credit);
      if (peers && !peer) fail("not-on-chain", `${account} holds a credit no co-player's vote in game ${root.game} explains`);
      credits.push({ awardBlock: block, game: root.game, leaf, credit, ...(peer ? { peer } : {}), delivered, claimed: leafClaimed(bitmap, leaf) });
    }
  }
  return { people: peopleAt, assetHub: hubAt, account, credits };
}

/** The credits that can be minted now: delivered to Asset Hub and not spent. */
export const mintable = (reading: CreditReading): Credit[] => reading.credits.filter((credit) => credit.delivered && !credit.claimed);
