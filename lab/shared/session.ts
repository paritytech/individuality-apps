// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorSession, LabEnvironment, SessionContext, HostSession } from '@parity/product-lab';
import { serveApp } from '@parity/product-lab/composition';
import { PageFrameCapture } from '@parity/product-lab/browser-playwright';
import { truapiCliHost, truapiCliProvisioner } from '@parity/product-lab/host-truapi-cli';
import { Sr25519KeyDerivation, Sr25519ProductAccounts } from '@parity/product-lab/keys-sr25519';
import { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { validateEngineSession } from '@parity/product-lab/env-engine';
import { hostSelection } from '../../apps/humanity-app/lab/opening/session.ts';
import { opened, requireLoopback, cleanupAll } from './host.ts';
import { humanityRoot } from './paths.ts';
import { connectGamesPeople } from './upstream/lab/steps/games/chain.ts';
import { TransactionExecutor } from '@parity/product-lab/chain';
import { PapiTransactionSubmitter } from '@parity/product-lab/chain-papi';
import { SudoDispatchValidator } from './upstream/lab/chain/sudo.ts';
import { observedSubmitter, transactionWriter } from './transactions.ts';
import { PEOPLE_SIGNING } from './upstream/lab/chain/people.ts';
import { peopleTransactions } from './upstream/lab/chain/people.ts';
import { hostPortRange } from './host-ports.ts';
import { scenarioApp } from './scenario-app.ts';
import { requireScenarioTarget } from './target.ts';
import { gameParticipant } from './chain-plan.ts';
import { jsonEvidence } from './observations.ts';
import { ScenarioChain } from './chain.ts';
import { ScenarioNetwork } from './network.ts';
import { readWatchedText } from './watched-text.ts';
import { setupMode } from './setup-mode.ts';
import { serveVersionFile } from '../cross-app/version-file.ts';
import { installJourneyMarks } from '../cross-app/document-marks.ts';
import { sourceAppDeclarations } from './apps.ts';

const stateKey = Symbol.for('humanity-app.scenarios-a');
const globalState = globalThis as typeof globalThis & { [stateKey]?: Awaited<ReturnType<typeof start>> };
export function scenario() { const state = globalState[stateKey]; if (!state) throw Error('No owned Humanity scenario session'); return state; }

/** `jollity` (the cross-app lab) also serves the Jollity build and opens it for Ada in her own host process, as the flow does. */
async function start(context: SessionContext, options: { jollity?: boolean } = {}) {
  const { environment, system, signal } = context, routes = environment.routes;
  if (!routes) throw Error('Humanity scenarios need owned local routes');
  requireLoopback(routes);
  if (!system.processes || !system.commands || !system.ports || !system.locks || !system.appProxies || !context.browsers || !context.sessionPorts) throw Error('Missing scenario system adapters');
  const workspace = environment.provenance?.workspace as { directory?: string } | undefined;
  if (!workspace?.directory) throw Error('Missing Engine session provenance');
  const saved = validateEngineSession(JSON.parse(readFileSync(join(workspace.directory, 'session.json'), 'utf8')));
  if (saved.ownership !== 'owned' || saved.namespace !== routes.namespace || ['people', 'asset-hub', 'bulletin'].some(id => saved.chains[id as keyof typeof saved.chains].ws !== routes.chains[id]?.ws)) throw Error('Humanity scenarios refuse an attached or public chain');
  const parent = join(context.root, '.product-lab', 'scenarios'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'run-'));
  const cleanups: Array<() => unknown | Promise<unknown>> = [() => rmSync(directory, { recursive: true, force: true })];
  const evidence: unknown[] = [], record = (value: unknown) => evidence.push(value);
  try {
    const processes = system.processes.open(join(directory, 'processes')); cleanups.push(() => processes.close(), () => processes.stopAll());
    const versionFile = options.jollity && process.env.CROSS_APP_UPDATE_LAB === '1' ? await serveVersionFile(directory) : undefined;
    if (versionFile) cleanups.push(() => versionFile.close());
    const network = new ScenarioNetwork(join(directory, 'network'));
    // Start before either page opens: a capability failure can precede the Register tap.
    const crossAppLog: Array<{ at: number; url: string; text: string }> = [];
    if (options.jollity) network.consoleProbes.add(message => {
      if (/sign-up|sign up|Jollity takes|no host|capabilit|seat|name[- ]link|name .*Register may go|game-registration|^\[jollity-rtc\]|statement.*(?:refus|fail|allowance)/i.test(message.text) &&
        !/remote cand|stats cand|candidate:|ice-pwd|ice-ufrag|credential/i.test(message.text)) {
        crossAppLog.push({ ...message, text: message.text.slice(0, 600) });
        if (crossAppLog.length > 1000) crossAppLog.splice(100, 1);
      }
    });
    if (options.jollity) {
      network.initializers.push(installJourneyMarks);
      // The same synthetic media device as the real full-flow play-through. No product changes.
      // The deny-all resolver also denies Chromium's randomized .local ICE candidates across contexts.
      // Advertise same-host interface candidates directly; retain the UDP policy and every outside HTTP/WS guard.
      network.launchArguments.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns');
    }
    const browser = await network.launch(context.browsers); cleanups.push(() => browser.close());
    const people = connectGamesPeople(routes.chains.people!.ws, signal), hub = PapiChainAccess.connect(routes.chains['asset-hub']!.ws);
    cleanups.push(() => people.close(), () => hub.close());
    // Full setup (nightly): every lab transaction waits for finality. Fast setup (pull requests): intermediate ones wait
    // for inclusion, and ScenarioChain.checkpoint awaits their finality before the app is asked to show the result.
    const mode = setupMode();
    const journal = { file: join(directory, 'transactions.jsonl'), record, activity: record, message: record };
    const transactions = options.jollity && process.env.CROSS_APP_TIMINGS_DIR
      ? new TransactionExecutor(observedSubmitter(new PapiTransactionSubmitter(people.access, { signing: PEOPLE_SIGNING }),
        transactionWriter(join(process.env.CROSS_APP_TIMINGS_DIR, '..', 'transactions.jsonl'))), journal,
        { signal, chain: 'people', clock: people.clock, mode: mode === 'fast' ? 'checkpoint' : 'finalized', validator: new SudoDispatchValidator() })
      : peopleTransactions(people, journal, mode === 'fast' ? 'checkpoint' : 'finalized');
    const root = new Sr25519KeyDerivation().derive('//Alice');
    const target = { offer: context.offer, endpoints: environment.endpoints,
      humanity: { network: { kind: 'owned' as const, session: saved } } };
    requireScenarioTarget(target);
    const chain = new ScenarioChain(people, transactions, root, target, record, mode);
    const range = context.sessionPorts;
    const app = await serveApp({ app: 'peopl', root: humanityRoot, productId: `peopl.${routes.namespace}`, routes, endpoints: environment.endpoints, signal, processes, processName: 'humanity-scenarios-source', proxies: system.appProxies,
      ports: { devServer: await system.ports.reserve(range), proxy: await system.ports.reserve(range) },
      devServer: scenarioApp,
      unsetEnvironment: Object.keys(process.env).filter(name => /MNEMONIC|SECRET|TOKEN|^HOST_|^TRUAPI_|^VITE_/.test(name)) });
    cleanups.push(() => app.stop());
    const jollity = options.jollity ? await serveApp({ app: 'dim2', root: humanityRoot, productId: `dim2.${routes.namespace}`, routes, endpoints: environment.endpoints, signal, processes,
      processName: 'cross-app-jollity-source', proxies: system.appProxies, devServer: sourceAppDeclarations().dim2,
      ports: { devServer: await system.ports.reserve(range), proxy: await system.ports.reserve(range) },
      unsetEnvironment: Object.keys(process.env).filter(name => /MNEMONIC|SECRET|TOKEN|^HOST_|^TRUAPI_|^VITE_|^NEXT_PUBLIC_/.test(name)) }) : undefined;
    if (jollity) cleanups.push(() => jollity.stop());
    const hostSystem = { processes: system.processes, commands: system.commands, ports: system.ports, locks: system.locks };
    const provider = truapiCliHost({ host: hostSelection, patches: [], stateRoot: join(directory, 'hosts'), ports: hostPortRange(range), browser, routes, system: hostSystem });
    cleanups.push(() => provider.dispose());
    const provisioner = truapiCliProvisioner({ host: hostSelection, routes, dataRoot: join(directory, 'players'), system: hostSystem });
    const actors: ActorSession[] = [];
    const bots: ReturnType<typeof gameParticipant>[] = [];
    const mediaPeers: MediaPeer[] = [];
    let actor: GameActor | undefined, sequence = 0;
    return { context, chain, hub, versionFile, evidence, cleanups, actors, bots, mediaPeers, network, crossAppLog, people, apps: { humanity: app.url, ...(jollity ? { jollity: jollity.url } : {}) },
      actor() { if (!actor) throw Error('Ada has not been created'); return actor; },
      async createMediaPeers() {
        if (!actor || !jollity) throw Error('Real media peers require Ada and the cross-app session');
        if (mediaPeers.length) throw Error('Media peers already exist for this actor');
        const identities = [];
        for (const n of [1, 2]) {
          const name = `Lab${n}`, id = `ada-${sequence}-lab-${n}`;
          const identity = await provisioner.provision({ actor: { id, name }, signal });
          identities.push({ name, id, identity, game: gameParticipant(identity.entropy, routes.namespace, name) });
        }
        const funding = await chain.fundingCalls(identities.map(peer => peer.game));
        if (funding.length) await chain.batch('Fund the real media peer game accounts', funding);
        await chain.checkpoint('real media peer funding before opening their apps');
        for (const peer of identities) {
          // Every host has its own bridge proxy. Reusing Ada's proxy would redirect her signing traffic.
          const app = await serveApp({ app: 'dim2', root: humanityRoot, productId: `dim2.${routes.namespace}`, routes,
            endpoints: environment.endpoints, signal, processes,
            processName: `${peer.id}-jollity-source`, proxies: system.appProxies!,
            devServer: sourceAppDeclarations().dim2,
            ports: { devServer: await system.ports!.reserve(range), proxy: await system.ports!.reserve(range) },
            unsetEnvironment: Object.keys(process.env).filter(name => /MNEMONIC|SECRET|TOKEN|^HOST_|^TRUAPI_|^VITE_|^NEXT_PUBLIC_/.test(name)) });
          cleanups.push(() => app.stop());
          network.forActor(peer.id);
          try {
            const session = await provider.createSession({ actor: { id: peer.id, name: peer.name, identity: peer.identity }, approvals: 'approve-all',
              app: { id: 'dim2', productId: `dim2.${routes.namespace}`, url: ({ hostBridgeUrl }) => { app.proxy.bridge(hostBridgeUrl ?? undefined); return app.url; } } });
            if ((await session.account(1)).address !== peer.game.address) throw Error('Media peer host account differs from its game account');
            let stopped = false;
            const stop = async () => { if (stopped) return; stopped = true; try { await session.stop(); } finally { await app.stop(); } };
            cleanups.push(stop);
            mediaPeers.push({ id: peer.id, name: peer.name, game: peer.game, session, page: await session.page(), stop });
          } finally { network.forActor(`ada-${sequence}`); }
        }
        bots.splice(0, bots.length, ...mediaPeers.map(peer => peer.game));
        return mediaPeers;
      },
      async create(name: string) {
        if (name !== 'Ada') throw Error('Humanity scenarios create only Ada');
        // A bundled command can contain several scenarios or outline rows. Retire the previous
        // host before provisioning the next fresh identity, so it cannot register for a later draw.
        if (actor) { for (const peer of mediaPeers) await peer.stop(); mediaPeers.length = 0; await network.snapshot(); await actor.jollity?.session.stop(); await actor.session.stop(); opened.delete(actors[0]!.id); actors.length = 0; actor = undefined; }
        versionFile?.set(false);
        const id = `ada-${++sequence}`; crossAppLog.length = 0; network.consoleHistory.clear(); network.forActor(id);
        chain.current = undefined; chain.ended = undefined; chain.next = undefined; chain.draw = undefined;
        evidence.length = 0;
        bots.splice(0, bots.length, ...[1, 2].map(n => gameParticipant(randomBytes(32), routes.namespace, `Lab${n}`)));
        const identity = await provisioner.provision({ actor: { id, name }, signal });
        const selected = await provider.resolve(), acquired = await provisioner.host();
        if (selected.sha256 !== acquired.binarySha256) throw Error('Provisioner and session selected different hosts');
        await provider.prepare();
        const session = await provider.createSession({ actor: { id, name, identity }, approvals: 'approve-all', app: {
          id: 'peopl', productId: `peopl.${routes.namespace}`, url: ({ hostBridgeUrl }) => { app.proxy.bridge(hostBridgeUrl ?? undefined); return app.url; } } });
        const game = gameParticipant(identity.entropy, routes.namespace, name);
        const keys = new Sr25519ProductAccounts(), product = keys.productAccount(identity.entropy, `peopl.${routes.namespace}`, 0);
        if ((await session.account(0)).address !== product.address) throw Error('Host payout account differs from derived product account zero');
        const view = { page: await session.page(), username: identity.liteUsername,
          async reload() { await session.open('/'); view.page = await session.page(); },
          async showCard() {
            await view.page.getByTestId('humanity-home').waitFor({ state: 'visible', timeout: 120_000 });
            const body = view.page.locator('body'); if (!body.press) throw Error('Trusted keyboard input required');
            await body.press('ControlOrMeta+d'); await view.page.locator('#debug-panel').waitFor({ state: 'visible' });
            const controls = view.page.locator('#debug-panel details:has(button:has-text("Shown"))');
            if (await controls.getAttribute('open') === null) await view.page.getByText('simulate', { exact: true }).click();
            await view.page.getByRole('button', { name: 'Shown', exact: true }).click(); await view.page.getByRole('button', { name: 'Hide', exact: true }).click();
          },
          async heads() { return Promise.all([people.access, hub].map(async access => ({ genesis: await access.genesisHash(), finalized: await access.finalizedHead() }))); },
        };
        opened.set(id, view); cleanups.push(() => opened.delete(id));
        let second: GameActor['jollity'];
        if (jollity) {
          // Jollity in Ada's second host process (one per actor and app), as in the Humanity to DIM2 flow.
          const jollitySession = await provider.createSession({ actor: { id, name, identity }, approvals: 'approve-all', app: {
            id: 'dim2', productId: `dim2.${routes.namespace}`, url: ({ hostBridgeUrl }) => { jollity.proxy.bridge(hostBridgeUrl ?? undefined); return jollity.url; } } });
          if ((await jollitySession.account(1)).address !== game.address) throw Error('Jollity account differs from the identity-derived game account');
          second = { session: jollitySession, page: await jollitySession.page() };
        }
        actor = { game, product: product.address, identityAddress: identity.evidence.identityAddress!, session, view, ...(second ? { jollity: second } : {}) };
        const value = { id, name, username: identity.liteUsername, account: game.address, appUrl: app.url }; actors.push(value);
        await view.showCard();
        return value;
      },
    };
  } catch (error) { await cleanupAll(cleanups, error); throw error; }
}
type MediaPeer = { id: string; name: string; game: ReturnType<typeof gameParticipant>; session: HostSession; page: Awaited<ReturnType<HostSession['page']>>; stop(): Promise<void> };
type GameActor = {
  game: ReturnType<typeof gameParticipant>; product: string; identityAddress: string; session: HostSession;
  view: NonNullable<ReturnType<typeof opened.get>>;
  jollity?: { session: HostSession; page: Awaited<ReturnType<HostSession['page']>> };
};
export async function humanityScenarioSessions(context: SessionContext): Promise<LabEnvironment> { return sessions(context, false); }
/** The cross-app lab: Humanity and Jollity, both built from this checkout, for one Ada. */
export async function crossAppSessions(context: SessionContext): Promise<LabEnvironment> { return sessions(context, true); }
async function sessions(context: SessionContext, jollity: boolean): Promise<LabEnvironment> {
  const state = globalState[stateKey] = await start(context, { jollity }); let closed = false;
  return { name: jollity ? 'Cross-app C, Humanity and Jollity' : 'Humanity scenarios A', provider: 'truapi-cli',
    provenance: { app: jollity ? 'workspace Humanity and Jollity' : 'workspace Humanity only', actors: 'fresh this run' },
    actors: () => state.actors, scenarios: [], createActor: options => state.create(options?.name ?? ''),
    frames: () => new PageFrameCapture({ pages: id => state.mediaPeers.find(peer => peer.id === id)?.page ?? opened.get(id)?.page }),
    hostSessions: async () => state.actors.length ? [state.actor().session, ...(state.actor().jollity ? [state.actor().jollity!.session] : []), ...state.mediaPeers.map(peer => peer.session)] : [],
    observe: async actor => jsonEvidence({ name: actor.name, view: await readWatchedText(state.actor().view.page, () => document.body.innerText), chain: state.evidence }),
    async openApp({ actorId, app, path }) {
      if (jollity && actorId === state.actors[0]?.id && app === 'dim2' && path === '/' && state.actor().jollity) {
        await state.actor().jollity!.session.open!(path); state.actor().jollity!.page = await state.actor().jollity!.session.page(); return { app, path };
      }
      if (actorId !== state.actors[0]?.id || app !== 'peopl' || !['/', '/scratch', '/claim-username'].includes(path)) throw Error('Humanity-only scenario navigation');
      await state.actor().session.open!(path); state.actor().view.page = await state.actor().session.page(); return { app, path };
    },
    async close() { if (closed) return; closed = true; try { await cleanupAll(state.cleanups); } finally { if (globalState[stateKey] === state) delete globalState[stateKey]; } },
  };
}
