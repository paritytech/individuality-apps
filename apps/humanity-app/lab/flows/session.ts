// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { LabNavigation, type ActorSession, type LabEnvironment, type SessionContext, type HostSession, type HostProvider } from '@parity/product-lab';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { serveApp } from '@parity/product-lab/composition';
import { PageFrameCapture } from '@parity/product-lab/browser-playwright';
import { truapiCliHost, truapiCliProvisioner, watchNavigations } from '@parity/product-lab/host-truapi-cli';
import { Sr25519ProductAccounts, Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { validateEngineSession } from "@parity/product-lab/env-engine";
import { hostSelection, requireLoopback, cleanupAll } from '../opening/session.ts';
import { connectGamesPeople } from '../../../../lab/shared/upstream/lab/steps/games/chain.ts';
import { peopleTransactions } from '../../../../lab/shared/upstream/lab/chain/people.ts';
import { GameRepository } from '../../../../lab/shared/upstream/lab/steps/games/attendance/game.repository.ts';
import type { ChainReads } from '../../../../lab/shared/upstream/three-apps/chain.ts';
import { names } from './contract.ts';
import { hostPortRange } from '../../../../lab/shared/host-ports.ts';
import { FlowCapture } from './recording.ts';
import { sourceAppDeclarations } from '../../../../lab/shared/apps.ts';
import { flowActorSession, navigationApps, plainAppUrl } from './actor-session.ts';

export type Flow = Awaited<ReturnType<typeof start>>;
const flowKey = Symbol.for('humanity-app.humanity-dim2.owned-flow');
const shared = globalThis as typeof globalThis & { [flowKey]?: { active?: Flow } };
export const flowState = shared[flowKey] ??= {};
export function flow(): Flow { if (!flowState.active) throw new Error('No owned flow session'); return flowState.active; }
export function chainReads(access: PapiChainAccess<unknown>): ChainReads {
  return { finalized: () => access.finalizedHead(), blockAt: n => access.blockAt(n),
    storage: (p, i, keys, hash) => access.historicalStorage(p, i, keys, hash),
    async runtimeCall(api, method, args) {
      // Acquire a fresh chainHead pin for the API call; the independent root reads remain at finalized RPC hashes.
      const apis = access.client.getUnsafeApi().apis;
      const call = apis[api]?.[method]; if (!call) throw new Error(`Missing runtime API ${api}.${method}`);
      const head = await access.client.getFinalizedBlock();
      return Reflect.apply(call, apis[api], [...args, { at: head.hash }]);
    } };
}
async function start(context: SessionContext) {
  const { environment, system, signal } = context, routes = environment.routes;
  if (!routes) throw new Error('The flow requires its owned Paseo fork');
  requireLoopback(routes);
  if (!system.processes || !system.commands || !system.ports || !system.locks || !system.appProxies || !system.rpc || !system.clock || !context.browsers || !context.sessionPorts)
    throw new Error('The flow needs local process, proxy, browser, port and RPC adapters');
  const parent = join(context.root, '.product-lab', 'flow'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'run-')), cleanups: Array<() => unknown | Promise<unknown>> = [() => rmSync(directory, { recursive: true, force: true })];
  const capture = process.env.PRODUCT_LAB_RECORDINGS_DIR ? new FlowCapture(process.env.PRODUCT_LAB_RECORDINGS_DIR) : undefined;
  const warnings: unknown[] = [];
  const log = (value: unknown) => { if ((value as { type?: string })?.type === 'app-bind-warning') warnings.push(value); appendFileSync(join(directory, 'evidence.jsonl'), JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v) + '\n'); };
  try {
    const processes = system.processes.open(join(directory, 'processes')); cleanups.push(() => processes.close(), () => processes.stopAll());
    const browser = await context.browsers.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    cleanups.push(() => browser.close());
    const people = connectGamesPeople(routes.chains.people!.ws, signal), hub = PapiChainAccess.connect(routes.chains['asset-hub']!.ws);
    cleanups.push(() => people.close(), () => hub.close());
    const transactions = peopleTransactions(people, { file: join(directory, 'transactions.jsonl'), record: log, activity: log, message: log }, 'finalized');
    const root = new Sr25519KeyDerivation().derive('//Alice');
    const games = new GameRepository(people, transactions, { address: root.address, signer: root.signer });
    const workspace = environment.provenance?.workspace as { directory?: string } | undefined;
    if (!workspace?.directory) throw new Error('No saved-fork workspace provenance');
    const session = validateEngineSession(JSON.parse(readFileSync(join(workspace.directory, 'session.json'), 'utf8')));
    if (session.ownership !== 'owned' || session.mode !== 'fork' || session.network !== 'paseo-next-v2' || session.chains.people.ws !== routes.chains.people!.ws)
      throw new Error('The flow refuses an attached, public or different fork');
    const target = { offer: { chains: Object.keys(routes.chains), services: Object.keys(routes.services), ...environment.offer, local: true }, endpoints: environment.endpoints, humanity: { network: { kind: 'owned' as const, session } } };
    const actors: ActorSession[] = [], sessions: HostSession[] = [], pages = new Map<string, BrowserPage>(), hostActors = new Map<string, HostSession['actor']>();
    const identities = new Map<string, { address: string; game: string; defaultGame: string; humanity: string }>();
    const appUrls = new Map<string, string>();
    const hostSystem = { processes: system.processes, commands: system.commands, ports: system.ports, locks: system.locks };
    const range = context.sessionPorts;
    const baseProvider = truapiCliHost({ host: hostSelection, patches: [], stateRoot: join(directory, 'hosts'), ports: hostPortRange(range), browser, routes, system: hostSystem, accounts: new Sr25519ProductAccounts() });
    cleanups.push(() => baseProvider.dispose());
    const selectedHost = await baseProvider.resolve();
    await baseProvider.prepare();
    const provisioner = truapiCliProvisioner({ host: hostSelection, patches: [], routes, dataRoot: join(directory, 'players'), system: hostSystem });
    const provider: HostProvider = { ...baseProvider, async createSession(request) {
      const appId = request.app.id;
      if (appId !== 'peopl' && appId !== 'dim2') throw new Error('Unknown flow app');
      const app = await serveApp({ app: appId, root: context.root, productId: `${appId}.paseo`, routes, endpoints: environment.endpoints, signal, processes,
        unsetEnvironment: ["GH_TOKEN", "GITHUB_TOKEN"], processName: `${request.actor.id}-${appId}-source`, proxies: system.appProxies!,
        ports: { devServer: await system.ports!.reserve(range), proxy: await system.ports!.reserve(range) },
        devServer: sourceAppDeclarations()[appId] });
      cleanups.push(() => app.stop());
      appUrls.set(`${request.actor.id}:${appId}`, plainAppUrl(app.url));
      const opened = await baseProvider.createSession({ ...request, app: { id: appId, productId: `${appId}.paseo`, url: ({ hostBridgeUrl }) => { app.proxy.bridge(hostBridgeUrl ?? undefined); return app.url; } } });
      // The opening's older lock declares localNetwork only. Observe the released CLI's actual
      // navigation log instead of inventing a navigation or treating a click as successful.
      const navigationAbort = new AbortController();
      const session: HostSession = { ...opened,
        navigations: { [Symbol.asyncIterator]: () => watchNavigations(join(opened.evidence.runDir, 'navigations.jsonl'), { signal: navigationAbort.signal })[Symbol.asyncIterator]() },
        async stop() { navigationAbort.abort(); await opened.stop(); },
      };
      sessions.push(session); pages.set(request.actor.id, await session.page());
      if (capture) {
        try { capture.video(request.actor.id, appId, await new PageFrameCapture({ pages: id => pages.get(id) }).video(request.actor.id)); }
        catch { console.warn('Flow demo page video: not available'); }
      }
      if (appId === 'dim2') {
        const got = await session.account(1);
        if (got.address !== identities.get(request.actor.id)?.game) throw new Error('DIM2 account differs from the identity-derived game account');
      }
      return session;
    } };
    const navigation = new LabNavigation({ provider, apps: navigationApps, namespace: 'paseo', clock: system.clock });
    cleanups.push(() => navigation.close());
    return { context, capture, actors, sessions, pages, hostActors, identities, people, hub, transactions, games, target, directory, log, navigation, cleanups,
      root, warnings, readers: { people: chainReads(people.access), assetHub: chainReads(hub) },
      game: undefined as { index: number; fromBlock: number; playsAt: number } | undefined,
      payoffStartedAt: new Map<string, number>(),
      proofs: new Map<string, Awaited<ReturnType<typeof import('../../../../lab/shared/upstream/lab/steps/dim2/live-game.ts')['readDim2Report']>>>(),
      async create(name: string) {
        if (!names.includes(name as typeof names[number]) || actors.some(a => a.name === name) || actors.length >= 3) throw new Error('Only Alice, Bob and Carol are created once in this run');
        capture?.actorStarted(Date.now());
        const id = name.toLowerCase(), identity = await provisioner.provision({ actor: { id, name }, signal });
        const acquired = await provisioner.host();
        if (selectedHost.sha256 !== acquired.binarySha256) throw new Error('Provisioning and gameplay selected different host binaries');
        const keys = new Sr25519ProductAccounts(), account = (app: string, index = 0) => keys.productAccount(identity.entropy, `${app}.paseo`, index).address;
        identities.set(id, { address: identity.evidence.identityAddress!, game: account('dim2', 1), defaultGame: account('dim2'), humanity: account('peopl') });
        const hostActor = { id, name, identity }; hostActors.set(id, hostActor);
        await navigation.open(hostActor, 'peopl', '/');
        const applicationUrl = appUrls.get(`${id}:peopl`);
        if (!applicationUrl) throw new Error('The owned Humanity session supplied no served application URL');
        const actor = flowActorSession({ id, name, username: identity.liteUsername, account: account('dim2', 1) }, applicationUrl);
        actors.push(actor); capture?.actorReady(Date.now()); return actor;
      },
    };
  } catch (error) { await cleanupAll(cleanups, error); throw error; }
}
export async function flowSessions(context: SessionContext): Promise<LabEnvironment> {
  const state = flowState.active = await start(context); let closed = false;
  return { name: 'Humanity to DIM2 source flow', provider: 'truapi-cli', provenance: { apps: 'both built from this checkout', players: 'three fresh fork identities' },
    actors: () => state.actors, scenarios: [], navigation: state.navigation,
    hostSessions: async () => state.sessions,
    frames: () => new PageFrameCapture({ pages: id => state.pages.get(id) }),
    createActor: options => state.create(options?.name ?? ''),
    observe: async actor => ({ actor: actor.name, username: actor.username }),
    async openApp({ actorId, app, path }) { const actor = state.hostActors.get(actorId); if (!actor) throw new Error('Unknown actor'); await state.navigation.open(actor, app, path); return { app, path }; },
    async close() { if (closed) return; closed = true; state.capture?.closing(Date.now()); try { await cleanupAll(state.cleanups); } finally { if (flowState.active === state) delete flowState.active; } },
  };
}
