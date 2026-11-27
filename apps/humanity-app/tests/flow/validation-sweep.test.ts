// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { ActorAlias, ActorId, ActorRoster, Session, HostNetworkRoutes, appUrl, appUrlAt, navigationRequest, resolveNavigation } from '@parity/product-lab/domain';
import { BindActors, ActorBindings } from '@parity/product-lab/application';
import { AppDevServer } from '@parity/product-lab/domain/apps';
import { Sr25519ProductAccounts } from '@parity/product-lab/keys-sr25519';
import { truapiCliHost, truapiCliProvisioner, truapiCliNetworkConfig, parseNavigationLine } from '@parity/product-lab/host-truapi-cli';
import type { HostSession, HostProvider } from '@parity/product-lab';
import { LabNavigation } from '@parity/product-lab';
import { flowActorSession, navigationApps } from '../../lab/flows/actor-session.ts';
import { names, requireThree } from '../../lab/flows/contract.ts';
import { sourceAppDeclarations } from '../../../../lab/shared/apps.ts';
import { hostPortRange } from '../../../../lab/shared/host-ports.ts';
import { hostSelection, requireLoopback } from '../../lab/opening/session.ts';
import { readCredits, mintable, creditHash, type ChainReads } from '../../../../lab/shared/upstream/three-apps/chain.ts';

const routes = HostNetworkRoutes.from({ network: 'paseo-next-v2', namespace: 'paseo',
  chains: Object.fromEntries(['people', 'asset-hub', 'bulletin'].map((chain, i) => [chain, { ws: `ws://127.0.0.1:${27010 + i * 10}`, genesis: `0x${String(i + 1).repeat(64)}` }])),
  services: { 'identity-backend': 'http://127.0.0.1:27080/' } });
const sessions = names.map((name, i) => flowActorSession({ id: name.toLowerCase(), name, username: 'offline-only', account: `offline-${i}` }, `http://127.0.0.1:${29901 + i}/`));

