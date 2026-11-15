// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The product's Pocket card, in the executable that draws it.
 *
 * The host asks for a card's face whenever it is on screen and keeps that
 * render open for as long as it stays there, so the product can redraw in
 * place as often as it likes. That is the whole difference between a card and
 * a picture, and it is what this module exists to use.
 *
 * Drawing goes through `getPocketManager()` rather than `renderer.onRender`
 * directly. The manager owns the single `onRender` slot and routes by card id,
 * so a second card would not silently replace this one, and it keeps a throw
 * or a rejection in the handler from ending the registration and leaving every
 * card blank for the rest of the worker's life.
 *
 * The face itself is `@humanity/shared/pocket/humanity-face.ts`, the same
 * module the approval sheet's static faces are generated from.
 */
import { humanityFace, type PocketFace, type PocketFaceState } from "@humanity/shared/pocket/humanity-face.ts";
import { readPocketFaceOverride } from "@humanity/shared/pocket/pocket-face-override.ts";
import { readPocketFaceHint, sameFace, writePocketFaceHint } from "@humanity/shared/pocket/pocket-face-hint.ts";
import { progressShare } from "@humanity/shared/card/progress-stripe.ts";
import { readLastFill, writeLastFill } from "@humanity/shared/pocket/pocket-last-fill.ts";
import { getPocketManager } from "@humanity/shared/chain/host-api.ts";
import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";
import { POCKET_CARD_ID } from "@humanity/shared/pocket/pocket-card-link.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { runFlow } from "@humanity/shared/telemetry/flow.ts";

const logger = loggerFor("worker", "pocket");

/**
 * How often the card re-reads the standing behind it while it is on screen.
 *
 * The face is the SPA's card drawn natively, so there is nothing on it to
 * count down; what can change is the person's standing, on the order of
 * games. A minute is plenty, and the host stores every face it is sent, so
 * faster would only be writes.
 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * How often a card on screen looks for what the app wrote for it: the face of
 * the app's latest card read (`pocket-face-hint.ts`), and in a debug build a
 * standing the debug panel simulated.
 *
 * Product storage has no change notification, so a card on screen polls it: a
 * registration or a name claim the app has just seen should reach the card
 * before the person looks up from the phone, not on the next minute's read. A
 * read of a local key or two every two seconds costs nothing a person could
 * notice, and nothing is sent unless the face changes.
 */
const STORAGE_POLL_INTERVAL_MS = 2_000;

/**
 * The stripe's fill, eased one frame at a time. The render vocabulary has no
 * animation, so a smooth fill is the worker sending successive trees; the host
 * decodes, redraws and keeps every one, so it is a short burst (0.9s at about
 * 16 frames a second) and only when the fill has somewhere to go. It starts
 * from the share the card last drew (`pocket-last-fill.ts`), which is the face
 * the host is already showing: an unchanged standing does not move, progress
 * made off screen fills in from where the person last saw it, and a card that
 * has never drawn a stripe fills in from empty.
 */
const FILL_DURATION_MS = 900;
const FILL_FRAME_MS = 60;

/** Fast out of the gate, settling into place, like the app card's fill. */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export interface PocketCardDeps {
  /** What to draw: who the person is and where they stand, re-read on each
   *  refresh. `floor` marks a face drawn because the read failed, which must
   *  not replace a face from a read that worked. */
  resolveFace(): Promise<{ face: PocketFace; floor: boolean }>;
}

export interface PocketCardRenderer {
  start(): Promise<void>;
  stop(): void;
}

