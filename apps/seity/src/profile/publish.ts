// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Publish, or clear, a person's avatar: the recipe of the SDK's
 * `product-sdk-profile` skill, one numbered step per function call, in the
 * order the host core's own publisher makes them.
 *
 * The record on chain is one value, so every change is read, change, write
 * back. The SDK prepares; this file signs, pays and submits.
 */
import { submitAndWatch, type SubmittableTransaction, type TxStatus } from "@parity/product-sdk-tx";
import {
  getProfileRecord,
  prepareSetProfile,
  profileAvatar,
  rewriteProfileRecord,
  submitAvatar,
  verifyPublishedProfile,
  type ProfilePatch,
} from "@parity/product-sdk/profile";

import { chains } from "../chain.ts";
import { getPreimageManager } from "../host.ts";
import { ensureIdentityFunded } from "./funding.ts";
import type { ImageCheck } from "./image.ts";
import type { ProfileOwner } from "./owner.ts";

export type PublishStep =
  | "read"
  | "rewrite"
  | "fund"
  | "prepare"
  | "upload"
  | "recheck"
  | "submit"
  | "verify";

export const STEP_LABELS: Record<PublishStep, string> = {
  read: "Reading the current record",
  rewrite: "Rewriting it with the new avatar",
  fund: "Funding the identity account with PGAS",
  prepare: "Preparing the write (dry-run)",
  upload: "Uploading the image to Bulletin",
  recheck: "Checking nobody else changed the record",
  submit: "Signing and waiting for inclusion",
  verify: "Verifying the published record",
};

export type PublishOutcome =
  | { readonly ok: true; readonly cleared: boolean }
  | { readonly ok: false; readonly step: PublishStep; readonly message: string };

export interface PublishOptions {
  readonly owner: ProfileOwner;
  /** The new avatar, or `null` to take it down. */
  readonly image: Extract<ImageCheck, { ok: true }> | null;
  readonly onStep?: (step: PublishStep) => void;
  readonly onTxStatus?: (status: TxStatus) => void;
  /** Finer progress inside a step, e.g. while an allowance lands. */
  readonly onStage?: (stage: string) => void;
}

export async function publishAvatar({ owner, image, onStep, onTxStatus, onStage }: PublishOptions): Promise<PublishOutcome> {
  const { runtime } = await chains();
  const fail = (step: PublishStep, message: string): PublishOutcome => ({ ok: false, step, message });
  // Reads take no origin; only the prepare does.
  const reads = { runtime };

  // 1. The live text, "" for none. A write starts from the text, not a decoded
  //    profile, so entries this app does not understand are carried untouched.
  onStep?.("read");
  const live = await getProfileRecord(owner.label, reads);
  if (!live.ok) return fail("read", live.error.message);

  // 2. The new avatar entry, from the bytes alone: their blake2b-256 digest as
  //    a Bulletin CID. Pure, no host call; the bytes are uploaded in step 5.
  //    Clearing patches `avatar: null`, which drops every avatar entry.
  onStep?.("rewrite");
  let patch: ProfilePatch;
  if (image) {
    const avatar = profileAvatar(image.bytes, image.format);
    if (!avatar.ok) return fail("rewrite", avatar.error.message);
    patch = { avatar: avatar.value };
  } else {
    patch = { avatar: null };
  }

  // 3. The new text: the avatar replaced, every other entry carried as read.
  //    A live record that is not a profile is refused, never overwritten.
  const text = rewriteProfileRecord(live.value, patch);
  if (!text.ok) return fail("rewrite", text.error.message);

  // 4a. The identity account pays the fee and the record's storage deposit in
  //     PGAS, from a host allowance on that same account (funding.ts). No
  //     pallet-revive mapping step: registering the username mapped it.
  onStep?.("fund");
  try {
    await ensureIdentityFunded(owner, onStage);
  } catch (error) {
    return fail("fund", error instanceof Error ? error.message : String(error));
  }

  // 4b. The `setText` call, sized by a dry-run as the owner. A signer that the
  //     registry does not authorise for the name fails here as `Unauthorised`.
  onStep?.("prepare");
  const prepared = await prepareSetProfile(owner.label, text.value, { ...reads, origin: owner.address });
  if (!prepared.ok) return fail("prepare", prepared.error.message);

  // 5. The image bytes, only now that the write is known to go through, so a
  //    write that would fail spends no Bulletin allowance. The host may ask the
  //    person for that allowance here.
  if (image) {
    onStep?.("upload");
    const manager = await getPreimageManager();
    if (manager == null) return fail("upload", "The host has no preimage manager, so the image cannot be stored on Bulletin.");
    const stored = await submitAvatar(image.bytes, manager);
    if (!stored.ok) {
      return fail(
        "upload",
        stored.error.reason === "Timeout"
          ? "The host did not confirm the upload in time. The image may already be stored, so trying again is safe."
          : stored.error.message,
      );
    }
  }

  // 6. A last look: the prepared call stores text rewritten from `original`,
  //    so if another writer changed the record meanwhile, submitting would
  //    erase their change.
  onStep?.("recheck");
  const again = await getProfileRecord(owner.label, reads);
  if (!again.ok) return fail("recheck", again.error.message);
  if (again.value !== prepared.value.original) {
    return fail("recheck", "The profile changed while this was being prepared. Start again from the new record.");
  }

  onStep?.("submit");
  // Under a live runtime the prepared call is a submittable `setText`; the
  // reference app submits it as is, signed by the identity account.
  // Resolves at best-block inclusion, the default; pass `waitFor: "finalized"`
  // to wait out a reorg instead.
  const sent = await submitAndWatch(prepared.value.call as SubmittableTransaction, owner.signer, { onStatus: onTxStatus });
  if (!sent.ok) return fail("submit", sent.error.message);

  // 7. What the chain holds now is what was sent. The read is at the best
  //    block, so it works once the write is included; a call can be included
  //    without being applied, and a reorg can still drop it.
  onStep?.("verify");
  const published = await verifyPublishedProfile(owner.label, prepared.value.text, reads);
  if (!published.ok) return fail("verify", published.error.message);
  if (!published.value) return fail("verify", "The transaction was included, but the record on chain is not the one sent.");

  return { ok: true, cleared: image == null };
}
