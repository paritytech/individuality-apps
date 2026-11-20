// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync } from 'node:fs';

/** Source-only jobs may omit the browser; the prepared CI controls must never silently skip it. */
export function browserAvailable(path: string, options: { ci?: string; required?: string } = {}) {
  const installed = existsSync(path);
  const ci = options.ci ?? process.env.CI;
  const required = options.required ?? process.env.CROSS_APP_BROWSER_CONTROLS;
  if (ci && required === '1' && !installed) throw Error('Prepared CI browser controls require installed Chromium');
  return installed;
}
