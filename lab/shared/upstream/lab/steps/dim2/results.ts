// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { AppSurface, Locator, LocatorRoot } from "@parity/product-lab/ports/browser";
import { chestObservation, LONG_WAIT_BOUND_MS } from "../../../../../../apps/humanity-app/lab/flows/post-game.ts";
import { readSignupTelemetry } from "./signup-telemetry.ts";

/** The prize draw's coin: a player holding a ticket inserts it before the wheel spins (jollity-next b3a57b81,
 * lib/draw/wheel/proto/render-utils/coin/intro.js; the wheel's Continue shows only once the draw has played). */
export const DRAW_TOKEN_LABEL = /^Your lottery token/;

/**
 * Drag the coin down into the slot, as a finger does. The coin takes a pointer only while it levitates, follows the
 * pointer's height frame by frame, and is swallowed once it crosses the slot's mouth; a drag let go short of it
 * springs home, so the caller tries again. The browser ports have no drag, so the pointer events are dispatched on
 * the coin's own target in the page (the app's pointer handlers accept a synthetic pointer; its smoke test drives the
 * coin that way). Returns false when no coin is shown.
 */
export async function insertDrawToken(page: LocatorRoot): Promise<boolean> {
  const token = page.getByLabel(DRAW_TOKEN_LABEL);
  if (!(await page.locator("body").evaluate((body) => [...body.querySelectorAll("[aria-label]")]
    .some((element) => (element.getAttribute("aria-label") ?? "").startsWith("Your lottery token"))))) return false;
  // No named functions inside: the page has no `__name` helper for them.
  await token.evaluate(async (element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const from = box.top + box.height / 2;
    const to = window.innerHeight - 2;
    const moves = Array.from({ length: 30 }, (_, step) => ["pointermove", from + ((to - from) * (step + 1)) / 30] as const);
    for (const [type, y] of [["pointerdown", from] as const, ...moves, ["pointerup", to] as const]) {
      element.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1,
      }));
      if (type !== "pointerup") await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  return true;
}

/** What the post-game screen shows when the results never came: its path, buttons, status lines and whether the
 * draw's coin still waits, with DIM2's own `draw` log since `since` (backlog L-prizedraw). */
async function postGameState(page: LocatorRoot, since: number): Promise<string> {
  const shown = await page.locator("body").evaluate((body) => ({
    path: location.pathname,
    buttons: [...body.querySelectorAll("button")].map((button) => button.textContent?.trim()).filter(Boolean),
    status: [...body.querySelectorAll('[role="status"]')].map((element) => element.textContent?.trim()).filter(Boolean),
    token: [...body.querySelectorAll("[aria-label]")].some((element) => (element.getAttribute("aria-label") ?? "").startsWith("Your lottery token")),
  })).catch((error: unknown) => ({ unreadable: String(error) }));
  const log = await readSignupTelemetry(page, since, "draw").catch((error: unknown) => [{ ts: Date.now(), level: "warn", tag: "telemetry", message: String(error) }]);
  return JSON.stringify({ shown, draw: log.map(({ level, tag, message }) => `${level} ${tag}: ${message}`) });
}

/** The visible post-game journey, including the control at which preparation stopped or the return completed. */
export interface DrawEvidence {
  readonly paths: readonly string[];
  readonly coinSeen: boolean;
  readonly drags: number;
  readonly draw: readonly string[];
  readonly controls: readonly { path: string; name: string }[];
  readonly returnPath: "results-done" | "chest-continue" | null;
  /** When the chest's long-wait notice showed, in ms after the walk began, and when the claims replaced it. */
  readonly longWait: { readonly shownMs: number; readonly clearedMs: number | null } | null;
}

interface JourneyOptions {
  readonly timeoutMs?: number;
  /** Lab timing mark immediately before a successful trusted exit control. No app behavior changes. */
  readonly onControl?: (control: { at: number; path: string; name: string }) => void;
  /** Only a fresh, successful host navigation to this actor's Humanity counts as a return. */
  readonly returned?: () => boolean | Promise<boolean>;
}

/**
 * Prepare the displayed payoff without taking the chest's Continue. The bubble collects claims,
 * opens automatically or on a tap once something is in, then offers Continue, or the Pocket's Claim all, before the
 * pieces stage. Returning takes Continue into the album, or Claim all into the Pocket, then the album's or the shut
 * Pocket's Continue out to Humanity. Legacy /results + Done remains supported.
 */
export function continueToDim2Results(page: LocatorRoot, ui?: AppSurface, options: { timeoutMs?: number } = {}): Promise<DrawEvidence> {
  return walkPostGame(page, ui, options);
}

/** Follow the visible exit, including v0.1.47's intermediate /results + Done, until the host confirms Humanity. */
export function returnFromDim2(page: LocatorRoot, returned: () => boolean | Promise<boolean>, ui?: AppSurface, options: Pick<JourneyOptions, 'timeoutMs' | 'onControl'> = {}): Promise<DrawEvidence> {
  return walkPostGame(page, ui, { ...options, returned });
}

/** Enter on `target`, refused up front where the surface sends no keyboard input. */
function enterOn(target: Locator, ui: AppSurface | undefined): () => Promise<void> {
  const press = ui ? ui.press?.bind(ui) : undefined;
  if (ui && press) return () => press(target, "Enter");
  if (!ui && target.press) return () => target.press!("Enter", { timeout: 1500 });
  throw new Error("DIM2 chest offers only Claim all, and this app surface sends no keyboard input");
}

