// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ActorSession } from '@parity/product-lab';
import { Actor, ActorAlias, ActorRoster, Session } from '@parity/product-lab/domain/actors';
import { navigationRequest } from '@parity/product-lab/domain/navigation';
import { names } from './contract.ts';

export function plainAppUrl(url: string): string {
  Actor.origin(url);
  return url;
}

export function flowActorSession(identity: Pick<ActorSession, 'id' | 'name' | 'username' | 'account'>, applicationUrl: string): ActorSession {
  const session = { ...identity, appUrl: plainAppUrl(applicationUrl) };
  Actor.from(session);
  return session;
}

/** Product deep links are navigation targets, never actor application origins. */
export const navigationApps = ['peopl', 'dim2'].map(id => ({ id, productId: `${id}.paseo`, url: `polkadot://${id}.paseo` }));

export function validateActorSessionTemplates(): void {
  for (const [index] of navigationApps.entries()) {
    const app = navigationApps[index]!;
    navigationRequest(app.url, 0);
    const actors = names.map((name, player) => flowActorSession({ id: name.toLowerCase(), name,
      username: 'preflight-only', account: 'preflight-only' }, `http://127.0.0.1:${3000 + index * 10 + player}/`));
    for (const actor of actors) {
      ActorAlias.parse(actor.name);
      new Session({ actor: actor.id, app: app.id, host: 'truapi-cli' });
    }
    new ActorRoster(actors);
  }
}
