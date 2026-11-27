// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from 'node:url';
import { AppDevServer, type AppDevServerDeclaration } from '@parity/product-lab/domain/apps';
import { validateActorSessionTemplates } from '../../apps/humanity-app/lab/flows/actor-session.ts';

export function sourceAppDeclarations(): Record<'peopl' | 'dim2', AppDevServerDeclaration> {
  const server = fileURLToPath(new URL('./static-server.mjs', import.meta.url));
  return {
    peopl: { command: 'node', args: [server, fileURLToPath(new URL('../../apps/humanity-app/dist/', import.meta.url)), '{port}'], updates: 'none' },
    dim2: { command: 'node', args: [server, fileURLToPath(new URL('../../apps/jollity-app/out/', import.meta.url)), '{port}'], updates: 'none' },
  };
}

/** Validate the same declarations used at runtime before acquiring or starting a fork. */
export function validateSourceApps(declarations = sourceAppDeclarations()): void {
  for (const [app, declaration] of Object.entries(declarations)) AppDevServer.parse(app, declaration);
  validateActorSessionTemplates();
}
