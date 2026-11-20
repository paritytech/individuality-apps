// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { requireLoopback, cleanupAll } from "../../../../lab/shared/host.ts";
export { requireLoopback, cleanupAll } from "../../../../lab/shared/host.ts";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActorSession, LabEnvironment, SessionContext } from "@parity/product-lab";
import type { BrowserPage } from "@parity/product-lab/ports/browser";
import type { HostNetworkRoutes } from "@parity/product-lab/domain";
import { dim2SourceServer, isPreviewnetRoute } from "./app.ts";
import { prepareClaimableCollection } from "./collection.ts";
import { prepareGame } from "./fixture.ts";
import { readLiteProof } from "./proof.ts";
import { reachHome } from "./gate.ts";
import { serveApp } from "@parity/product-lab/composition";
import { observeChain } from "@parity/product-lab/env-engine";
import { PageFrameCapture } from "@parity/product-lab/browser-playwright";
import { truapiCliHost, truapiCliProvisioner } from "@parity/product-lab/host-truapi-cli";

export const hostLock = fileURLToPath(new URL("./host.lock.json", import.meta.url));
export const hostSelection = { lockFile: hostLock, version: "locked", attestation: "required" as const };
/** Humanity's grant to DIM2, as its root manifest publishes it (apps/humanity-app/deploy/bulletin-deploy.config.ts). */
export const peoplTestnetProductConfig = fileURLToPath(new URL("./peopl.testnet.product-config.json", import.meta.url));
/**
 * What the CLI host gets on Previewnet from genesis only. A genesis DotNS has no `peopl.testnet` record, so the host
 * would refuse DIM2's lite proof with a key peopl owns (NotAllowlisted). The product config seeds the grant Humanity
 * publishes, through the host's `--product-config`. Never on the Paseo copy: there the forked chain carries the real
 * `peopl.paseo` record, and a seeded entry would hide it. `info` makes the host log the grants it loaded and used.
 */
export function hostGenesisOptions(routes: Pick<HostNetworkRoutes, "network" | "namespace">): { productConfigs?: string[]; logLevel?: "info" } {
  return isPreviewnetRoute(routes) ? { productConfigs: [peoplTestnetProductConfig], logLevel: "info" } : {};
}
/**
 * Copy the host's session logs out of the run directory before it is removed (local evidence; CI never sets it).
 * Optional evidence never fails a run: a copy that cannot be made is a warning naming only the error's code, since
 * fs messages carry local paths into run logs and reports.
 */
