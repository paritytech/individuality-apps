// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Read a person's avatar: the record from DotNS, the bytes from the host.
 *
 * `getProfile` has three answers and they are kept apart on purpose:
 *   - `Found`: render it (its `avatar` may still be null);
 *   - `NoProfile`: the name has no profile a reader accepts, so clear the cache;
 *   - `err`: the chain could not be asked, so keep the cache and ask again later.
 */
import { getProfile, loadAvatar, type LoadedAvatar } from "@parity/product-sdk/profile";

import { chains } from "../chain.ts";
import { getPreimageManager } from "../host.ts";

export type AvatarRead =
  | { readonly kind: "none" }
  | { readonly kind: "stale"; readonly message: string }
  /** `image` is null when no checked bytes came back this time (`Missing`, `Mismatch`, `TooLarge`, `Unreadable`, or a lookup that failed): show a placeholder, not an error. */
  | { readonly kind: "found"; readonly cid: string; readonly image: LoadedAvatar | null };

export async function readAvatar(label: string, signal?: AbortSignal): Promise<AvatarRead> {
  const { runtime } = await chains();
  // No `origin` on reads: a read dry-runs as its origin, and an account that
  // pallet-revive has never mapped cannot dry-run.
  const result = await getProfile(label, { runtime });
  if (!result.ok) return { kind: "stale", message: result.error.message };
  if (result.value.tag === "NoProfile") return { kind: "none" };

  const { avatar } = result.value.profile;
  if (avatar == null) return { kind: "none" };

  const manager = await getPreimageManager();
  // Through the host, keyed by the digest inside the CID, never a gateway:
  // nobody outside the host learns whose avatar is being looked at.
  const loaded = manager ? await loadAvatar(avatar, manager, { signal }) : null;
  const image = loaded?.ok && loaded.value.tag === "Loaded" ? loaded.value.avatar : null;
  return { kind: "found", cid: avatar.cid, image };
}