export function createPocketCardRenderer(deps: PocketCardDeps): PocketCardRenderer {
  let card: { unsubscribe(): void } | null = null;

  return {
    async start() {
      const pocket = await getPocketManager();
      if (pocket == null) {
        // A host with no Pocket surface draws whatever static face the card
        // was added with. That is a narrower product, not a broken one.
        logger.info("no pocket surface on this host; the card stays static");
        return;
      }

      // The handler may return a promise, and the manager holds the race: a
      // cleanup that resolves after the card has already left runs at once.
      card = pocket.drawCard(POCKET_CARD_ID, async (send) => {
        logger.info("drawing pocket card {cardId}", { cardId: POCKET_CARD_ID });

        // When the read behind `face` started: the app's hint and the worker's
        // own read replace each other in that order, so the later read wins.
        let faceReadAt = 0;
        // A floor face stands for a failed read: drawn only while there is
        // nothing better, never stored, and replaced by the first real read.
        let onFloor = false;
        let released = false;
        // A card coming back on screen may have been off it for hours, and the
        // chain read behind a face takes seconds. The newest stored face, if
        // there is one, is drawn at once; the worker's own read follows it.
        const ownStartedAt = Date.now();
        // The first draw after the card comes on screen is the flow; a
        // `floor` face means the read failed and a placeholder is drawn.
        const own = runFlow("pocket.render", () => deps.resolveFace(), {
          outcome: ({ face, floor }) => ({ kind: face.state.kind, ok: !floor }),
        });
        // Caught here so a rejection during the awaits below is never unhandled.
        own.catch(() => undefined);
        const firstHint = await readPocketFaceHint();
        let face: PocketFace;
        // The key holds the newest face either side has read, so the next
        // render starts from it, never from an older one.
        const keep = (next: PocketFace, readAt: number) => {
          void writePocketFaceHint({ face: next, readAt });
        };
        if (firstHint == null) {
          const read = await own;
          face = read.face;
          onFloor = read.floor;
          faceReadAt = read.floor ? 0 : ownStartedAt;
          if (!read.floor) keep(face, ownStartedAt);
        } else {
          face = firstHint.face;
          faceReadAt = firstHint.readAt;
        }
        /** Takes a read of the worker's own that started at `startedAt`, unless
         *  something newer is drawn or the read failed with a real face shown. */
        const takeOwn = (read: { face: PocketFace; floor: boolean }, startedAt: number): boolean => {
          if (read.floor) {
            if (!onFloor) return false;
          } else {
            if (startedAt < faceReadAt) return false;
            faceReadAt = startedAt;
            keep(read.face, startedAt);
          }
          onFloor = read.floor;
          if (sameFace(read.face, face)) return false;
          face = read.face;
          return true;
        };
        let override: PocketFaceState | null = DEBUG_PANEL ? await readPocketFaceOverride() : null;
        // The share the card shows now, and the frame timer easing it towards the standing's.
        let storedFill = (await readLastFill()) ?? 0;
        let shownFill = storedFill;
        let tween: NodeJS.Timeout | undefined;
        // Keeps the share the host's cached face will show, written only when it changes.
        const settle = (share: number) => {
          shownFill = share;
          if (share === storedFill) return;
          storedFill = share;
          void writeLastFill(share);
        };

        const paint = () => {
          // A read that lands after the card left draws nothing.
          if (released) return;
          const current = override == null ? face : { ...face, state: override };
          clearTimeout(tween);
          const state = current.state;
          if (state.kind !== "candidate") {
            // No stripe on this face, and that is what the host will show next time.
            settle(0);
            send(humanityFace(current));
            return;
          }
          const target = progressShare(state.score, state.threshold);
          const from = shownFill;
          if (from === target) {
            send(humanityFace(current));
            return;
          }
          const frames = Math.max(1, Math.round(FILL_DURATION_MS / FILL_FRAME_MS));
          const frame = (step: number) => {
            shownFill = from + (target - from) * easeOutCubic(step / frames);
            if (step >= frames) {
              settle(target);
              send(humanityFace(current));
              return;
            }
            send(humanityFace({ ...current, fill: shownFill }));
            tween = setTimeout(() => frame(step + 1), FILL_FRAME_MS);
          };
          frame(1);
        };

        paint();
        if (firstHint != null) {
          own
            .then((read) => {
              if (!released && takeOwn(read, ownStartedAt)) paint();
            })
            .catch((error: unknown) => {
              logger.warn("pocket card first read failed: {error}", { error: String(error) });
            });
        }
        const refresh = setInterval(() => {
          const startedAt = Date.now();
          deps
            .resolveFace()
            .then((read) => {
              if (!released && takeOwn(read, startedAt)) paint();
            })
            .catch((error: unknown) => {
              logger.warn("pocket card refresh failed: {error}", { error: String(error) });
            });
        }, REFRESH_INTERVAL_MS);
        // Repaints only on a change: the host stores every face it is sent.
        const poll = setInterval(() => {
          readPocketFaceHint()
            .then((hint) => {
              // Equal is taken too: the app's name overlay can change the face
              // twice within one card read, and both writes carry its time.
              if (released || hint == null || hint.readAt < faceReadAt) return;
              faceReadAt = hint.readAt;
              onFloor = false;
              if (sameFace(hint.face, face)) return;
              face = hint.face;
              logger.info("pocket card drawing a newer stored read {kind}", { kind: face.state.kind });
              paint();
            })
            .catch((error: unknown) => {
              logger.warn("pocket card hint read failed: {error}", { error: String(error) });
            });
          if (!DEBUG_PANEL) return;
          readPocketFaceOverride()
            .then((next) => {
              if (JSON.stringify(next) === JSON.stringify(override)) return;
              override = next;
              logger.info("pocket card drawing simulated standing {kind}", { kind: next?.kind ?? "none" });
              paint();
            })
            .catch((error: unknown) => {
              logger.warn("pocket card override read failed: {error}", { error: String(error) });
            });
        }, STORAGE_POLL_INTERVAL_MS);

        // Returned to the host, which calls it when the card leaves the
        // screen. Without this the timers outlive the card and keep sending
        // faces into a render nobody is watching.
        return () => {
          released = true;
          clearInterval(refresh);
          clearInterval(poll);
          clearTimeout(tween);
          // Left mid-fill, the host keeps the frame it had; the next fill starts there.
          settle(shownFill);
          logger.info("pocket card {cardId} released", { cardId: POCKET_CARD_ID });
        };
      });

      logger.info("pocket card renderer registered");
    },
    stop() {
      card?.unsubscribe();
      card = null;
    },
  };
}
