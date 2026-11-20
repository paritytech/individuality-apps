// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The opening on Previewnet from genesis: DIM2's `local` build, the owned-network guards and the collection setup.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { productConfigArgs, readProductConfigs } from "@parity/product-lab/host-truapi-cli";
import { SystemClock } from "@parity/product-lab/system-node";
import { DispatchFailedError } from "@parity/product-lab/chain";
import type { Receipt, SubmitRequest } from "@parity/product-lab/ports/chain";
import { HostNetworkRoutes } from "@parity/product-lab/domain";
import { dim2AppEnv, dim2LocalEnv, isPreviewnetRoute } from "../../lab/opening/app.ts";
import { assertClaimable, claimableCollectionCalls, submitCollectionCalls } from "../../lab/opening/collection.ts";
import { OPENING_ENVIRONMENTS, assertSudoKey, openingEnvironment, requireOwnedFork, requireOwnedGenesis, sudoCall, type SudoApi } from "../../lab/opening/fixture.ts";
import labConfig from "../../lab.opening.config.ts";
import { hostGenesisOptions, keepHostLogs, peoplTestnetProductConfig } from "../../lab/opening/session.ts";

const people = `0x${"11".repeat(32)}`, hub = `0x${"22".repeat(32)}`, bulletin = `0x${"33".repeat(32)}`;
const previewnet = (genesis = true) => HostNetworkRoutes.from({ network: "previewnet", namespace: "testnet",
  chains: { people: { ws: "ws://127.0.0.1:10010", ...(genesis ? { genesis: people } : {}) }, "asset-hub": { ws: "ws://127.0.0.1:10020", ...(genesis ? { genesis: hub } : {}) },
    bulletin: { ws: "ws://127.0.0.1:10030", ...(genesis ? { genesis: bulletin } : {}) } },
  services: { "identity-backend": "http://127.0.0.1:8092/api/v1" } });
const paseo = () => HostNetworkRoutes.from({ network: "paseo-next-v2", namespace: "paseo",
  chains: { people: { ws: "ws://127.0.0.1:20000" }, "asset-hub": { ws: "ws://127.0.0.1:20001" }, bulletin: { ws: "ws://127.0.0.1:20002" } },
  services: { "identity-backend": "http://127.0.0.1:20003" } });

describe("DIM2's build on the owned network", () => {
  it("builds for the local network on Previewnet, with the routes, the backend origin and the approved collection", () => {
    expect(isPreviewnetRoute(previewnet())).toBe(true);
    const env = dim2AppEnv(previewnet(), "run1", [0]);
    expect(env).toMatchObject({ NEXT_PUBLIC_NETWORK_NAME: "local",
      NEXT_PUBLIC_PEOPLE_WS: "ws://127.0.0.1:10010", NEXT_PUBLIC_PEOPLE_GENESIS: people,
      NEXT_PUBLIC_ASSET_HUB_WS: "ws://127.0.0.1:10020", NEXT_PUBLIC_ASSET_HUB_GENESIS: hub,
      NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: "http://127.0.0.1:8092",
      NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: "0", NEXT_PUBLIC_PRODUCT_DOTNS: "dim2.testnet",
      NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX: "1", NEXT_TELEMETRY_DISABLED: "1" });
    expect(env.NEXT_DIST_DIR).toMatch(/^\.next-host-productlab-[0-9a-f]{16}$/);
    expect(dim2LocalEnv(previewnet(), [3, 7]).NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS).toBe("3,7");
  });
  it("keeps the Paseo build on the copy, with none of the local variables", () => {
    expect(isPreviewnetRoute(paseo())).toBe(false);
    const env = dim2AppEnv(paseo(), "run1", [0]);
    expect(env).toMatchObject({ NEXT_PUBLIC_NETWORK_NAME: "paseo", NEXT_PUBLIC_PRODUCT_DOTNS: "dim2.paseo" });
    expect(Object.keys(env).filter((name) => /LOCAL|_WS$|GENESIS|BACKEND/.test(name))).toEqual([]);
  });
  // Negative controls: each missing input refuses before any server starts.
  it("refuses Previewnet without an approved collection, without genesis hashes or with a collection the app's resolver rejects", () => {
    expect(() => dim2AppEnv(previewnet(), "run1")).toThrow("approved Scarcity collection");
    expect(() => dim2AppEnv(previewnet(false), "run1", [0])).toThrow("genesis hashes");
    expect(() => dim2LocalEnv(previewnet(), [-1])).toThrow("NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS");
  });
  it("still refuses every other network", () => {
    const fake = { ...paseo(), network: "previewnet", namespace: "paseo" } as unknown as HostNetworkRoutes;
    expect(isPreviewnetRoute(fake)).toBe(false);
    expect(() => dim2AppEnv(fake, "run1", [0])).toThrow("requires a local Paseo fork or Previewnet from genesis");
  });
});

