// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { Actor, ActorRoster } from '@parity/product-lab/domain/actors';
import { flowActorSession, navigationApps, plainAppUrl, validateActorSessionTemplates } from '../../lab/flows/actor-session.ts';
import { names } from '../../lab/flows/contract.ts';

const identity = (name: string) => ({ id: name.toLowerCase(), name, username: 'offline-only', account: 'offline-only' });
it('@negative-control reproduces the exact rejected deep-link actor URL and accepts the served URL', () => {
  const app = navigationApps.find(app => app.id === 'peopl')!;
  const old = { ...identity('Alice'), appUrl: app.url };
  expect(() => Actor.from(old)).toThrow('Application URL must be HTTP(S) without credentials');
  const corrected = flowActorSession(identity('Alice'), 'http://127.0.0.1:29901/');
  expect(Actor.from(corrected).origin).toBe('http://127.0.0.1:29901');
  expect(corrected.appUrl).not.toBe(app.url);
});
it('keeps every player on an isolated HTTP origin for both source apps', () => {
  for (const [index] of navigationApps.entries()) {
    const actors = names.map((name, i) => flowActorSession(identity(name), `http://127.0.0.1:${29901 + index * 10 + i}/`));
    expect(new ActorRoster(actors).actors).toHaveLength(3);
    expect(() => new ActorRoster(actors.map(actor => ({ ...actor, appUrl: actors[0]!.appUrl })))).toThrow('isolated application origins');
  }
  expect(() => validateActorSessionTemplates()).not.toThrow();
});
it('@negative-control rejects credentials and other schemes without exposing them in errors', () => {
  for (const url of ['polkadot://dim2.paseo/', 'ws://127.0.0.1:29901/', 'http://fixture:fixture@127.0.0.1:29901/']) {
    expect(() => plainAppUrl(url)).toThrow('Application URL must be HTTP(S) without credentials');
  }
  expect(plainAppUrl('https://127.0.0.1:29901/')).toBe('https://127.0.0.1:29901/');
});
