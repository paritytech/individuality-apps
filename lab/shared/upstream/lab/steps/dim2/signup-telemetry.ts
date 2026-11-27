// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { LocatorRoot } from "@parity/product-lab/ports/browser";

export interface SignupTelemetry {
  ts: number;
  level: string;
  tag: string;
  message: string;
  data?: string;
}

/**
 * A sign-up the app refused: a `signup` entry at level `error`, except `draws skipped: …`. Since jollity-next
 * b3a57b81 (lib/game-source.ts, `onDraws`) that line is logged at `error` when a sign-up goes out without its
 * prize-draw ticket, and the sign-up is still broadcast after it, so it is no refusal.
 */
export function signupRefusal(telemetry: readonly SignupTelemetry[]): SignupTelemetry | undefined {
  return telemetry.find((entry) => entry.tag === "signup" && entry.level === "error" && !entry.message.startsWith("draws skipped:"));
}

/**
 * The question DIM2 asks at Register before a sign-up would go out without its prize-draw ticket (jollity-next
 * b3a57b81, components/registration/draw-skip-sheet.tsx: a dialog labelled by `draw-skip-heading`, with "Try
 * again", sign up anyway and "Not now"). The sign-up waits for the answer. The dialog was removed in #607,
 * before v0.1.47; absence is an observation, not a refusal. A failed read still rejects rather than claiming absence.
 */
export type DrawSkipQuestion = { readonly status: "absent" } | { readonly status: "present"; readonly heading: string };
export function readDrawSkipQuestion(page: LocatorRoot): Promise<DrawSkipQuestion> {
  return page.locator("body").evaluate((body) => {
    const dialog = body.querySelector('[role="dialog"][aria-labelledby="draw-skip-heading"]');
    return dialog
      ? { status: "present" as const, heading: (dialog.querySelector("#draw-skip-heading")?.textContent ?? "").trim() || "(no heading)" }
      : { status: "absent" as const };
  });
}

/** The DIM2 product writes its own debug sheet to IndexedDB. Read only the
 * actor's recent entries of one tag (`signup` by default; the draw screen logs `draw`) and errors when a visible
 * step needs diagnosis. */
export function readSignupTelemetry(page: LocatorRoot, since: number, tag = "signup"): Promise<SignupTelemetry[]> {
  return page.locator("body").evaluate(async (_body, query) => {
    const { startedAt, tag } = query as { startedAt: number; tag: string };
    return new Promise<SignupTelemetry[]>((resolve) => {
      const unavailable: SignupTelemetry[] = [{ ts: Date.now(), level: "warn", tag: "telemetry", message: "" }];
      if (typeof indexedDB === "undefined") { unavailable[0]!.message = "IndexedDB is unavailable in the DIM2 frame"; resolve(unavailable); return; }
      let request: IDBOpenDBRequest;
      try { request = indexedDB.open("jollity-telemetry", 1); }
      catch (error) { unavailable[0]!.message = `IndexedDB open threw: ${String(error)}`; resolve(unavailable); return; }
      request.onerror = () => { unavailable[0]!.message = `IndexedDB open failed: ${request.error?.message ?? "unknown error"}`; resolve(unavailable); };
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("entries")) { database.close(); unavailable[0]!.message = "DIM2 telemetry entries store is absent"; resolve(unavailable); return; }
        const transaction = database.transaction("entries", "readonly");
        const entries = transaction.objectStore("entries").getAll();
        entries.onerror = () => { database.close(); unavailable[0]!.message = `DIM2 telemetry read failed: ${entries.error?.message ?? "unknown error"}`; resolve(unavailable); };
        entries.onsuccess = () => {
          const recent = (entries.result as SignupTelemetry[])
            .filter((entry) => entry.ts >= startedAt && (entry.tag === tag || entry.level === "error"))
            .slice(-12);
          database.close();
          resolve(recent);
        };
      };
    });
  }, { startedAt: since, tag });
}

/** DIM2 also keeps an in-memory log behind its own Ctrl+D debug sheet. This
 * works when its optional persistent telemetry store cannot open in a frame. */
export async function readSignupDebugSheet(page: LocatorRoot): Promise<string> {
  const sheet = page.getByRole("dialog", { name: "Debug logs" });
  const alreadyOpen = await page.locator("body").evaluate((body) =>
    body.querySelector('[role="dialog"][aria-label="Debug logs"]') !== null);
  if (!alreadyOpen) await page.locator("body").evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  try {
    try { await sheet.waitFor({ timeout: 1500 }); }
    catch { return "DIM2 debug sheet did not open"; }
    return (await sheet.textContent())?.slice(-6000) ?? "DIM2 debug sheet is empty";
  } finally {
    await page.locator("body").evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    try { await sheet.waitFor({ state: "hidden", timeout: 1000 }); }
    catch {
      await page.locator('[role="dialog"][aria-label="Debug logs"] button[aria-label="Close"]').click({ timeout: 1500 });
      await sheet.waitFor({ state: "hidden", timeout: 1500 });
    }
  }
}
