// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a step needs of a person and of the run, and no more: her Jollity page, her game account, a picture of her
// screen, and the People chain to read. The steps ask here, so that they do not care who opened the page:
//
//  - the lab's own session (session.ts): a CLI host and Chromium on this machine, Jollity from this checkout;
//  - product-lab's default session, which is the only way to a phone: the published app in the Polkadot app's
//    WebView, a person whose keys the lab does not hold.
//
// The second has not run yet (20 November 2026): it is written to what product-lab's phone pages offer (locators and
// scripts that close over nothing) and to be tried on the first phone.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { AfterAll } from '@cucumber/cucumber';
import { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { defaultSessionPage, defaultSessionScreenshot } from '@parity/product-lab/composition';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { repositoryRoot } from '../shared/paths.ts';
import { ownSession, type Person } from './session.ts';

type Picture = { screenshot?: (options: { type: 'png'; timeout?: number }) => Promise<Uint8Array> };

export interface Player {
  readonly id: string;
  readonly name: string;
  /** Her Jollity, opened if it is not yet. */
  page(): Promise<BrowserPage>;
  /** Her game account: the one Jollity signs her up with. */
  account(): Promise<string>;
  /** A picture of her screen, where there is a way to take one. */
  screenshot(): Promise<Uint8Array | undefined>;
  /** Only in the lab's own session: what is Chromium's and this checkout's (the dev server, the kept console, Humanity). */
  readonly own?: Person;
}

/** The person a step names. */
/** The game account of each person on a default session, as her home first named it. */
const accounts = new Map<string, string>();
export function playerOf(actor: { id: string; name: string }): Player {
  const own = ownSession()?.persons.get(actor.id);
  if (own) {
    return { id: own.id, name: own.name, own,
      page: async () => (await own.jollity()).page,
      account: async () => own.game.address,
      async screenshot() {
        const inApp = await own.jollity();
        return (inApp.session.screenshot?.() ?? (inApp.page as unknown as Picture).screenshot?.({ type: 'png', timeout: 4_000 }))?.catch(() => undefined);
      },
    };
  }
  const page = () => {
    const found = defaultSessionPage(actor.id);
    if (!found) throw Error(`${actor.name} has no Jollity page: neither the lab's own session nor product-lab's default one opened it`);
    return found as unknown as BrowserPage;
  };
  return { id: actor.id, name: actor.name,
    page: async () => page(),
    // The lab holds no key of hers: the account is the one her own Jollity shows on its home. It is read once and
    // kept: after a game the page is on the prize draw or the chest, where no home names it (Paseo game 364, 23
    // November 2026: the phone bot's report was on chain and the step that looks for it could not ask whose).
    async account() {
      const known = accounts.get(actor.id); if (known) return known;
      const shown = await page().getByTestId('home').getAttribute('data-account');
      if (!shown) throw Error(`${actor.name}'s Jollity names no game account on its home`);
      accounts.set(actor.id, shown);
      return shown;
    },
    // On a phone the page is the app's webview, which cannot image itself: product-lab images the device's screen.
    screenshot: async () => defaultSessionScreenshot(actor.id, { timeoutMs: 4_000 }).then(taken => taken.status === 'captured' ? taken.bytes : undefined, () => undefined),
  };
}

export interface World {
  /** The People chain, read by the lab itself and never through a person's host. */
  readonly people: PapiChainAccess;
  readonly signal: AbortSignal;
  /** Where this run keeps what it saves (screenshots). */
  readonly directory: string;
  readonly evidence: unknown[];
}

/** The People endpoints of the live networks, for a run whose session is product-lab's own and names none to a step. */
const LIVE_PEOPLE: Readonly<Record<string, string>> = {
  'live-next-v2': 'wss://paseo-people-next-system-rpc.polkadot.io',
  'live-previewnet': 'wss://previewnet.substrate.dev/people',
};
let standalone: World | undefined;
// A run on product-lab's default session has nobody else to close this connection, and an open one keeps the process
// from ending (20 November 2026: the first phone run passed and never exited). Cucumber's hook does it; where this
// module is loaded outside a Cucumber run (the config, a plan) there is no run to hook and nothing to close.
try { AfterAll(async () => { const open = standalone; standalone = undefined; await open?.people.close(); }); } catch { /* not a Cucumber run */ }

/** The run a step is in. */
export function world(): World {
  const own = ownSession();
  if (own) return { people: own.people, signal: own.context.signal, directory: own.directory, evidence: own.evidence };
  if (standalone) return standalone;
  const environment = process.env.PRODUCT_LAB_ENVIRONMENT ?? '', ws = LIVE_PEOPLE[environment];
  if (!ws) throw Error(`These steps read the People chain themselves and know no endpoint for the environment ${JSON.stringify(environment)}`);
  const parent = join(repositoryRoot, '.product-lab', 'previewnet-poc'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  // One connection for the run; it ends with the process.
  return standalone = { people: PapiChainAccess.connect(ws, { publicEndpoint: { reason: 'The lab reads the live network its people are on' } }) as PapiChainAccess,
    signal: new AbortController().signal, directory: mkdtempSync(join(parent, 'run-')), evidence: [] };
}

/**
 * Her camera, as her Jollity's page can tell: what the browser says of the permission and, with `open`, a stream
 * opened and closed again. Opening is what raises the host's and the device's permission sheets where they have not
 * been answered, so a sign-up opens it and a game only asks. The script closes over nothing.
 */
export async function camera(page: Pick<BrowserPage, 'evaluate'>, open: boolean) {
  // A camera that is busy for a moment is not a camera that is refused: Jollity opens it too, and on 21 November 2026
  // one sign-up met "NotReadableError: Could not start video source" where every run before had opened it. Three
  // tries, two seconds apart, before the answer stands.
  let seen = await cameraOnce(page, open);
  for (let again = 0; again < 2 && 'refused' in seen && /NotReadable|AbortError|TrackStart/i.test(seen.refused ?? ''); again++) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    seen = await cameraOnce(page, open);
  }
  return seen;
}

async function cameraOnce(page: Pick<BrowserPage, 'evaluate'>, open: boolean) {
  return page.evaluate(async (opens: boolean) => {
    let permission = 'unknown';
    try { permission = (await navigator.permissions.query({ name: 'camera' as PermissionName })).state; } catch { permission = 'unknown'; }
    if (!opens) return { permission };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0], settings = track?.getSettings();
      const opened = { live: track?.readyState === 'live', label: track?.label ?? null, width: settings?.width ?? null, height: settings?.height ?? null };
      for (const each of stream.getTracks()) each.stop();
      let after = permission;
      try { after = (await navigator.permissions.query({ name: 'camera' as PermissionName })).state; } catch { after = permission; }
      return { permission: after, opened };
    } catch (error) { return { permission, refused: String(error).slice(0, 200) }; }
  }, open);
}
