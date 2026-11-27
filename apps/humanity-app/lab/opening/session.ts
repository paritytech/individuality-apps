// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { opened, requireLoopback, cleanupAll } from "../../../../lab/shared/host.ts";
export { keepBundle, bundleAsset } from "../../../../lab/shared/bundle.ts";
export { opened, requireLoopback, cleanupAll } from "../../../../lab/shared/host.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActorSession, LabEnvironment, SessionContext } from "@parity/product-lab";
import { serveApp } from "@parity/product-lab/composition";
import { observeChain } from "@parity/product-lab/env-engine";
import { PageFrameCapture } from "@parity/product-lab/browser-playwright";
import { truapiCliHost, truapiCliProvisioner } from "@parity/product-lab/host-truapi-cli";

export const hostLock = fileURLToPath(new URL("./host.lock.json", import.meta.url));
export const hostSelection = { lockFile: hostLock, version: "locked", attestation: "required" as const };
/** A negative run is evidence only when the exact card assertion fails after successful setup. */
export function assertOpeningReport(report: unknown, control: boolean): void {
  type Step = { hidden?: boolean; name?: string; result?: { status?: string; error_message?: string } };
  const features = report as Array<{ elements?: Array<{ type?: string; steps?: Step[] }> }>;
  if (!Array.isArray(features)) throw new Error("Invalid opening report");
  const scenarios = features.flatMap((feature) => feature.elements ?? []).filter((element) => element.type === "scenario");
  if (scenarios.length !== 1) throw new Error("Expected exactly one opening scenario");
  const steps = scenarios[0]!.steps ?? [];
  const visible = steps.filter((step) => !step.hidden);
  if (visible.length !== (control ? 5 : 7)) throw new Error("Unexpected opening step count");
  const last = visible.at(-1)!;
  for (const step of steps) {
    if (control && step === last) continue;
    if (step.result?.status !== "passed") throw new Error("Opening setup, checks or cleanup did not pass");
  }
  if (control && (last.name !== 'Ada sees the Humanity card labelled "Member"' ||
      last.result?.status !== "failed" ||
      !last.result.error_message?.includes('Card label "Person" does not match "Member"'))) {
    throw new Error("The negative control did not fail at the exact wrong-card assertion");
  }
}
export async function openingSessions(context: SessionContext): Promise<LabEnvironment> {
  const { environment, system, signal } = context;
  const routes = environment.routes;
  if (!routes) throw new Error("The local fork supplied no host routes");
  requireLoopback(routes);
  if (!system.processes || !system.commands || !system.ports || !system.locks || !system.appProxies || !system.rpc || !context.browsers) {
    throw new Error("The opening needs process, browser, proxy, RPC and port adapters");
  }
  const hostSystem = { processes: system.processes, commands: system.commands, ports: system.ports, locks: system.locks };
  const parent = join(context.root, ".product-lab", "opening");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, "run-"));
  const close: Array<() => unknown | Promise<unknown>> = [() => rmSync(directory, { recursive: true, force: true })];
  const actors: ActorSession[] = [];
  try {
    const processes = system.processes.open(join(directory, "processes"));
    close.push(() => processes.close(), () => processes.stopAll());
    const browser = await context.browsers.launch({ headless: true });
    close.push(() => browser.close());
    const range = context.sessionPorts;
    if (!range) throw new Error("The opening needs an allocated session port range");
    const app = await serveApp({
      app: "peopl", root: context.root, productId: `peopl.${routes.namespace}`, routes,
      endpoints: environment.endpoints, signal, processes, processName: "humanity-source", proxies: system.appProxies,
      ports: { devServer: await system.ports.reserve(range), proxy: await system.ports.reserve(range) },
      devServer: {
        command: "npm", cwd: "../..",
        args: ["run", "dev", "--workspace", "@humanity/app", "--", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
        env: { VITE_NETWORK: "paseo-next-v2", VITE_DOTNS_PRODUCT_LABEL: "peopl", VITE_HOST_BRIDGE_URL: "off", VITE_SENTRY_DSN: "" },
        settings: { endpoints: { people: "VITE_PEOPLE_WS_URL" } }, updates: "vite",
      },
      unsetEnvironment: Object.keys(process.env).filter((name) => /MNEMONIC|SECRET|TOKEN|^HOST_|^TRUAPI_|^VITE_/.test(name)),
    });
    close.push(() => app.stop());
    const provider = truapiCliHost({ host: hostSelection, patches: [], stateRoot: join(directory, "host"), ports: { from: range.from, to: range.to }, browser, routes, system: hostSystem });
    close.push(() => provider.dispose());
    const provisioner = truapiCliProvisioner({ host: hostSelection, routes, dataRoot: join(directory, "players"), system: hostSystem });
    const rpc = system.rpc;
    const heads = () => Promise.all(["people", "asset-hub"].map(async (chain) => ({
      chain, ...await observeChain(rpc, routes.chains[chain]!.ws, { timeoutMs: 120_000, pollMs: 1000 }, true),
    })));
    let closed = false;
    return {
      name: "Humanity source opening", provider: "truapi-cli",
      provenance: { source: "workspace @humanity/app", hostLock: "lab/opening/host.lock.json", players: "created in this run" },
      actors: () => actors, scenarios: [],
      frames: () => new PageFrameCapture({ pages: (id) => opened.get(id)?.page }),
      observe: async (actor) => ({ actor: actor.name, username: actor.username }),
      async openApp({ actorId, app: appId, path }) {
        if (appId !== "peopl" || path !== "/") throw new Error("The opening only navigates to Humanity's home");
        const state = opened.get(actorId);
        if (!state) throw new Error("No owned Humanity host session");
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
          app: { id: "peopl", productId: `peopl.${routes.namespace}`, url: ({ hostBridgeUrl }) => {
            app.proxy.bridge(hostBridgeUrl ?? undefined);
            return app.url;
          } },
        });
        const page = await session.page();
        const account = await session.account();
        const actor = { id: "ada", name: "Ada", username: identity.liteUsername, account: account.address, appUrl: app.url };
        actors.push(actor);
        const view = { page, username: identity.liteUsername, async showCard() {
          // Current source defaults to a native Pocket card. The CLI host has no Pocket.
          // Use the existing presentation control; never select a simulated card scenario.
          await view.page.getByTestId("humanity-home").waitFor({ state: "visible", timeout: 120_000 });
          const body = view.page.locator("body");
          if (!body.press) throw new Error("The opening needs trusted keyboard input for the existing card control");
          await body.press("ControlOrMeta+d");
          await view.page.locator("#debug-panel").waitFor({ state: "visible" });
          const controls = view.page.locator('#debug-panel details:has(button:has-text("Shown"))');
          if (await controls.getAttribute("open") === null) await view.page.getByText("simulate", { exact: true }).click();
          await view.page.getByRole("button", { name: "Shown", exact: true }).click();
          await view.page.getByRole("button", { name: "Hide", exact: true }).click();
        }, async reload() {
          await session.open("/");
          view.page = await session.page();
        }, heads };
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
