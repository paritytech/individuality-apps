// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Match the deployed builds while keeping the local fork free of release checks and telemetry. */
export const sourceBuildEnvironment = {
  VITE_NETWORK: 'paseo-next-v2', VITE_DOTNS_PRODUCT_LABEL: 'peopl', VITE_HOST_BRIDGE_URL: 'off',
  VITE_DEBUG_PANEL: 'true', VITE_LOG_LEVEL: 'debug', VITE_SENTRY_DSN: '',
  NEXT_PUBLIC_NETWORK_NAME: 'paseo', NEXT_PUBLIC_PRODUCT_DOTNS: 'dim2.paseo', NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX: '1',
  NEXT_PUBLIC_SENTRY_DSN: '', NEXT_PUBLIC_SENTRY_DSN_TEST: '', NEXT_PUBLIC_SENTRY_TAG: '', NEXT_PUBLIC_TELEMETRY_LOGS: '0',
  NEXT_PUBLIC_JOLLITY_PREVIEW: '0', NEXT_PUBLIC_VERSION_URL: '', NEXT_TELEMETRY_DISABLED: '1',
} as const;
export const sourceBuildCommands = [
  { command: 'npm', args: ['run', 'humanity:build'] },
  { command: 'npm', args: ['run', 'build'] },
] as const;

/** The Shown control used by the journey must survive the production build. */
export function assertHumanityDebugPanel(directory: string): void {
  const scripts = (at: string): string[] => readdirSync(at, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? scripts(join(at, entry.name)) : entry.name.endsWith('.js') ? [join(at, entry.name)] : []);
  if (!scripts(directory).some(path => readFileSync(path, 'utf8').includes('debug-panel')))
    throw new Error('Humanity source build has no debug panel; use the staging debug-panel and logging settings');
}
