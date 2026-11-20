// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Build settings are the only app selection to change when the local environment lands.
 * `cwd` is relative to the root the session serves from (apps/humanity-app): product-lab refuses absolute paths.
 */
export const scenarioApp = {
  command: 'npm', cwd: '../..', args: ['run', 'dev', '--workspace', '@humanity/app', '--', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'],
  env: { VITE_NETWORK: 'paseo-next-v2', VITE_DOTNS_PRODUCT_LABEL: 'peopl', VITE_HOST_BRIDGE_URL: 'off', VITE_SENTRY_DSN: '' },
  settings: { endpoints: { people: 'VITE_PEOPLE_WS_URL' } }, updates: 'vite' as const,
};
