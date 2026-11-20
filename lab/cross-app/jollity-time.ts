// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserPage } from '@parity/product-lab/ports/browser';

/**
 * The game time as Jollity's home and waiting room write it: `formatGameAt` in
 * apps/jollity-app/lib/format.ts, built from `formatClock` and `formatGameTime` in
 * apps/jollity-worker/src/card/format.ts. Today it is the clock alone, "16:00" or
 * "4:00 PM" in the hour cycle of the device; on another day, "Nov 12 at 16:00".
 *
 * Humanity's lab may not import Jollity code, so this mirrors it. It runs in the
 * Jollity page, so the page's clock, time zone and hour cycle decide. The callback
 * stays inline for tests/scenarios/browser-bodies.test.ts, which audits it under
 * tsx's keepNames transform; lab/cross-app/tests/jollity-time.test.ts pins its forms.
 */
export function jollityGameAt(page: Pick<BrowserPage, 'evaluate'>, seconds: number): Promise<string> {
  return page.evaluate(seconds => {
    const at = new Date(seconds * 1000);
    const minutes = String(at.getMinutes()).padStart(2, '0'), hours = at.getHours();
    const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12
      ? `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
      : `${String(hours).padStart(2, '0')}:${minutes}`;
    if (at.toDateString() === new Date().toDateString()) return clock;
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][at.getMonth()];
    return `${month} ${at.getDate()} at ${clock}`;
  }, seconds);
}
