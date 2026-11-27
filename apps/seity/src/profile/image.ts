// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The product's half of `profileAvatar`: the SDK takes the declared format on
 * trust ("whether the bytes are an image of that format is the product's
 * check"), and readers never sniff. So the format is decided here, from the
 * bytes. The size bound is the SDK's: `profileAvatar` refuses anything over
 * 2 MiB as `TooLarge`.
 */
import type { ProfileAvatarFormat } from "@parity/product-sdk/profile";

export type ImageCheck =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly format: ProfileAvatarFormat }
  | { readonly ok: false; readonly message: string };

export async function readImage(file: File): Promise<ImageCheck> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffFormat(bytes);
  return format ? { ok: true, bytes, format } : { ok: false, message: "That file is not a PNG, JPEG, WebP or GIF image." };
}

function sniffFormat(b: Uint8Array): ProfileAvatarFormat | null {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  // "RIFF" <size> "WEBP"
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}
