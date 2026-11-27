// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { AppDevServer } from '@parity/product-lab/domain/apps';
import { sourceAppDeclarations, validateSourceApps } from '../../../../lab/shared/apps.ts';

it('validates both real source launchers offline using node from PATH', () => {
  const apps = sourceAppDeclarations();
  expect(Object.keys(apps)).toEqual(['peopl', 'dim2']);
  for (const [app, declaration] of Object.entries(apps)) {
    expect(AppDevServer.parse(app, declaration).command).toBe('node');
    expect(declaration.args).toContain('{port}');
    expect(declaration.updates).toBe('none');
  }
  expect(() => validateSourceApps(apps)).not.toThrow();
});

it('@negative-control reproduces the absolute-node rejection for either app before startup', () => {
  const apps = sourceAppDeclarations();
  for (const app of ['peopl', 'dim2'] as const) {
    for (const command of ['/opt/homebrew/Cellar/node@24/24.22.0/bin/node', '/usr/bin/node', 'C:\\nodejs\\node.exe']) {
      expect(() => validateSourceApps({ ...apps, [app]: { ...apps[app], command } })).toThrow(
        `apps.${app}.devServer.command must be a program on PATH or a path relative to the lab's directory, not ${command.replaceAll('\\', '/')} (an absolute path works on one machine only)`);
    }
  }
  expect(() => validateSourceApps()).not.toThrow();
});