it('validates the actual actor aliases, ids, roster, bindings and all six host session keys', async () => {
  for (const session of sessions) {
    expect(ActorAlias.parse(session.name).value).toBe(session.name);
    expect(ActorId.parse(session.id).value).toBe(session.id);
    for (const app of navigationApps) {
      const key = new Session({ actor: session.id, app: app.id, host: 'truapi-cli' });
      expect(Session.fromKey(key.key).equals(key)).toBe(true);
    }
  }
  const requests = names.map(actor => ({ actor, identity: 'new' as const }));
  BindActors.plan(requests, 'fresh', []);
  const bound = await new BindActors({ now: () => 0 } as never).execute(requests, { provision: async name => sessions.find(s => s.name === name)! }, { mode: 'fresh' });
  expect(bound.actors).toEqual([...names]);
  expect(new ActorRoster(sessions).actors).toHaveLength(3);
  expect(() => new ActorBindings(names.map(actor => ({ actor, identity: sessions[0]!, origin: 'provisioned', provisionMs: 0 })))).toThrow('share one identity');
});
it('validates source plans for both apps with real port, URL, environment and settings validation', () => {
  for (const [id, declaration] of Object.entries(sourceAppDeclarations())) {
    const server = AppDevServer.parse(id, declaration);
    const plan = server.plan({ port: 29910, productId: `${id}.paseo`, chains: routes.chains, endpoints: Object.fromEntries(Object.entries(routes.chains).map(([id, route]) => [id, route.ws])) });
    expect(plan.command).toBe('node'); expect(plan.args).toContain('29910');
    const url = appUrl({ id, url: 'http://127.0.0.1:29911/' }, { hostBridgeUrl: null });
    expect(appUrlAt(url, '/')).toBe(url);
    expect(() => appUrlAt(url, '//foreign.invalid/')).toThrow();
  }
});
it('validates loopback route namespace, hashes, required services and provisioning options without provisioning', () => {
  requireLoopback(routes); expect(routes.locality().kind).toBe('loopback');
  routes.locality().assertNotMixed('offline sweep');
  for (const id of ['people', 'asset-hub', 'bulletin']) expect(routes.verifiedChain(id).genesis).toMatch(/^0x[0-9a-f]{64}$/i);
  expect(routes.service('identity-backend')).toMatch(/^http:\/\/127/);
  expect(() => truapiCliNetworkConfig(routes)).not.toThrow();
  // These constructors validate static options; no prepare/resolve/provision call is made.
  const system = { ports: {}, processes: {}, commands: {}, locks: {} } as never;
  const host = truapiCliHost({ host: hostSelection, patches: [], stateRoot: '/offline-host', ports: hostPortRange({ from: 29901, to: 29999 }), routes, browser: {} as never, system, accounts: new Sr25519ProductAccounts() });
  expect(host.id).toBe('truapi-cli');
  expect(truapiCliProvisioner({ host: hostSelection, patches: [], dataRoot: '/offline-players', routes, system }).id).toBeTruthy();
});
it('keeps product/account derivation indices and the three owned accounts distinct', () => {
  const keys = new Sr25519ProductAccounts();
  const accounts = names.map((_, i) => {
    const entropy = new Uint8Array(32).fill(i + 1); // Synthetic test input only; never a saved player.
    const humanity = keys.productAccount(entropy, 'peopl.paseo', 0);
    const game = keys.productAccount(entropy, 'dim2.paseo', 1);
    const defaultGame = keys.productAccount(entropy, 'dim2.paseo', 0);
    expect(new Set([humanity.address, game.address, defaultGame.address]).size).toBe(3);
    return game.address;
  });
  requireThree(accounts, accounts.slice().reverse());
  expect(() => requireThree([...accounts, accounts[0]!], accounts)).toThrow();
});
it('validates the native navigation log envelope and namespace remapping', () => {
  for (const app of navigationApps) for (const url of [app.url, app.url.replace('.paseo', '.dot')]) {
    const request = parseNavigationLine(JSON.stringify({ url, at: 1 }));
    expect(resolveNavigation(request.url, navigationApps.map(app => ({ id: app.id, product: app.productId })), { namespace: 'paseo' })).toMatchObject({ kind: 'app', appId: app.id });
  }
  for (const line of ['not-json', 'null', JSON.stringify({ url: navigationApps[0]!.url, at: '1' }), JSON.stringify({ url: 'polkadot://invalid', at: 1 })]) {
    expect(() => parseNavigationLine(line)).toThrow();
  }
});
it('validates the real deep links separately from HTTP origins and navigates all actors with the real registry', async () => {
  const provider = { id: 'truapi-cli', async createSession(request: Parameters<HostProvider['createSession']>[0]) {
    return { actor: request.actor, app: request.app, page: async () => ({ url: () => `http://127.0.0.1:${29920 + names.indexOf(request.actor.name as typeof names[number])}/` }), open: async () => {}, stop: async () => {} } as unknown as HostSession;
  } } as unknown as HostProvider;
  const navigation = new LabNavigation({ provider, apps: navigationApps, namespace: 'paseo', clock: { date: () => new Date(0) } as never });
  try {
    for (const actor of sessions) for (const app of navigationApps) {
      const request = navigationRequest(app.url, 0);
      expect(resolveNavigation(request.url, navigation.directory().apps, { namespace: 'paseo' })).toMatchObject({ kind: 'app', appId: app.id });
      await navigation.open({ id: actor.id, name: actor.name }, app.id, '/');
      expect(navigation.activeApplication(actor.id)?.appId).toBe(app.id);
    }
    expect(() => navigationRequest('polkadot://broken', 0)).toThrow();
  } finally { await navigation.close(); }
});
it('checks the final credit-reader protocol with matching roots, peers, leaf bounds and claim flags', async () => {
  const keys = new Sr25519ProductAccounts();
  const [account, ...peers] = names.map((_, i) => keys.productAccount(new Uint8Array(32).fill(i + 1), 'dim2.paseo', 1).address);
  const root = { root: `0x${'11'.repeat(32)}`, game_index: 1, leaf_count: 2 };
  let wrongRoot = false, badLeaf = false, claimed = false;
  const head = { hash: `0x${'22'.repeat(32)}`, number: 1 };
  const people = { finalized: async () => head, blockAt: async () => head,
    storage: async (_pallet: string, item: string) => item === 'NftClaimCreditBlocks' ? [1] : root,
    runtimeCall: async () => ({ success: true, value: peers.map((peer, i) => ({ credit: creditHash(1, peer, account!), leaf_index: badLeaf ? 2 : i })) }) } as ChainReads;
  const assetHub = { finalized: async () => head, blockAt: async () => head,
    storage: async (_pallet: string, item: string) => item === 'ClaimedLeaves' ? claimed ? '0x01' : undefined : { ...root, leaf_count: wrongRoot ? 3 : 2 } } as ChainReads;
  const read = () => readCredits({ people, assetHub, account: account!, game: 1, peers });
  expect(mintable(await read())).toHaveLength(2);
  claimed = true; expect(mintable(await read())).toHaveLength(1); claimed = false;
  wrongRoot = true; await expect(read()).rejects.toThrow('arrived on Asset Hub different'); wrongRoot = false;
  badLeaf = true; await expect(read()).rejects.toThrow('outside its tree');
});
