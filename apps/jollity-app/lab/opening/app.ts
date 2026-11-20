// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Adapted from the source DIM2 launcher named in IMPORTED.json.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HostNetworkRoutes } from "@parity/product-lab/domain";
import { AppDevServer, type AppDevServerDeclaration } from "@parity/product-lab/domain/apps";
import { resolveLocalNetwork } from "../../../../packages/jollity-protocol/src/local-network.mjs";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function sourceEvidence(app: string) {
  const root = resolve(app, "../..");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { cwd: root, encoding: "utf8" }).trim();
  return { kind: "source", commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
    appTree: git("rev-parse", "HEAD:apps/jollity-app"), patchSha256: digest(git("diff", "HEAD", "--binary")),
    lockSha256: digest(readFileSync(join(root, "package-lock.json"))) };
}
/** Previewnet's routes (Engine started from genesis): DIM2 is built for its `local` network there, never for Paseo. */
export const isPreviewnetRoute = (routes: Pick<HostNetworkRoutes, "network" | "namespace">) =>
  routes.network === "previewnet" && routes.namespace === "testnet";
/** The `local` network variables of a DIM2 build for an owned Previewnet network, checked by the app's own resolver. */
export function dim2LocalEnv(routes: HostNetworkRoutes, collections: readonly number[]) {
  const people = routes.chains.people, hub = routes.chains["asset-hub"], backend = routes.services["identity-backend"];
  if (!people?.genesis || !hub?.genesis) throw new Error("DIM2 on Previewnet needs the People and Asset Hub routes with their genesis hashes");
  if (!backend) throw new Error("DIM2 on Previewnet needs the local identity backend");
  if (!collections.length) throw new Error("DIM2 on Previewnet needs at least one approved Scarcity collection");
  const env = { NEXT_PUBLIC_NETWORK_NAME: "local",
    NEXT_PUBLIC_PEOPLE_WS: people.ws, NEXT_PUBLIC_PEOPLE_GENESIS: people.genesis,
    NEXT_PUBLIC_ASSET_HUB_WS: hub.ws, NEXT_PUBLIC_ASSET_HUB_GENESIS: hub.genesis,
    NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: new URL(backend).origin,
    NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: collections.join(","),
    NEXT_PUBLIC_PRODUCT_DOTNS: "dim2.testnet" };
  // The same check next.config.ts makes, before a server is started.
  resolveLocalNetwork(env);
  return env;
}
export function dim2AppEnv(routes: HostNetworkRoutes, runDir: string, collections: readonly number[] = []) {
  const generated = `.next-host-productlab-${digest(runDir).slice(0, 16)}`;
  const build = { NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX: "1", NEXT_DIST_DIR: generated, NEXT_TSCONFIG: `${generated}.tsconfig.json`, NEXT_TELEMETRY_DISABLED: "1" };
  if (isPreviewnetRoute(routes)) return { ...dim2LocalEnv(routes, collections), ...build };
  if (routes.network !== "paseo-next-v2" || routes.namespace !== "paseo") throw new Error("DIM2 opening requires a local Paseo fork or Previewnet from genesis");
  if (!routes.chains.people) throw new Error("Missing fork People route");
  return { NEXT_PUBLIC_NETWORK_NAME: "paseo", NEXT_PUBLIC_PRODUCT_DOTNS: `dim2.${routes.namespace}`, ...build };
}
/** Validate the launch contract without starting a fork, writing files or spawning a server. */
export function dim2DevServer(next: string, env: Record<string, string>): AppDevServerDeclaration {
  const declaration: AppDevServerDeclaration = { command: "node",
    args: [next, "dev", "--webpack", "--port", "{port}", "--hostname", "127.0.0.1"], env,
    updates: "next-webpack-app-router", startTimeoutMs: 180_000 };
  AppDevServer.parse("dim2", declaration);
  return declaration;
}
/** Own the server, output directory and generated config; never attach to an existing developer server. */
export function dim2SourceServer(app: string, runDir: string, routes: HostNetworkRoutes, collections: readonly number[] = []) {
  const next = join(resolve(app, "../.."), "node_modules/next/dist/bin/next");
  if (!existsSync(next)) throw new Error("Missing hoisted Next binary; run npm ci at the repository root");
  const env = dim2AppEnv(routes, runDir, collections);
  const declaration = dim2DevServer(next, env);
  const config = join(app, env.NEXT_TSCONFIG);
  writeFileSync(config, JSON.stringify({ extends: "./tsconfig.json",
    include: ["next-env.d.ts", "app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "lib/**/*.tsx", "components/**/*.tsx", `${env.NEXT_DIST_DIR}/types/**/*.ts`, `${env.NEXT_DIST_DIR}/dev/types/**/*.ts`],
    exclude: ["node_modules", "scripts", "lab", "tests/lab"] }, null, 2) + "\n", { flag: "wx" });
  return { declaration, source: sourceEvidence(app), cleanup() {
    rmSync(join(app, env.NEXT_DIST_DIR), { recursive: true, force: true });
    rmSync(config, { force: true });
  } };
}
