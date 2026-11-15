// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the code on the card's back says.
 *
 * The bare SS58 address of the account that owns the person's username,
 * as plain text. It is the one payload both Polkadot app scanners turn into
 * a chat with that person: each looks the address up in the People chain's
 * username registry for the name and the chat key, so the card stays right
 * after a name upgrade or a key rotation. It is also exactly what the app's
 * own "share my ID" code prints. No URL form works on both platforms today
 * (the Android chat link waits for a chat that does not exist yet, the iOS
 * one needs its own parameters, and the plain web host is not an app link
 * on iOS), and a stock camera does nothing with a bare address — the back
 * says to scan it from the Polkadot app.
 *
 * One function, so a proper "message me" link is a one-line change here.
 */
export function cardQrPayload(card: { ownerAccount: string | null }): string | null {
  const account = card.ownerAccount?.trim();
  return account == null || account === "" ? null : account;
}

/** The line under the code on the back. */
export const CARD_QR_NOTE = "Scan from the Polkadot app to start a chat";

/** Only the black materials want a light code: mid silver carries white
 *  text happily but would swallow a white code (the design's rule). Relative
 *  luminance puts mid grey near 0.18, so the threshold sits just above black.
 *  Painted at full strength, the tightest case is dark silver at about 3:1
 *  against its darker stop, which scans; every other material clears 3.9. */
export function qrInkFor(base1: string, base2: string): string {
  return (luminance(base1) + luminance(base2)) / 2 > 0.05 ? "#101114" : "#F4F4F5";
}

/** Relative luminance of a #rrggbb; unknown formats read as mid grey. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m == null) return 0.5;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