describe("the owned networks the opening may change", () => {
  const local = { local: true, chains: [] } as const;
  it("sets up the game on the Paseo copy and on Previewnet from genesis, and nowhere else", () => {
    expect(OPENING_ENVIRONMENTS).toEqual(["paseo-copy", "previewnet-genesis"]);
    for (const environmentId of OPENING_ENVIRONMENTS) expect(() => requireOwnedFork({ environmentId, offer: local })).not.toThrow();
    expect(() => requireOwnedFork({ environmentId: "previewnet-copy", offer: local })).toThrow();
    expect(() => requireOwnedFork({ environmentId: "previewnet-genesis", offer: { local: false, chains: [] } })).toThrow();
    expect(() => requireOwnedFork({ environmentId: "previewnet-genesis", offer: { ...local, public: { reason: "x" } } as never })).toThrow();
  });
  it("makes collections only on Previewnet from genesis", () => {
    expect(() => requireOwnedGenesis({ environmentId: "previewnet-genesis", offer: local })).not.toThrow();
    expect(() => requireOwnedGenesis({ environmentId: "paseo-copy", offer: local })).toThrow("Previewnet from genesis");
    expect(() => requireOwnedGenesis({ environmentId: "previewnet-genesis", offer: { local: false, chains: [] } })).toThrow();
  });
  it("declares both environments in the opening's lab, the copy still the default", () => {
    const lab = labConfig as unknown as { environments: Record<string, unknown>; defaultEnvironment: string };
    expect(Object.keys(lab.environments).sort()).toEqual(["paseo-copy", "previewnet-genesis"]);
    expect(lab.defaultEnvironment).toBe("paseo-copy");
  });
});

