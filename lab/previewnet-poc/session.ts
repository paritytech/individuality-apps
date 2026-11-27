// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The people of the Previewnet labs, each app in a host process of the person's own, built from this checkout for
// Previewnet. The same session serves a local copy of Previewnet and live Previewnet, and differs in two places
// only: who a person is (new, or named in the config) and whether the lab may change the chain (`local`). It funds
// nobody on either.
//
//  - The sign-up lab has one person, Ada, in Humanity and in Jollity.
//  - The play lab has up to three, in Jollity only: a game needs people who can see each other.
//  - The Paseo lab has one named person in Jollity, on live Paseo Next V2: she joins a game real people play.
//
// What is Chromium's stays here (the fake camera, the script that keeps the console, the dev servers), so that the
// steps ask for no more than a page and can later run where the page is a phone's.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActorSession, HostSession, LabEnvironment, SessionContext } from '@parity/product-lab';
import type { HostNetworkRoutes } from '@parity/product-lab/domain';
import type { Browser } from '@parity/product-lab/ports/browser';
import { preOnboardedIdentity, serveApp } from '@parity/product-lab/composition';
import { PageFrameCapture } from '@parity/product-lab/browser-playwright';
import { truapiCliHost, truapiCliProvisioner } from '@parity/product-lab/host-truapi-cli';
import { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import { hostSelection } from '../../apps/humanity-app/lab/opening/session.ts';
import { digest, dim2DevServer } from '../../apps/jollity-app/lab/opening/app.ts';
import { reachHome } from '../../apps/jollity-app/lab/opening/gate.ts';
import { peoplTestnetProductConfig } from '../../apps/jollity-app/lab/opening/session.ts';
import { cleanupAll, opened, requireLoopback } from '../shared/host.ts';
import { hostPortRange } from '../shared/host-ports.ts';
import { gameParticipant } from '../shared/chain-plan.ts';
import { jsonEvidence } from '../shared/observations.ts';
import { humanityRoot, repositoryRoot } from '../shared/paths.ts';
import { scenarioApp } from '../shared/scenario-app.ts';

const stateKey = Symbol.for('individuality-apps.previewnet-poc');
const registry = globalThis as typeof globalThis & { [stateKey]?: Awaited<ReturnType<typeof start>> };
export function poc() { const state = registry[stateKey]; if (!state) throw Error('No Previewnet PoC session'); return state; }
/** The lab's own session, when this run has one: a run on product-lab's default session (a phone) has none. */
export function ownSession() { return registry[stateKey]; }

/** Where a page keeps its last console lines, for a step to read back. Session storage survives a reload of the tab. */
export const CONSOLE_KEY = '__previewnetPocConsole';
/** Every console line of the page since it opened, and every entry of Jollity's debug log, held in the page until the
 *  lab collects them (play-steps.ts writes them to a file every few seconds). The tail in sessionStorage is too short
 *  for a game: connections are made in its first minute and the tail holds the last one (22 November 2026). */
export const CONSOLE_ALL = '__previewnetPocConsoleAll';
const keepConsole = `(() => {
const all = window['${CONSOLE_ALL}'] = window['${CONSOLE_ALL}'] || [];
const put = (line) => { if (all.length < 60000) all.push(line.slice(0, 4000)); };
const keep = (level, args) => { try {
  const text = new Date().toISOString() + ' ' + level + ' ' + args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ');
  put(text);
  const lines = JSON.parse(sessionStorage.getItem('${CONSOLE_KEY}') || '[]');
  lines.push(text.slice(0, 500));
  sessionStorage.setItem('${CONSOLE_KEY}', JSON.stringify(lines.slice(-400)));
} catch {} };
// Jollity's debug log keeps 250 entries and shows them in its debug sheet only. It offers sinks: the lab adds one, found
// through the dev build's module table, so that the whole log leaves the page without opening the sheet during a game.
let tries = 0;
const hook = () => { try {
  const chunks = window.webpackChunk_N_E; if (!chunks) return false;
  let load; chunks.push([['previewnet-poc-' + tries], {}, (r) => { load = r; }]);
  if (!load || !load.c) return false;
  for (const id of Object.keys(load.c)) {
    if (!/lib\\/debug\\/log-store/.test(id)) continue;
    const add = load.c[id] && load.c[id].exports && load.c[id].exports.addDevLogSink;
    if (typeof add !== 'function') continue;
    add((entry) => { let data; try { data = entry.dataText(); } catch {} put(new Date(entry.time).toISOString() + ' devlog ' + entry.level + ' [' + entry.tag + '] ' + entry.message + (data ? ' ' + data : '')); });
    put(new Date().toISOString() + ' devlog info [lab] debug log sink installed');
    return true;
  }
} catch {} return false; };
const timer = setInterval(() => { if (hook() || ++tries > 1200) clearInterval(timer); }, 500);
for (const level of ['info', 'warn', 'error', 'log']) { const was = console[level].bind(console); console[level] = (...args) => { keep(level, args); was(...args); }; }
addEventListener('error', event => keep('uncaught', [String(event.message), String(event.filename || '') + ':' + event.lineno]));
addEventListener('unhandledrejection', event => keep('unhandled', [String(event.reason && event.reason.stack || event.reason)])); })();`;

/**
 * Watches every RTCPeerConnection of the page, and with `force` makes it relay only (PREVIEWNET_POC_RELAY=policy;
 * =observe watches without forcing). What it says goes to the console, and so to the run's console file: the relay
 * addresses the page was given (never a credential), each candidate's type, and the browser's error for a server
 * that gave none. Without those a relay-only game that gathers nothing says nothing about why (22 November 2026).
 */
const watchConnections = (force: boolean) => `;(() => { const Real = window.RTCPeerConnection; if (!Real) return;
const said = (config) => JSON.stringify(((config && config.iceServers) || []).map(server => ({ urls: server.urls, username: server.username ? 'given' : 'none', credential: server.credential ? 'given' : 'none' }))) + ' policy ' + ((config && config.iceTransportPolicy) || 'all');
// The members are read by name: product-lab's bridge hands a page's connections a configuration whose members are
// not its own enumerable properties, so a spread copies none of them (22 November 2026: a relay-only game with no
// server at all, and so no candidate).
const members = ['iceServers', 'bundlePolicy', 'rtcpMuxPolicy', 'certificates', 'iceCandidatePoolSize', 'peerIdentity', 'sdpSemantics', 'encodedInsertableStreams'];
const forced = (config) => { ${force ? "const made = {}; for (const member of members) if (config && config[member] !== undefined) made[member] = config[member]; made.iceTransportPolicy = 'relay'; return made;" : 'return config;'} };
let count = 0;
const Watched = function (config, ...rest) {
  const made = forced(config), pc = new Real(made, ...rest), id = ++count;
  try {
    console.log('[lab-rtc] connection ' + id + ' made with ' + said(made));
    // What exactly was handed over, when the list above is empty although the page counted servers a line earlier.
    const given = config && config.iceServers;
    console.log('[lab-rtc] connection ' + id + ' was given ' + arguments.length + ' argument(s): ' + (config === null ? 'null' : typeof config) + ' with keys ' + JSON.stringify(config ? Object.keys(config) : [])
      + ', iceServers ' + (Array.isArray(given) ? 'an array of ' + given.length : typeof given) + ', as ' + (new.target ? 'a constructor' : 'a function') + '; called from ' + String(new Error().stack).split('\\n').slice(2, 6).map(line => line.trim().slice(0, 140)).join(' | '));
    pc.addEventListener('icecandidate', event => { const c = event.candidate; console.log('[lab-rtc] connection ' + id + (c ? ' candidate ' + c.type + '/' + c.protocol + (c.relayProtocol ? ' relayed over ' + c.relayProtocol : '') : ' end of candidates')); });
    pc.addEventListener('icecandidateerror', event => console.log('[lab-rtc] connection ' + id + ' candidate error ' + event.errorCode + ' ' + JSON.stringify(event.errorText) + ' from ' + event.url));
    pc.addEventListener('icegatheringstatechange', () => console.log('[lab-rtc] connection ' + id + ' gathering ' + pc.iceGatheringState));
    const set = pc.setConfiguration.bind(pc);
    pc.setConfiguration = (next) => { const to = forced(next); console.log('[lab-rtc] connection ' + id + ' reconfigured with ' + said(to)); return set(to); };
  } catch (error) { console.log('[lab-rtc] connection ' + id + ' could not be watched: ' + error); }
  return pc;
};
Watched.prototype = Real.prototype; Object.setPrototypeOf(Watched, Real);
window.RTCPeerConnection = Watched; if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Watched;
console.log('[lab-rtc] ${force ? 'every RTCPeerConnection of this page is relay only' : 'watching every RTCPeerConnection of this page'}'); })();`;

const jollityRoot = join(repositoryRoot, 'apps/jollity-app');
/** The grant `peopl.paseo` is meant to publish for Jollity, as `peopl.testnet.product-config.json` is Previewnet's. */
const peoplPaseoProductConfig = fileURLToPath(new URL('./peopl.paseo.product-config.json', import.meta.url));
const secretNames = /MNEMONIC|SECRET|TOKEN|^HOST_|^TRUAPI_|^VITE_|^NEXT_PUBLIC_|^NEXT_DIST_DIR$|^NEXT_TSCONFIG$/;
const withoutSecrets = () => Object.keys(process.env).filter(name => secretNames.test(name));

/** Jollity's own dev server, built for Previewnet: the host serves the chains, so the build names the network only. */
function jollitySource(runDir: string, namespace: string, network: 'previewnet' | 'paseo', turnIssuer?: string) {
  const next = join(repositoryRoot, 'node_modules/next/dist/bin/next');
  if (!existsSync(next)) throw Error('Missing hoisted Next binary; run npm ci at the repository root');
  const generated = `.next-host-productlab-${digest(runDir).slice(0, 16)}`;
  const env = { NEXT_PUBLIC_NETWORK_NAME: network, NEXT_PUBLIC_PRODUCT_DOTNS: `dim2.${namespace}`, NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX: '1',
    // A copy has its own identity backend, which issues its TURN credentials; live Previewnet's is in Jollity's table.
    ...(turnIssuer ? { NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: turnIssuer } : {}),
    NEXT_DIST_DIR: generated, NEXT_TSCONFIG: `${generated}.tsconfig.json`, NEXT_TELEMETRY_DISABLED: '1' };
  const config = join(jollityRoot, env.NEXT_TSCONFIG);
  writeFileSync(config, JSON.stringify({ extends: './tsconfig.json',
    include: ['next-env.d.ts', 'app/**/*.ts', 'app/**/*.tsx', 'lib/**/*.ts', 'lib/**/*.tsx', 'components/**/*.tsx', `${generated}/types/**/*.ts`, `${generated}/dev/types/**/*.ts`],
    exclude: ['node_modules', 'scripts', 'lab', 'tests/lab'] }, null, 2) + '\n', { flag: 'wx' });
  // product-lab's proxy holds what a development server sends its pages on the update socket while a step runs, so
  // that a rebuild cannot reload a page under a step. Next's own client waits on that socket for "built" whenever a
  // move inside the app needs a page compiled: with the socket held, the move into /game never finished and the
  // home screen stood until game time (20 November 2026). Naming another socket to hold leaves Next's alone.
  // Still needed on product-lab 0.6.0, whose fix for paritytech/product-lab#176 does not reach this move: without it
  // both players of a live Previewnet game stayed on the waiting room past the start (23 November 2026).
  const declaration = { ...dim2DevServer(next, env), updates: { hold: '/__previewnet-poc-holds-nothing' } };
  return { declaration, cleanup() { rmSync(join(jollityRoot, generated), { recursive: true, force: true }); rmSync(config, { force: true }); } };
}

/** Humanity's dev server for Previewnet, with the genesis hashes of the network this run is on. */
function humanitySource(routes: HostNetworkRoutes) {
  const people = routes.chains.people?.genesis, hub = routes.chains['asset-hub']?.genesis;
  return { ...scenarioApp, env: { ...scenarioApp.env, VITE_NETWORK: 'previewnet',
    ...(people ? { VITE_PEOPLE_GENESIS_HASH: people } : {}), ...(hub ? { VITE_ASSET_HUB_GENESIS_HASH: hub } : {}) } };
}

/** Each lab: whom it may create, the network it runs on (as the routes name it, and as Jollity's build does), whether
 *  its people have Humanity too, and the start of the names its people's variables carry. */
const LABS = {
  'sign-up': { people: ['Ada'], network: 'previewnet', build: 'previewnet', humanity: true, variables: 'PREVIEWNET_POC' },
  play: { people: ['Ada', 'Bob', 'Carol'], network: 'previewnet', build: 'previewnet', humanity: false, variables: 'PREVIEWNET_POC' },
  'paseo-play': { people: ['Ada'], network: 'paseo-next-v2', build: 'paseo', humanity: false, variables: 'PASEO_PLAY' },
} as const;
const PEOPLE = { 'sign-up': LABS['sign-up'].people, play: LABS.play.people, 'paseo-play': LABS['paseo-play'].people } as const;

async function start(context: SessionContext, lab: keyof typeof LABS) {
  const made = LABS[lab];
  const { environment, system, signal } = context, routes = environment.routes;
  // The lab may change a chain it started itself, and nothing else.
  const local = context.offer.local === true && !context.offer.public;
  if (!routes) throw Error('The Previewnet PoC needs the routes of its network');
  if (local) requireLoopback(routes);
  if (routes.network !== made.network) throw Error(`This lab runs on ${made.network}, not ${routes.network}`);
  if (!system.processes || !system.commands || !system.ports || !system.locks || !system.appProxies || !context.browsers || !context.sessionPorts) throw Error('Missing system adapters');
  const namespace = routes.namespace;
  const parent = join(repositoryRoot, '.product-lab', 'previewnet-poc'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'run-'));
  const cleanups: Array<() => unknown | Promise<unknown>> = [];
  const evidence: unknown[] = [];
  try {
    const processes = system.processes.open(join(directory, 'processes')); cleanups.push(() => processes.close(), () => processes.stopAll());
    // Chromium's synthetic camera and microphone, granted without a prompt. Without mDNS-hidden addresses two pages on
    // this machine offer each other their real interfaces, so they connect with no relay.
    // PREVIEWNET_POC_RELAY forces the relay path, which two pages on one machine never take by themselves:
    //   udp-blocked  Chromium sends no UDP of its own, as on a network that lets only TCP out. Jollity's own probe
    //                then finds no public address and a relay that answers over TCP, and goes relay only by itself.
    //   policy       every RTCPeerConnection of the page is made with iceTransportPolicy "relay", whatever Jollity asks.
    //   observe      nothing is forced; the page's connections are only watched (their servers, candidates and errors).
    const relay = process.env.PREVIEWNET_POC_RELAY ?? '';
    if (relay && !['udp-blocked', 'policy', 'observe'].includes(relay)) throw Error(`PREVIEWNET_POC_RELAY is ${JSON.stringify(relay)}: use udp-blocked, policy or observe`);
    const launched = await context.browsers.launch({ headless: true, holdWorkers: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns',
        ...(relay === 'udp-blocked' ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : [])] });
    const pageScript = relay === 'policy' || relay === 'observe' ? keepConsole + watchConnections(relay === 'policy') : keepConsole;
    cleanups.push(() => launched.close());
    // Every page keeps its own console lines (see CONSOLE_KEY): why a sign-up waits is said there and nowhere on screen.
    const browser: Browser = {
      async newContext(options) { const made = await launched.newContext(options); await made.addInitScript({ content: pageScript }); return made; },
      async newPage(options) { const made = await launched.newContext(options); await made.addInitScript({ content: pageScript }); return made.newPage(); },
      close: () => launched.close(),
    };
    // The lab only reads through these: on a live network they are its public endpoints, named as such.
    const reading = local ? undefined : { publicEndpoint: { reason: 'The Previewnet PoC reads the live network it runs on' } };
    const people = PapiChainAccess.connect(routes.chains.people!.ws, reading), hub = PapiChainAccess.connect(routes.chains['asset-hub']!.ws, reading);
    cleanups.push(() => people.close(), () => hub.close());
    const range = context.sessionPorts;
    const reserve = async () => ({ devServer: await system.ports!.reserve(range), proxy: await system.ports!.reserve(range) });
    const proxies = system.appProxies;
    const humanity = made.humanity ? await serveApp({ app: 'peopl', root: humanityRoot, productId: `peopl.${namespace}`, routes, endpoints: environment.endpoints, signal, processes,
      processName: 'previewnet-poc-humanity', proxies: system.appProxies, ports: await reserve(), devServer: humanitySource(routes), unsetEnvironment: withoutSecrets() }) : undefined;
    if (humanity) cleanups.push(() => humanity.stop());
    const backend = local ? routes.services['identity-backend'] : undefined;
    // Every person has a Jollity server and proxy of their own: a proxy bridges to one host process.
    const serveJollity = async (tag: string) => {
      const source = jollitySource(join(directory, `jollity-${tag}`), namespace, made.build, backend ? new URL(backend).origin : undefined); cleanups.push(() => source.cleanup());
      const served = await serveApp({ app: 'dim2', root: jollityRoot, productId: `dim2.${namespace}`, routes, endpoints: environment.endpoints, signal, processes,
        processName: `previewnet-poc-jollity-${tag}`, proxies, ports: await reserve(), devServer: source.declaration, unsetEnvironment: withoutSecrets() });
      cleanups.push(() => served.stop());
      return served;
    };
    const hostSystem = { processes: system.processes, commands: system.commands, ports: system.ports, locks: system.locks };
    // Jollity's free seat needs a proof in Humanity's context, which the host gives only on the grant in Humanity's
    // manifest (`trustedProducts.dim2`). On 19 November 2026 `peopl.testnet` published no manifest record on the
    // relaunched Previewnet, and the host refused ("ring-VRF access refused because=manifest unavailable").
    //  - A copy the lab started is handed the grant Humanity publishes, as the opening lab does on Previewnet from
    //    genesis. It hides the missing record there: drop it once the network carries the record.
    //  - The live network is handed nothing, so the sign-up fails for the real reason until Humanity is deployed.
    //    PREVIEWNET_POC_SEED_LIVE_GRANT=1 opts one run in, to prove the steps after it; that run says nothing about
    //    what a real user's host is allowed to do.
    // On 20 November 2026 `peopl.paseo` did publish a manifest, without a grant to dim2 ("ring-VRF access refused
    // because=not granted entry=dim2 caller=dim2.paseo owner=peopl.paseo"): PASEO_PLAY_SEED_LIVE_GRANT=1 is the same
    // opt-in for the Paseo lab, with the same meaning.
    const seedLive = !local && process.env[`${made.variables}_SEED_LIVE_GRANT`] === '1';
    const grant = made.network === 'previewnet' ? peoplTestnetProductConfig : peoplPaseoProductConfig;
    const provider = truapiCliHost({ host: hostSelection, patches: [], stateRoot: join(directory, 'hosts'), ports: hostPortRange(range), browser, routes, system: hostSystem,
      logLevel: 'info', ...(local || seedLive ? { productConfigs: [grant] } : {}),
      ...(seedLive ? { productConfigOptIn: { reason: `Trial: peopl.${namespace} publishes no grant to dim2 on live ${made.network}; seeds the grant Humanity is meant to publish, for this run only` } } : {}) });
    cleanups.push(() => provider.dispose());
    const actors: ActorSession[] = [];
    const persons = new Map<string, Person>();
    return { context, lab, local, seedLive, routes, directory, people, hub, evidence, cleanups, actors, persons,
      /** The sudo key of a chain the lab started; never on a live network. */
      sudo() { if (!local) throw Error('The lab holds no sudo key on a live network'); return new Sr25519KeyDerivation().derive('//Alice'); },
      /** The person a step names, by the actor's id. */
      actor(id: string) { const found = persons.get(id); if (!found) throw Error(`This run has no person ${id}`); return found; },
      async create(name: string) {
        const id = `${name.toLowerCase()}-1`;
        if (!(PEOPLE[lab] as readonly string[]).includes(name) || persons.has(id)) throw Error(`This lab creates ${PEOPLE[lab].join(', ')}, each once: not ${name || 'an unnamed person'}`);
        const named = context.preOnboarded?.find(actor => actor.name === name), usernameVariable = `${made.variables}_${name.toUpperCase()}_USERNAME`;
        // Live: the existing person the config names, whom the lab never creates or funds. Elsewhere: a new person.
        // A phrase does not name its person: the username onboard.mts saved beside it does.
        const existing = named ? await preOnboardedIdentity(named, context.secrets) : undefined;
        const identity = existing ? { ...existing, liteUsername: existing.liteUsername ?? process.env[usernameVariable] ?? null }
          : await truapiCliProvisioner({ host: hostSelection, routes, dataRoot: join(directory, 'players'), system: hostSystem }).provision({ actor: { id, name }, signal });
        if (!identity.liteUsername) throw Error(`${name} has no lite username: set ${usernameVariable} beside the phrase`);
        const username = identity.liteUsername;
        await provider.prepare();
        const jollity = await serveJollity(id);
        const open = (app: 'peopl' | 'dim2', served: typeof jollity) => provider.createSession({ actor: { id, name, identity }, approvals: 'approve-all',
          app: { id: app, productId: `${app}.${namespace}`, url: ({ hostBridgeUrl }) => { served.proxy.bridge(hostBridgeUrl ?? undefined); return served.url; } } });
        const game = gameParticipant(identity.entropy, namespace, name);
        const person: Person = { id, name, username, game, existing: Boolean(named), jollityUrl: jollity.url,
          // Jollity opens in a host process of the person's own, when the scenario first goes there.
          async jollity() {
            if (person.inJollity) return person.inJollity;
            const opening = await open('dim2', jollity); cleanups.push(() => opening.stop());
            if ((await opening.account(1)).address !== game.address) throw Error('Jollity account differs from the game account derived from the identity');
            person.inJollity = { session: opening, page: await opening.page() };
            try { await reachHome(person.inJollity.page, signal); }
            catch (error) {
              // Why a page has no account from its host is said in its console and debug log, and nowhere on screen:
              // three runs failed here on 24 November 2026 with nothing kept. The whole console goes to the run's
              // folder, and its lines about the host, the account and the dev server's rebuilds into the failure: the
              // first ones, where the page asks its host for the account, and the last.
              const lines = await person.inJollity.page.evaluate((key: string) => {
                const all = (window as unknown as Record<string, unknown>)[key];
                return Array.isArray(all) ? all.slice() as string[] : [];
              }, CONSOLE_ALL).catch(() => [] as string[]);
              mkdirSync(join(directory, 'console'), { recursive: true });
              writeFileSync(join(directory, 'console', `${name}.opening.log`), lines.join('\n') + '\n', { mode: 0o600 });
              const about = lines.filter(line => /\[(source|host|engine|game-source|session)\]|Fast Refresh|\[HMR\]| (error|warn|uncaught|unhandled) /.test(line));
              const told = (about.length > 40 ? [...about.slice(0, 28), `… ${about.length - 40} more in the file …`, ...about.slice(-12)] : about).map(line => line.slice(0, 300));
              throw Error(`${error instanceof Error ? error.message : String(error)}\nThe page's console at this opening (${lines.length} lines kept, ${about.length} about the host, the account or a rebuild):\n${told.join('\n')}`, { cause: error });
            }
            return person.inJollity;
          },
        };
        persons.set(id, person);
        const actor = { id, name, username, account: game.address, appUrl: humanity?.url ?? jollity.url }; actors.push(actor);
        if (!humanity) return actor;
        const session = await open('peopl', humanity); cleanups.push(() => session.stop());
        const view = { page: await session.page(), username,
          async reload() { await session.open!('/'); view.page = await session.page(); },
          async showCard() {
            await view.page.getByTestId('humanity-home').waitFor({ state: 'visible', timeout: 120_000 });
            const body = view.page.locator('body'); if (!body.press) throw Error('Trusted keyboard input required');
            await body.press('ControlOrMeta+d'); await view.page.locator('#debug-panel').waitFor({ state: 'visible' });
            const controls = view.page.locator('#debug-panel details:has(button:has-text("Shown"))');
            if (await controls.getAttribute('open') === null) await view.page.getByText('simulate', { exact: true }).click();
            await view.page.getByRole('button', { name: 'Shown', exact: true }).click(); await view.page.getByRole('button', { name: 'Hide', exact: true }).click();
          },
          heads: async () => Promise.all([people, hub].map(async access => ({ genesis: await access.genesisHash(), finalized: await access.finalizedHead() }))),
        };
        opened.set(id, view); cleanups.push(() => opened.delete(id));
        person.inHumanity = { session, view };
        return actor;
      },
    };
  } catch (error) { await cleanupAll(cleanups, error); throw error; }
}
type InApp = { session: HostSession; page: Awaited<ReturnType<HostSession['page']>> };
/** One person of a run: who she is, her game account, and her apps as far as the scenario has opened them. */
export type Person = { id: string; name: string; username: string; game: ReturnType<typeof gameParticipant>; existing: boolean;
  /** Her own Jollity server, behind her proxy. */
  jollityUrl: string;
  /** Humanity, in the sign-up lab only. */
  inHumanity?: { session: HostSession; view: NonNullable<ReturnType<typeof opened.get>> };
  inJollity?: InApp;
  jollity(): Promise<InApp> };

