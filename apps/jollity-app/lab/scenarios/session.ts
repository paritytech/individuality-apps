// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorSession, HostSession, LabEnvironment, SessionContext } from '@parity/product-lab';
import { serveApp } from '@parity/product-lab/composition';
import { PageFrameCapture } from '@parity/product-lab/browser-playwright';
import { truapiCliHost, truapiCliProvisioner } from '@parity/product-lab/host-truapi-cli';
import { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import { validateEngineSession } from '@parity/product-lab/env-engine';
import { cleanupAll, requireLoopback } from '../../../../lab/shared/host.ts';
import { hostPortRange } from '../../../../lab/shared/host-ports.ts';
import { ScenarioNetwork, type NetworkScope } from '../../../../lab/shared/network.ts';
import { ScenarioChain } from '../../../../lab/shared/chain.ts';
import { gameParticipant } from '../../../../lab/shared/chain-plan.ts';
import { connectGamesPeople } from '../../../../lab/shared/upstream/lab/steps/games/chain.ts';
import { peopleTransactions } from '../../../../lab/shared/upstream/lab/chain/people.ts';
import { jsonEvidence } from '../../../../lab/shared/observations.ts';
import { dim2SourceServer } from '../opening/app.ts';
import { hostSelection, opened } from '../opening/session.ts';
import { reachHome } from '../opening/gate.ts';
import { readLiteProof } from '../opening/proof.ts';
import { requireOwnedFork } from '../opening/fixture.ts';
/** Jollity's scenarios: one jollity-* feature tag (or the negative control), any named actor, the DIM2 app. */
export const jollityNetworkScope: NetworkScope = {
  tag: /^@(?:jollity-(?:home|registration|results|play|prize|permissions)|negative-control)$/, actor: /^[a-z]+-\d+$/,
  app: 'dim2', name: 'jollity-scenario-network', describe: 'Jollity scenario',
};

const stateKey = Symbol.for('jollity-app.scenarios-b');
const registry = globalThis as typeof globalThis & { [stateKey]?: Awaited<ReturnType<typeof start>> };
export function scenario() { const state = registry[stateKey]; if (!state) throw Error('No owned Jollity scenario session'); return state; }
export const jollityPaths = ['/', '/prize-draw'] as const;
export function requireNavigation(app: string, path: string) {
  if (app !== 'dim2' || !(jollityPaths as readonly string[]).includes(path) && !/^\/chest\?game=\d{1,10}$/.test(path)) throw Error('Jollity scenarios allow only DIM2 home, results and prize draw');
}
/** Each actor's dev server has a fresh output directory. Compile home and the permission route before the host
 * opens the app, as the opening does, so no step pays a cold Next compile inside its own budget. */
export const precompiledPaths = ['/', '/permissions'] as const;
export async function precompileRoutes(base: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  for (const path of precompiledPaths) {
    const answer = await fetcher(new URL(path, base), { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
    await answer.body?.cancel();
    if (answer.status >= 500) throw Error(`DIM2 could not compile ${path} (${answer.status})`);
  }
}
async function start(context: SessionContext) {
  requireOwnedFork(context);
  const { system, environment, signal } = context, routes = environment.routes;
  if (!routes) throw Error('Jollity scenarios need owned local routes'); requireLoopback(routes);
  if (!system.processes || !system.commands || !system.ports || !system.locks || !system.appProxies || !context.browsers || !context.sessionPorts) throw Error('Missing Jollity scenario adapters');
  const workspace = environment.provenance?.workspace as { directory?: string } | undefined;
  if (!workspace?.directory) throw Error('Missing owned Engine provenance');
  const saved = validateEngineSession(JSON.parse(readFileSync(join(workspace.directory, 'session.json'), 'utf8')));
  if (saved.ownership !== 'owned' || saved.mode !== 'fork' || saved.namespace !== routes.namespace || ['people', 'asset-hub', 'bulletin'].some(id => saved.chains[id as keyof typeof saved.chains].ws !== routes.chains[id]?.ws)) throw Error('Jollity scenarios refuse attached, genesis or mismatched chains');
  const parent = join(context.root, '.product-lab', 'scenarios'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'run-'));
  const cleanups: Array<() => unknown | Promise<unknown>> = [() => rmSync(directory, { recursive: true, force: true })];
  try {
    const processes = system.processes.open(join(directory, 'processes')); cleanups.push(() => processes.close(), () => processes.stopAll());
    const network = new ScenarioNetwork(join(directory, 'network'), jollityNetworkScope);
    network.launchArguments.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns');
    const browser = await network.launch(context.browsers); cleanups.push(() => browser.close());
    const people = connectGamesPeople(routes.chains.people!.ws, signal), hub = PapiChainAccess.connect(routes.chains['asset-hub']!.ws);
    cleanups.push(() => people.close(), () => hub.close());
    const evidence: unknown[] = [], record = (value: unknown) => evidence.push(value);
    const transactions = peopleTransactions(people, { file: join(directory, 'transactions.jsonl'), record, activity: record, message: record }, 'finalized');
    const chain = new ScenarioChain(people, transactions, new Sr25519KeyDerivation().derive('//Alice'), {
      offer: context.offer, endpoints: environment.endpoints, humanity: { network: { kind: 'owned', session: saved } },
    }, record);
    const range = context.sessionPorts, hostSystem = { processes: system.processes, commands: system.commands, ports: system.ports, locks: system.locks };
    const provider = truapiCliHost({ host: hostSelection, patches: [], stateRoot: join(directory, 'hosts'), ports: hostPortRange(range), browser, routes, system: hostSystem });
    cleanups.push(() => provider.dispose());
    const provisioner = truapiCliProvisioner({ host: hostSelection, routes, dataRoot: join(directory, 'players'), system: hostSystem });
    const actors: ActorSession[] = [], players: Player[] = [];
    const bots = [1, 2, 3].map(n => gameParticipant(randomBytes(32), routes.namespace, `Lab${n}`));
    let sequence = 0;
    return { context, chain, people, hub, evidence, network, actors, players, bots, cleanups,
      player(name: string) { const player = players.find(p => p.actor.name === name); if (!player) throw Error(`No Jollity player ${name}`); return player; },
      async reset() {
        for (const player of players.splice(0)) { await player.session.stop(); await player.stopApp(); opened.delete(player.actor.id); }
        actors.length = 0; bots.splice(0, bots.length, ...[1, 2, 3].map(n => gameParticipant(randomBytes(32), routes.namespace, `Lab${n}`))); evidence.length = 0; await network.snapshot();
        await chain.drainImportedGames(); chain.current = undefined; chain.ended = undefined; chain.next = undefined; chain.draw = undefined;
      },
      async create(name: string) {
        if (!['Ada', 'Alice', 'Bob', 'Carol'].includes(name) || actors.some(a => a.name === name)) throw Error('Use distinct named Jollity players');
        const id = `${name.toLowerCase()}-${++sequence}`; network.forActor(id);
        const identity = await provisioner.provision({ actor: { id, name }, signal });
        if ((await provisioner.host()).binarySha256 !== (await provider.resolve()).sha256) throw Error('Provisioner and Jollity session selected different hosts');
        await provider.prepare();
        // Each actor owns an app proxy: no host bridge can redirect another actor's signing.
        const source = dim2SourceServer(context.root, join(directory, id), routes); cleanups.push(() => source.cleanup());
        const app = await serveApp({ app: 'dim2', root: context.root, productId: `dim2.${routes.namespace}`, routes, endpoints: environment.endpoints, signal, processes,
          processName: `${id}-jollity-source`, proxies: system.appProxies!, devServer: source.declaration,
          ports: { devServer: await system.ports!.reserve(range), proxy: await system.ports!.reserve(range) },
          unsetEnvironment: Object.keys(process.env).filter(key => /MNEMONIC|SECRET|TOKEN|^HOST_|^TRUAPI_|^NEXT_PUBLIC_|^NEXT_DIST_DIR$|^NEXT_TSCONFIG$/.test(key)) });
        cleanups.push(() => app.stop());
        await precompileRoutes(app.devServerUrl, signal);
        const session = await provider.createSession({ actor: { id, name, identity }, approvals: 'approve-all',
          app: { id: 'dim2', productId: `dim2.${routes.namespace}`, url: ({ hostBridgeUrl }) => { app.proxy.bridge(hostBridgeUrl ?? undefined); return app.url; } } });
        cleanups.push(() => session.stop());
        const game = gameParticipant(identity.entropy, routes.namespace, name);
        if ((await session.account(1)).address !== game.address) throw Error('Jollity host account differs from derived game account');
        const actor = { id, name, username: identity.liteUsername, account: game.address, appUrl: app.url };
        const view = { page: await session.page(), username: identity.liteUsername, account: game.address,
          proof: () => readLiteProof(context, session.evidence),
          async reload() { await session.open!('/'); view.page = await session.page(); await reachHome(view.page, signal); },
          heads: async () => Promise.all([people.access, hub].map(async access => ({ genesis: await access.genesisHash(), finalized: await access.finalizedHead() }))),
        };
        await reachHome(view.page, signal); opened.set(id, view); cleanups.push(() => opened.delete(id));
        actors.push(actor); players.push({ actor, game, session, view, stopApp: async () => { await app.stop(); source.cleanup(); } }); return actor;
      },
    };
  } catch (error) { await cleanupAll(cleanups, error); throw error; }
}
type Player = { actor: ActorSession; game: ReturnType<typeof gameParticipant>; session: HostSession;
  view: NonNullable<ReturnType<typeof opened.get>>; stopApp(): Promise<void> };
export async function jollityScenarioSessions(context: SessionContext): Promise<LabEnvironment> {
  const state = registry[stateKey] = await start(context); let closed = false;
  return { name: 'Jollity scenarios B', provider: 'truapi-cli', provenance: { app: 'workspace Jollity only', actors: 'fresh per scenario' },
    actors: () => state.actors, scenarios: [], createActor: options => state.create(options?.name ?? ''),
    frames: () => new PageFrameCapture({ pages: id => opened.get(id)?.page }),
    hostSessions: async () => state.players.map(player => player.session),
    observe: async actor => jsonEvidence({ actor: actor.name, chain: state.evidence }),
    async openApp({ actorId, app, path }) {
      requireNavigation(app, path); const player = state.players.find(p => p.actor.id === actorId); if (!player) throw Error('No owned Jollity actor');
      await player.session.open!(path); player.view.page = await player.session.page(); if (path === '/') await reachHome(player.view.page, context.signal);
      return { app, path };
    },
    async close() { if (closed) return; closed = true; try { await cleanupAll(state.cleanups); } finally { if (registry[stateKey] === state) delete registry[stateKey]; } },
  };
}