describe("the claimable Scarcity collection", () => {
  const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const aliceOnHub = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
  it("sends create, one transferable item and a random minter for the next id", () => {
    const calls = claimableCollectionCalls(4);
    expect(calls.map((call) => `${call.pallet}.${call.name}`)).toEqual(["Scarcity.create_collection", "Scarcity.define_item", "NftClaims.set_collection_minter"]);
    expect(calls[1]!.args).toMatchObject({ collection: 4, transferability: { type: "Transferable" }, metadata: [] });
    expect(calls[2]!.args).toMatchObject({ collection: 4, selection: { type: "Random" } });
    for (const id of [-1, 1.5, 2 ** 32]) expect(() => claimableCollectionCalls(id)).toThrow("u32");
  });
  it("accepts the finalized state step 0 read at genesis, whatever SS58 prefix the chain prints", () => {
    expect(() => assertClaimable(0, alice, { collection: { owner: aliceOnHub, item_count: 1 }, minter: { selection: { type: "Random" } } })).not.toThrow();
  });
  it.each([
    ["no collection", { collection: undefined, minter: { selection: { type: "Random" } } }, "does not exist"],
    ["another owner", { collection: { owner: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", item_count: 1 }, minter: { selection: { type: "Random" } } }, "not owned"],
    ["no item", { collection: { owner: aliceOnHub, item_count: 0 }, minter: { selection: { type: "Random" } } }, "no item"],
    ["no minter", { collection: { owner: aliceOnHub, item_count: 1 }, minter: undefined }, "minter"],
  ])("refuses %s", (_name, state, message) => {
    expect(() => assertClaimable(0, alice, state)).toThrow(message);
  });
});

describe("the wrapper's --environment", () => {
  it("defaults to the Paseo copy, which CI relies on", () => {
    for (const mode of ["check", "prepare", "run", "demo", "cleanup", undefined]) expect(openingEnvironment(mode, ["--fresh"]).environment, String(mode)).toBe("paseo-copy");
  });
  it("accepts previewnet-genesis for prepare and run, and removes the flag before the argument check", () => {
    expect(openingEnvironment("run", ["--environment", "previewnet-genesis", "--fresh"])).toEqual({ environment: "previewnet-genesis", args: ["--fresh"] });
    expect(openingEnvironment("run", ["--fresh", "--environment", "paseo-copy"])).toEqual({ environment: "paseo-copy", args: ["--fresh"] });
    expect(openingEnvironment("prepare", ["--environment", "previewnet-genesis"])).toEqual({ environment: "previewnet-genesis", args: [] });
    const argv = ["--environment", "previewnet-genesis", "--fresh"];
    openingEnvironment("run", argv);
    expect(argv).toHaveLength(3);
  });
  it("refuses a missing or unknown value, a repeated flag, and the flag outside prepare and run", () => {
    expect(() => openingEnvironment("run", ["--fresh", "--environment"])).toThrow("Use --environment paseo-copy or previewnet-genesis");
    expect(() => openingEnvironment("run", ["--environment", "--fresh"])).toThrow("Use --environment");
    expect(() => openingEnvironment("run", ["--environment", "previewnet-copy", "--fresh"])).toThrow("Use --environment");
    expect(() => openingEnvironment("run", ["--environment", "paseo-copy", "--environment", "previewnet-genesis"])).toThrow("once");
    for (const mode of ["check", "demo", "cleanup", undefined]) expect(() => openingEnvironment(mode, ["--environment", "previewnet-genesis"]), String(mode)).toThrow("prepare and run only");
  });
});

describe("the sudo key check", () => {
  const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", aliceOnHub = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
  it("accepts //Alice printed in either prefix", () => {
    expect(() => assertSudoKey(alice, alice)).not.toThrow();
    expect(() => assertSudoKey(aliceOnHub, alice)).not.toThrow();
  });
  it("refuses another key, no key and an address that does not decode", () => {
    expect(() => assertSudoKey("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", alice)).toThrow("Fork sudo authority mismatch");
    expect(() => assertSudoKey(undefined, alice)).toThrow("Fork sudo authority mismatch");
    expect(() => assertSudoKey("not-an-address", alice)).toThrow("Fork sudo authority mismatch");
    expect(() => assertSudoKey(alice, "not-an-address")).toThrow("Fork sudo authority mismatch");
  });
});

describe("the collection's receipts", () => {
  const receipt = (ok: boolean, number: number): Receipt => ({ ok, txHash: `0x${String(number).padStart(64, "0")}`,
    block: { hash: `0x${"ab".repeat(32)}`, number, index: 2 }, events: [],
    ...(ok ? {} : { dispatchError: { type: "Module", value: { type: "Scarcity", value: { type: "NoPermission" } } } }) });
  const run = async (failAt: number) => {
    const dir = mkdtempSync(join(tmpdir(), "jollity-collection-")), file = join(dir, "collection.json");
    const sent: string[] = [];
    const submitter = { async submit(request: SubmitRequest) {
      sent.push(request.label);
      const result = receipt(sent.length !== failAt, 100 + sent.length);
      return { included: Promise.resolve(result), finalized: Promise.resolve(result) };
    } };
    try {
      const outcome = await submitCollectionCalls({ id: 0, submitter, signer: { publicKey: new Uint8Array(32) } as never, build: (step) => step,
        evidenceFile: file, signal: new AbortController().signal, clock: new SystemClock() }).then(() => "passed" as const, (error: unknown) => error);
      return { outcome, sent, evidence: JSON.parse(readFileSync(file, "utf8")) as { collection: number; receipts: Array<{ call: string; ok: boolean; stage: string; txHash: string }> } };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it("keeps the failed call's receipt, named by its call, and stops there", async () => {
    const { outcome, sent, evidence } = await run(2);
    const error = DispatchFailedError.in(outcome);
    expect(error, String(outcome)).toBeDefined();
    expect(error!.receipt.txHash).toBe(`0x${"102".padStart(64, "0")}`);
    expect(sent).toHaveLength(2);
    const failed = evidence.receipts.filter((r) => !r.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.call === "Scarcity.define_item" && r.txHash === `0x${"102".padStart(64, "0")}`)).toBe(true);
    expect(evidence.receipts.some((r) => r.ok && r.call === "Scarcity.create_collection")).toBe(true);
  });
  it("records all three calls when they pass", async () => {
    const { outcome, evidence } = await run(0);
    expect(outcome).toBe("passed");
    expect([...new Set(evidence.receipts.map((r) => r.call))]).toEqual(["Scarcity.create_collection", "Scarcity.define_item", "NftClaims.set_collection_minter"]);
    expect(evidence.receipts.every((r) => r.ok)).toBe(true);
  });
});

describe("the host's grants on Previewnet from genesis", () => {
  const seeded = { productName: "peopl.testnet", displayName: "Humanity", trustedProducts: { dim2: ["context", "storage"] } };
  it("seeds exactly Humanity's grant to DIM2, and logs at info, on Previewnet only", () => {
    expect(hostGenesisOptions(previewnet())).toEqual({ productConfigs: [peoplTestnetProductConfig], logLevel: "info" });
    expect(JSON.parse(readFileSync(peoplTestnetProductConfig, "utf8"))).toEqual(seeded);
  });
  // Negative control: a seeded peopl entry on the copy would hide the forked chain's real peopl.paseo record.
  it("gives the Paseo copy no product config and no log level", () => {
    expect(hostGenesisOptions(paseo())).toEqual({});
  });
  it("is a config the host adapter accepts for the genesis routes", () => {
    const configs = readProductConfigs([peoplTestnetProductConfig], previewnet());
    expect(configs).toHaveLength(1);
    expect(productConfigArgs(configs)).toEqual(["--product-config", peoplTestnetProductConfig]);
  });
  it("grants DIM2 what Humanity's deploy config publishes, so the two cannot drift", async () => {
    vi.stubEnv("DEPLOY_DOMAIN", "peopl.testnet");
    // The deployer names the grants (HUMANITY_TRUSTED_PRODUCTS); this is the grant the lab seeds for DIM2.
    vi.stubEnv("HUMANITY_TRUSTED_PRODUCTS", JSON.stringify({ dim2: seeded.trustedProducts.dim2 }));
    try {
      const deploy = (await import("../../../humanity-app/deploy/bulletin-deploy.config.ts")).default;
      expect(seeded.productName).toBe(deploy.domain);
      expect(seeded.displayName).toBe(deploy.displayName);
      expect(seeded.trustedProducts.dim2).toEqual(deploy.trustedProducts.dim2);
    } finally { vi.unstubAllEnvs(); }
  });
  it("keeps the host's session logs only when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "jollity-host-logs-"));
    try {
      const run = join(dir, "run"), logs = join(run, "host", "processes"), kept = join(dir, "kept");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "host-ada.log"), "Signing host ready\n"); writeFileSync(join(logs, "records.json"), "{}");
      keepHostLogs(run, undefined);
      expect(() => readdirSync(kept)).toThrow();
      keepHostLogs(run, kept);
      expect(readdirSync(kept)).toEqual(["host-ada.log"]);
      keepHostLogs(join(dir, "missing"), kept);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the fixture's sudo calls", () => {
  const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", bob = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  const sudid = { ok: true, events: [{ type: "Sudo", value: { type: "Sudid", value: { sudo_result: { success: true } } } }] };
  const standIn = (key: string | undefined) => {
    const submitted: unknown[] = [];
    const keyReads = { count: 0 };
    const api: SudoApi = { query: { Sudo: { Key: { getValue: async () => { keyReads.count += 1; return key; } } } },
      tx: { Sudo: { sudo: ({ call }) => ({ createAndSubmit: async () => { submitted.push(call); return sudid; } }) } } };
    return { api, submitted, keyReads };
  };
  it("checks the chain's Sudo.Key before anything is signed", async () => {
    const other = standIn(bob);
    const call = sudoCall(other.api, { address: alice, signer: {}, options: {}, guard: () => {} });
    await expect(call("Game.set_game_phases", { phases: 1 })).rejects.toThrow("Fork sudo authority mismatch");
    expect(other.submitted).toEqual([]);
    const none = standIn(undefined);
    await expect(sudoCall(none.api, { address: alice, signer: {}, options: {}, guard: () => {} })("x", {})).rejects.toThrow("Fork sudo authority mismatch");
    expect(none.submitted).toEqual([]);
  });
  it("sends the call when the key is the signer's, after the owned-network guard, and records the receipt", async () => {
    const own = standIn("15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5");
    const recorded: unknown[] = [];
    await sudoCall(own.api, { address: alice, signer: {}, options: {}, guard: () => {}, record: (evidence) => recorded.push(evidence) })("Game.schedule_games", { games: 1 });
    expect(own.submitted).toEqual([{ games: 1 }]);
    expect(recorded).toHaveLength(1);
    const guarded = standIn(alice);
    await expect(sudoCall(guarded.api, { address: alice, signer: {}, options: {}, guard: () => { throw new Error("not owned"); } })("x", {})).rejects.toThrow("not owned");
    expect(guarded.submitted).toEqual([]);
    expect(guarded.keyReads.count).toBe(0);
  });
});

describe("the opening's host", () => {
  it("is started with the genesis options spread into its single truapiCliHost call", () => {
    const source = readFileSync(new URL("../../lab/opening/session.ts", import.meta.url), "utf8");
    expect(source.match(/\btruapiCliHost\(/g) ?? []).toHaveLength(1);
    const calls = source.match(/truapiCliHost\(\{[^\n]*\}\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\.\.\.hostGenesisOptions\(routes\) \}\);$/);
  });
  it("never fails a run because its logs could not be kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "jollity-host-logs-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = join(dir, "run"), logs = join(run, "host", "processes"), blocked = join(dir, "a-file");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "host-ada.log"), "Signing host ready\n");
      writeFileSync(blocked, "not a folder");
      expect(() => keepHostLogs(run, join(blocked, "logs"))).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/^Host logs not kept \((E[A-Z]+)\)$/);
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(dir);
    } finally { warn.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});
