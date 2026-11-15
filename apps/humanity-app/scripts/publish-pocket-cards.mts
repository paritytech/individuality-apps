#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Adds the worker's Pocket cards to its published executable record.
 *
 * A host draws a product's Pocket card from its worker only when the record on
 * `worker.<label>.<tld>` lists the card under `pocket.cards` (the Android
 * host's `ManifestParser`, then `PublishedPocketCards.find`). bulletin-deploy 0.19.x
 * composes that record from `$v`, `kind`, `appVersion`, `entrypoint` and
 * `includes` alone and drops `pocket`, so a deploy on its own leaves the
 * Humanity card on the app's bundled placeholder. This reads the record the
 * CLI just wrote, adds the cards declared on the worker entry of
 * `deploy/bulletin-deploy.config.ts`, and writes it back with the same key.
 *
 * It runs after every deploy (`npm run humanity:setup` calls it): the CLI's next
 * publish rewrites the record without `pocket`, and this puts it back.
 *
 * Usage:
 *   MNEMONIC=... DEPLOY_DOMAIN=peopl.testnet \
 *     tsx scripts/publish-pocket-cards.mts --env preview [--dry-run]
 *
 * `--dry-run` reads the published record and prints the one it would write,
 * without signing anything; it needs no MNEMONIC.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The host refuses a face larger than this (the Android host's `RemoteFaceSource.MAX_FACE_BYTES`). */
const MAX_FACE_BYTES = 256 * 1024;
/** A card id is screened as a chat identifier: at most this many UTF-8 bytes. */
const MAX_CARD_ID_BYTES = 256;

interface PocketCard {
  id: string;
  title: string;
  preview: string;
}

interface WorkerEntry {
  kind: "worker";
  path: string;
  appVersion: readonly number[];
  entrypoint: string;
  includes: { chat: boolean; pocket: boolean };
  pocket?: { cards: PocketCard[] };
}

interface PublishedWorker {
  kind?: unknown;
  appVersion?: unknown;
  entrypoint?: unknown;
  includes?: Record<string, unknown>;
  pocket?: unknown;
}

/** The slice of bulletin-deploy's public entry this script uses. */
interface BulletinDeploy {
  DEFAULT_MNEMONIC: string;
  DotNS: new () => {
    connect(options: Record<string, unknown>): Promise<unknown>;
    getTextRecord(name: string, key: string): Promise<string>;
    setTextRecord(name: string, key: string, value: string): Promise<{ txHash: string }>;
    disconnect(): void;
    readonly tld: string;
  };
  getTextRecordBudgetBytes(): number;
}

class PublishError extends Error {}

function fail(message: string, ...detail: string[]): never {
  throw new PublishError([message, ...detail].join("\n"));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "deploy/bulletin-deploy.config.ts");

function parseArgs(argv: string[]): { envId: string; dryRun: boolean } {
  let envId: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env") {
      envId = argv[index + 1];
      index += 1;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (!envId) fail("--env <bulletin-deploy environment id> is required, e.g. --env preview.");
  return { envId, dryRun };
}

/** The worker entry of the deploy config, which needs DEPLOY_DOMAIN set to load. */
async function workerEntry(): Promise<WorkerEntry> {
  const config = (await import(pathToFileURL(configPath).href)) as {
    default: { executables: { kind: string }[] };
  };
  const worker = config.default.executables.find((entry) => entry.kind === "worker");
  if (worker === undefined) fail(`${configPath} declares no worker executable.`);
  return worker as WorkerEntry;
}

/** Screens the cards the way the Android host will, so a defect fails here rather than on a phone. */
function checkCards(worker: WorkerEntry, cards: PocketCard[]): void {
  if (!worker.includes.pocket) fail("The worker declares pocket.cards but includes.pocket is false.");
  if (cards.length === 0) fail("pocket.cards is empty.");
  const workerDir = resolve(dirname(configPath), worker.path);
  const seen = new Set<string>();
  for (const card of cards) {
    const where = `pocket card "${card.id}"`;
    if (!card.id || card.id.normalize("NFC") !== card.id) fail(`${where}: the id must be non-empty NFC text.`);
    if (Buffer.byteLength(card.id, "utf8") > MAX_CARD_ID_BYTES) fail(`${where}: the id is over ${MAX_CARD_ID_BYTES} bytes.`);
    if (seen.has(card.id)) fail(`${where}: ids must be unique.`);
    seen.add(card.id);
    if (!card.title.trim()) fail(`${where}: the title is blank.`);
    // A host resolves the preview inside the worker's published folder and refuses a URL.
    if (!card.preview.trim() || isAbsolute(card.preview) || card.preview.split("/").includes("..") || /^[a-z]+:/i.test(card.preview)) {
      fail(`${where}: preview must be a relative path inside the worker folder, got "${card.preview}".`);
    }
    const face = resolve(workerDir, card.preview);
    if (!existsSync(face)) fail(`${where}: preview ${face} does not exist; build the worker first.`);
    if (statSync(face).size > MAX_FACE_BYTES) fail(`${where}: preview ${face} is over ${MAX_FACE_BYTES} bytes.`);
    try {
      JSON.parse(readFileSync(face, "utf8"));
    } catch {
      fail(`${where}: preview ${face} is not JSON.`);
    }
  }
}

/** The bulletin-deploy on PATH: the same install `npm run humanity:setup` deploys with. */
async function loadBulletinDeploy(): Promise<BulletinDeploy> {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (!dir) continue;
    const bin = resolve(dir, "bulletin-deploy");
    if (!existsSync(bin)) continue;
    const entry = resolve(dirname(realpathSync(bin)), "../dist/index.js");
    if (!existsSync(entry)) fail(`bulletin-deploy at ${bin} has no dist/index.js to import.`);
    return (await import(pathToFileURL(entry).href)) as BulletinDeploy;
  }
  fail("bulletin-deploy is not available on PATH.", "Install it first: npm install -g bulletin-deploy@0.25.0");
}

function sameVersion(published: unknown, expected: readonly number[]): boolean {
  return Array.isArray(published) && published.length === expected.length && published.every((part, index) => part === expected[index]);
}

async function main(): Promise<void> {
  const { envId, dryRun } = parseArgs(process.argv.slice(2));
  const domain = process.env["DEPLOY_DOMAIN"]?.trim();
  if (!domain) fail("DEPLOY_DOMAIN is required: the full DotNS name deployed, e.g. peopl.testnet.");
  const mnemonic = process.env["MNEMONIC"]?.trim();
  if (!dryRun && !mnemonic) fail("MNEMONIC is required to sign the record (the key that owns the name).");

  const worker = await workerEntry();
  const cards = worker.pocket?.cards;
  if (cards === undefined) {
    process.stdout.write("The worker declares no Pocket cards; nothing to publish.\n");
    return;
  }
  checkCards(worker, cards);

  const bd = await loadBulletinDeploy();
  // bulletin-deploy resolves every network value from `env`; the name check
  // and the record writes below use the TLD it resolved, so they agree.
  const dotns = new bd.DotNS();
  await dotns.connect({ env: envId, mnemonic: mnemonic ?? bd.DEFAULT_MNEMONIC });
  const tld = dotns.tld;
  try {
    if (!domain.endsWith(`.${tld}`)) fail(`DEPLOY_DOMAIN ${domain} is not on the "${envId}" TLD .${tld}.`);
    const workerName = `worker.${domain.slice(0, -(tld.length + 1))}`;
    const current = await dotns.getTextRecord(workerName, "executable");
    if (!current) fail(`${workerName}.${tld} has no executable record; publish the product first (npm run humanity:setup).`);
    const published = JSON.parse(current) as PublishedWorker;
    if (published.kind !== "worker" || typeof published.includes !== "object") {
      fail(`${workerName}.${tld} does not hold a worker record: ${current}`);
    }
    // Only ever add to the record this deploy wrote: a different entrypoint or
    // version means the chain holds someone else's publish.
    const matches = published.entrypoint === worker.entrypoint && sameVersion(published.appVersion, worker.appVersion);
    if (!matches) {
      const detail = `published ${current}, config entrypoint "${worker.entrypoint}" version ${JSON.stringify(worker.appVersion)}`;
      if (!dryRun) fail(`${workerName}.${tld} is not the record this deploy published.`, detail);
      process.stdout.write(`Note: ${workerName}.${tld} is not the record this config would publish (${detail}).\n`);
    }

    const next = JSON.stringify({
      ...published,
      includes: { ...published.includes, pocket: true },
      pocket: { cards: cards.map(({ id, title, preview }) => ({ id, title, preview })) },
    });
    const budget = bd.getTextRecordBudgetBytes();
    if (Buffer.byteLength(next, "utf8") > budget) fail(`The record with its cards is over the ${budget}-byte text record budget: ${next}`);

    process.stdout.write(`\n${workerName}.${tld} executable\n  published: ${current}\n  with cards: ${next}\n`);
    if (next === current) {
      process.stdout.write("Already published; nothing to write.\n");
      return;
    }
    if (dryRun) {
      process.stdout.write("Dry run: nothing was written.\n");
      return;
    }
    await dotns.setTextRecord(workerName, "executable", next);
    const readBack = await dotns.getTextRecord(workerName, "executable");
    if (readBack !== next) fail(`Read-back of ${workerName}.${tld} does not match what was written: ${readBack}`);
    process.stdout.write(`Published ${cards.length} Pocket card(s) on ${workerName}.${tld}.\n`);
  } finally {
    dotns.disconnect();
  }
}

try {
  await main();
  // polkadot-api keeps sockets open past disconnect; nothing else is pending.
  process.exit(0);
} catch (error) {
  if (error instanceof PublishError) {
    process.stderr.write(`\nError: ${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}
