// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import built from '../built.config.ts';
import original from '../lab.cross-app.config.ts';
import { appRoot } from '../build.ts';
import { scenarioApp } from '../../shared/scenario-app.ts';

it('selects the static Humanity output in the config every scenario process loads', () => {
  expect(scenarioApp.command).toBe('node');
  expect(scenarioApp.args).toEqual([expect.stringMatching(/static-server\.mjs$/), expect.stringMatching(/humanity-app\/dist\/$/), '{port}']);
  expect(scenarioApp.updates).toBe('none');
  expect(scenarioApp).not.toHaveProperty('settings'); expect(scenarioApp).not.toHaveProperty('env');
  expect(built.features).toHaveLength(11);
  for (const file of [...built.features, ...built.steps]) { expect(isAbsolute(file)).toBe(false); expect(existsSync(resolve(appRoot, '../../lab/cross-app', file))).toBe(true); }
});
it('keeps the original owned app root for both fresh forks and sessions', async () => {
  const environment = vi.spyOn(original.environments['paseo-copy'], 'start').mockRejectedValue(Error('root probe'));
  const sessions = vi.spyOn(original, 'sessions').mockRejectedValue(Error('root probe'));
  try {
    await expect(built.environments['paseo-copy'].start({ root: 'nested-config-root' } as Parameters<typeof environment>[0])).rejects.toThrow('root probe');
    expect(environment).toHaveBeenCalledWith({ root: resolve(appRoot, '../..') });
    await expect(built.sessions({ root: 'nested-config-root' } as Parameters<typeof sessions>[0])).rejects.toThrow('root probe');
    expect(sessions).toHaveBeenCalledWith({ root: resolve(appRoot, '../..') });
  } finally { vi.restoreAllMocks(); }
});
