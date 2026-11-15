// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* what the device says about itself. Both are live and both are read all over:
   keep them in one place so CSS and JS never disagree on what a phone is. */

export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches

/* the phone: the same 500 px breakpoint styles.css uses to take #app full
   bleed, so CSS and JS never disagree on what "mobile" is. Live (a MediaQueryList,
   not a boolean) — the window can cross it without a reload */
export const MOBILE = matchMedia('(max-width: 500px)')
