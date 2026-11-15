// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Prefix a raw PUBLIC-asset path with the app's base path.
 *
 * Next auto-prefixes `basePath` for <Link>, router navigation, next/image and
 * `/_next/*` — but NOT raw strings: a `<video src="/x.mp4">`, `<img src>`, a
 * `new Image().src`, or a `fetch("/x")`. Those 404 when the app is served under
 * a sub-path. Wrap such raw absolute paths in `asset()`.
 *
 * A NO-OP unless NEXT_PUBLIC_BASE_PATH is set, so a build served from the
 * root is byte-for-byte unchanged. Inlined at build time.
 */
export function asset(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "") || ""
  return base + path
}