export const previewnetPocSessions = (context: SessionContext) => sessions(context, 'sign-up');
export const previewnetPlaySessions = (context: SessionContext) => sessions(context, 'play');
export const paseoPlaySessions = (context: SessionContext) => sessions(context, 'paseo-play');

async function sessions(context: SessionContext, lab: keyof typeof LABS): Promise<LabEnvironment> {
  const state = registry[stateKey] = await start(context, lab); let closed = false;
  const everyone = () => [...state.persons.values()];
  return { name: lab === 'sign-up' ? 'Previewnet PoC' : lab === 'play' ? 'Previewnet play' : 'Paseo play', provider: 'truapi-cli',
    provenance: { app: lab === 'sign-up' ? 'workspace Humanity and Jollity' : 'workspace Jollity', network: state.local ? `a local copy of ${LABS[lab].network}` : `live ${LABS[lab].network}`, actors: state.local ? 'new this run' : 'named in the config',
      humanityGrant: state.local || state.seedLive ? 'handed to the host from a local file, not read from the network' : 'as the network publishes it' },
    actors: () => state.actors, scenarios: [], createActor: options => state.create(options?.name ?? ''),
    frames: () => new PageFrameCapture({ pages: id => opened.get(id)?.page ?? state.persons.get(id)?.inJollity?.page }),
    hostSessions: async () => everyone().flatMap(person => [person.inHumanity?.session, person.inJollity?.session].filter((session): session is HostSession => Boolean(session))),
    observe: async actor => jsonEvidence({ actor: actor.name, chain: state.evidence }),
    async openApp({ actorId, app, path }) {
      const person = state.actor(actorId);
      if (path !== '/' || (app !== 'peopl' && app !== 'dim2')) throw Error('The Previewnet labs open Humanity and Jollity at / only');
      if (app === 'dim2') { await person.jollity(); return { app, path }; }
      const humanity = person.inHumanity; if (!humanity) throw Error('This lab opens Jollity only');
      await humanity.session.open!(path); humanity.view.page = await humanity.session.page();
      return { app, path };
    },
    async close() { if (closed) return; closed = true; try { await cleanupAll(state.cleanups); } finally { if (registry[stateKey] === state) delete registry[stateKey]; } },
  };
}