export function keepHostLogs(directory: string, into: string | undefined) {
  const logs = join(directory, "host", "processes");
  if (!into || !existsSync(logs)) return;
  try {
    mkdirSync(into, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(logs).filter((file) => file.endsWith(".log"))) copyFileSync(join(logs, name), join(into, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    console.warn(`Host logs not kept (${typeof code === "string" ? code : "copy failed"})`);
  }
}
/** A negative run is evidence only when the exact card assertion fails after successful setup. */
export function assertOpeningReport(report: unknown, control: boolean): void {
  type Step = { hidden?: boolean; name?: string; result?: { status?: string; error_message?: string } };
  const features = report as Array<{ elements?: Array<{ type?: string; steps?: Step[] }> }>;
  if (!Array.isArray(features)) throw new Error("Invalid opening report");
  const scenarios = features.flatMap((feature) => feature.elements ?? []).filter((element) => element.type === "scenario");
  if (scenarios.length !== 1) throw new Error("Expected exactly one opening scenario");
  const steps = scenarios[0]!.steps ?? [];
  const visible = steps.filter((step) => !step.hidden);
  if (visible.length !== (control ? 5 : 8)) throw new Error("Unexpected opening step count");
  const last = visible.at(-1)!;
  for (const step of steps) {
    if (control && step === last) continue;
    if (step.result?.status !== "passed") throw new Error("Opening setup, checks or cleanup did not pass");
  }
  if (control && (last.name !== 'Ada sees DIM2 registered as "true"' ||
      last.result?.status !== "failed" ||
      !last.result.error_message?.includes('DIM2 registered "false" does not match "true"'))) {
    throw new Error("The negative control did not fail at the exact wrong-card assertion");
  }
}
type OpeningSession = {
  page: BrowserPage;
  username: string;
  account: string;
  proof(): Promise<unknown>;
  reload(): Promise<void>;
  heads(): Promise<unknown>;
};
// The root config is loaded through CommonJS, while custom steps use ESM.
// Both module instances must reach the same owned sessions; close removes each entry.
const openedKey = Symbol.for("jollity-app.dim2-opening.owned-sessions");
const registry = globalThis as typeof globalThis & { [openedKey]?: Map<string, OpeningSession> };
export const opened = registry[openedKey] ??= new Map<string, OpeningSession>();

export async function openingSessions(context: SessionContext): Promise<LabEnvironment> {
  const { environment, system, signal } = context;
  const routes = environment.routes;
  if (!routes) throw new Error("The local network supplied no host routes");
  requireLoopback(routes);
  if (!system.processes || !system.commands || !system.ports || !system.locks || !system.appProxies || !system.rpc || !context.browsers) {
    throw new Error("The opening needs process, browser, proxy, RPC and port adapters");
  }
  const hostSystem = { processes: system.processes, commands: system.commands, ports: system.ports, locks: system.locks };
  const parent = join(context.root, ".product-lab", "opening");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, "run-"));
  // Run in reverse: the host's logs are copied after it stops and before the run directory goes.
  const close: Array<() => unknown | Promise<unknown>> = [() => rmSync(directory, { recursive: true, force: true }),
    () => keepHostLogs(directory, process.env.JOLLITY_LAB_HOST_LOG_DIR)];
  const actors: ActorSession[] = [];
  try {
    const processes = system.processes.open(join(directory, "processes"));
    close.push(() => processes.close(), () => processes.stopAll());
    const browser = await context.browsers.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    close.push(() => browser.close());
    const range = context.sessionPorts;
    if (!range) throw new Error("The opening needs an allocated session port range");
    // Previewnet from genesis has no Scarcity collection: make the one DIM2 is approved to read before its build.
    const collections = isPreviewnetRoute(routes) ? await prepareClaimableCollection(context) : [];
    const source = dim2SourceServer(context.root, directory, routes, collections);
    close.push(() => source.cleanup());
    await prepareGame(context);
    const app = await serveApp({
      app: "dim2", root: context.root, productId: `dim2.${routes.namespace}`, routes,
      endpoints: environment.endpoints, signal, processes, processName: "dim2-source", proxies: system.appProxies,
      ports: { devServer: await system.ports.reserve(range), proxy: await system.ports.reserve(range) },
      devServer: source.declaration,
      unsetEnvironment: Object.keys(process.env).filter((name) => /MNEMONIC|SECRET|TOKEN|^HOST_|^TRUAPI_|^NEXT_PUBLIC_|^NEXT_DIST_DIR$|^NEXT_TSCONFIG$/.test(name)),
    });
    close.push(() => app.stop());
    // Compile the permission route before the app's ordinary first-open redirect.
    for (const path of ["/", "/permissions"]) {
      const answer = await fetch(new URL(path, app.devServerUrl), { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
      await answer.body?.cancel();
      if (answer.status >= 500) throw new Error(`DIM2 could not compile ${path} (${answer.status})`);
    }
    const provider = truapiCliHost({ host: hostSelection, patches: [], stateRoot: join(directory, "host"), ports: { from: range.from, to: range.to }, browser, routes, system: hostSystem, ...hostGenesisOptions(routes) });
    close.push(() => provider.dispose());
    const provisioner = truapiCliProvisioner({ host: hostSelection, routes, dataRoot: join(directory, "players"), system: hostSystem });
    const rpc = system.rpc;
    const heads = () => Promise.all(["people", "asset-hub"].map(async (chain) => ({
      chain, ...await observeChain(rpc, routes.chains[chain]!.ws, { timeoutMs: 120_000, pollMs: 1000 }, true),
    })));
    let closed = false;
    return {
      name: "DIM2 source opening", provider: "truapi-cli",
      provenance: { ...source.source, source: "workspace @jollity/app", hostLock: "lab/opening/host.lock.json", players: "created in this run" },
      actors: () => actors, scenarios: [],
      frames: () => new PageFrameCapture({ pages: (id) => opened.get(id)?.page }),
      observe: async (actor) => ({ actor: actor.name, username: actor.username }),
      async openApp({ actorId, app: appId, path }) {
        if (appId !== "dim2" || path !== "/") throw new Error("The opening only navigates to DIM2's home");
        const state = opened.get(actorId);
        if (!state) throw new Error("No owned DIM2 host session");
        await state.reload();
        return { app: appId, path };
      },
      async createActor(options) {
        if (actors.length || options?.name !== "Ada") throw new Error("This opening creates only Ada, once");
        const identity = await provisioner.provision({ actor: { id: "ada", name: "Ada" }, signal: options?.signal ?? signal });
        const acquired = await provisioner.host();
        const selected = await provider.resolve();
        if (selected.sha256 !== acquired.binarySha256) throw new Error("Provisioning and launch selected different host binaries");
        await provider.prepare();
        const session = await provider.createSession({
          actor: { id: "ada", name: "Ada", identity }, approvals: "approve-all",
          app: { id: "dim2", productId: `dim2.${routes.namespace}`, url: ({ hostBridgeUrl }) => {
            app.proxy.bridge(hostBridgeUrl ?? undefined);
            return app.url;
          } },
        });
        const page = await session.page();
        const account = await session.account(1, { source: "host" });
        const actor = { id: "ada", name: "Ada", username: identity.liteUsername, account: account.address, appUrl: app.url };
        actors.push(actor);
        const view = { page, username: identity.liteUsername, account: account.address,
          proof: () => readLiteProof(context, session.evidence),
          async reload() {
            const before = await session.account(1, { source: "host" });
            await session.open("/");
            view.page = await session.page();
            await reachHome(view.page, signal);
            const after = await session.account(1, { source: "host" });
            if (before.publicKey !== after.publicKey || before.productId !== after.productId) throw new Error("DIM2 product account changed after reload");
          }, heads };
        await reachHome(page, signal);
        opened.set(actor.id, view);
        close.push(() => opened.delete(actor.id));
        return actor;
      },
      async close() {
        if (closed) return;
        closed = true;
        await cleanupAll(close);
      },
    };
  } catch (error) {
    await cleanupAll(close, error);
    throw error;
  }
}