async function walkPostGame(page: LocatorRoot, ui: AppSurface | undefined, options: JourneyOptions): Promise<DrawEvidence> {
  let lastPath = "";
  const since = Date.now();
  const paths: string[] = [];
  const controls: { path: string; name: string }[] = [];
  let drags = 0;
  let returnPath: DrawEvidence["returnPath"] = null;
  let lastClick: { name: string; closing: boolean; at: number } | undefined;
  let nextOpeningTap = 0;
  let slowSince: number | undefined;
  let slowCleared: number | undefined;
  const evidence = async (): Promise<DrawEvidence> => {
    const log = await readSignupTelemetry(page, since, "draw").catch((error: unknown) => [{ ts: Date.now(), level: "warn", tag: "telemetry", message: String(error) }]);
    const longWait = slowSince === undefined ? null : { shownMs: slowSince - since, clearedMs: slowCleared === undefined ? null : slowCleared - since };
    return { paths, coinSeen: drags > 0, drags, controls, returnPath, longWait, draw: log.map(({ level, tag, message }) => `${level} ${tag}: ${message}`) };
  };
  let deadline = since + (options.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    if (await options.returned?.()) return evidence();
    // The footer and album share a label; observe their scope and actionability atomically.
    const shown = await page.locator("body").evaluate(chestObservation)
      .catch(async (error: unknown) => { if (await options.returned?.()) return null; throw error; });
    if (!shown) return evidence();
    const current = shown.path;
    if (lastPath !== current) lastClick = undefined;
    lastPath = current;
    if (paths.at(-1) !== current) paths.push(current);
    // The notice is gone once any other view shows, including a move off the chest.
    if (slowSince !== undefined && !(current === "/chest" && shown.slow)) slowCleared ??= Date.now();
    if (current !== "/results" && current !== "/chest" && current !== "/prize-draw") {
      // The visible frame can already show Humanity while the navigation registry is still finishing its open.
      // Once an exit was clicked, wait for that evidence instead of treating the new document as a DIM2 error.
      if (options.returned && returnPath) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw new Error(`DIM2 left the post-game path at ${current}; expected /results + Done or the chest's Continue`);
    }
    if (current === "/chest") {
      if (shown.noIdentity) throw new Error("DIM2 chest has no player identity");
      if (shown.slow) {
        // Since Jollity's chest state machine, the long-wait notice also covers results that are still settling
        // (10 s after the bubble lands, or 60 s after the page opens), and its footer button is the skip. Never take
        // it: wait for the claims, which replace the notice, past Jollity's next pending reread.
        if (slowSince === undefined || slowCleared !== undefined) { slowSince = Date.now(); slowCleared = undefined; }
        deadline = Math.max(deadline, since + LONG_WAIT_BOUND_MS);
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (shown.restart) throw new Error("DIM2 chest requires a connection restart");
      if (!options.returned && shown.closing) throw new Error("DIM2 chest album is already closing");
    }
    const found = current === "/results"
      ? shown.buttons.find((button) => button.name === "Done")
      : shown.buttons.find((button) => button.name === "Continue") ?? shown.buttons.find((button) => button.name === "Claim all");
    if (found?.enabled && (current === "/results" || (current === "/chest" && (shown.scene || (shown.heading && shown.gameLabel)))) && !options.returned) {
      return evidence();
    }
    // The product may ignore a click while its state changes, or offer a retry after a refused hand-off.
    // Give an exit time to animate/open before retrying. The draw retains the old one-second retry cadence.
    const retryMs = current === "/prize-draw" ? 1000 : 5000;
    if (found?.enabled && (current !== "/chest" || options.returned) && (!lastClick || lastClick.name !== found.name || lastClick.closing !== shown.closing || Date.now() - lastClick.at >= retryMs)) {
      const button = current === "/chest" && shown.closing ? page.locator('.album-close button, .pocket-claim[data-shut="true"] button')
        : page.getByRole("button", { name: found.name, exact: true });
      // Claim all is the Pocket's way in without the swipe, drawn clipped to nothing until it has focus, so a
      // pointer at its centre lands on the layer below. The keyboard reaches it the way a screen reader does.
      const enter = found.name === "Claim all" ? enterOn(button, ui) : null;
      let clicked = false;
      const at = Date.now();
      try {
        if (enter) await enter();
        else if (ui) await ui.click(button); else await button.click({ timeout: 1500 });
        clicked = true;
      } catch {
        // Focusing Humanity can detach the DIM2 surface while the click resolves. Only host evidence proves it.
        clicked = await options.returned?.() ?? false;
      }
      if (clicked) {
        controls.push({ path: current, name: found.name });
        options.onControl?.({ at, path: current, name: found.name });
        lastClick = { name: found.name, closing: shown.closing, at: Date.now() };
        if (current === "/results") returnPath = "results-done";
        else if (current === "/chest") returnPath = "chest-continue";
      }
    } else if (current === "/chest" && shown.scene && !shown.closing && !found?.enabled && Date.now() >= nextOpeningTap) {
      nextOpeningTap = Date.now() + 1000;
      const chest = page.getByRole("img", { name: "Your chest opening", exact: true });
      if (ui) await ui.click(chest); else await chest.click({ timeout: 1500 });
    } else if (!found && current === "/prize-draw") {
      try { if (await insertDrawToken(page)) drags++; }
      catch { drags++; /* The coin can leave the page mid-drag. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DIM2 did not ${options.returned ? "return to Humanity through /results + Done or the chest's Continue" : "show /results + Done or the chest's Continue"} after the visible chest/draw journey; last path ${lastPath}${slowSince === undefined ? "" : slowCleared === undefined ? `; the chest's long-wait skip was offered from ${Math.round((Date.now() - slowSince) / 1000)} s before this and never taken` : "; the chest's long-wait notice showed earlier and cleared"}; the screen: ${await postGameState(page, since)}`);
}
