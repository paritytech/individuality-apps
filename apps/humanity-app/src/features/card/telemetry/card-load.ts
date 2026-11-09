// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The `card.load` flow: how long a person waits between opening the app and
 * seeing their card, with every call on the way as a child span.
 *
 * No one function spans that wait. It starts at the script start, passes
 * through three react-query hooks (`useHumanityUserId`, `useGameAccount`,
 * the card read in `useHumanityCard`) and ends at the commit that draws the
 * live card, so the flow is one module-level `OpenFlow` that `main.tsx`
 * opens and the hooks narrate. Stages are fixed and ordered; a stage named
 * out of order is ignored, which is what makes the narration safe to call
 * from hooks that re-run: an identity refetch on window focus cannot reopen
 * `identity` once the read has begun, and the first read aborted by the
 * query re-keying (the game account resolved) does not restart `read` — the
 * person is still waiting, so the stage is still open.
 *
 * One flow per launch. After `finish` every call here is a no-op, and so is
 * every call before `begin` (tests, the worker, a hook mounted in a tree
 * that never booted through `main.tsx`).
 *
 * **From the tap.** When the Pocket host says when the person opened the
 * product (`openedAtEpochMs` in its bootstrap), the wait they feel began
 * before this page did. `card.load` stays dated from the navigation start; a
 * second transaction, `pocket.open`, runs from the tap to the same end and
 * outcome. It has no stages of its own: the host's side is the host's events
 * and the rest is `card.load`, both joined on `host.session_id`. A page that
 * goes hidden before the card is shown ends it `abandoned` (a person who
 * stopped waiting; the host keeps the WebView alive, so `card.load` may
 * finish later and that time is not a wait), and a reload or back/forward
 * navigation tells no story: the host's bootstrap runs again with the first
 * open's time.
 */
import { readHostBootstrap } from "@humanity/shared/telemetry/host-session.ts";
import {
  openFlow,
  type FlowAttributes,
  type FlowOutcome,
  type OpenFlow,
} from "@humanity/shared/telemetry/flow.ts";

const STAGES = ["boot", "identity", "game-account", "read", "render"] as const;
export type CardLoadStage = (typeof STAGES)[number];

let flow: OpenFlow | null = null;
let open: OpenFlow | null = null;
let reached = -1;

/** `pocket.open`, if the host dated this open and the page is not a re-run of it. */
function openFromTap(): OpenFlow | null {
  const { openedAtEpochMs, openSource } = readHostBootstrap() ?? {};
  if (openedAtEpochMs == null) return null;
  const [navigation] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  if (navigation?.type === "reload" || navigation?.type === "back_forward") return null;
  const tap = openFlow("pocket.open", {
    startTime: openedAtEpochMs / 1000,
    detached: true,
    ...(openSource == null ? {} : { attributes: { "open.source": openSource } }),
  });
  const abandon = (): void => {
    if (!tap.finished && document.visibilityState !== "hidden") return;
    document.removeEventListener("visibilitychange", abandon);
    tap.finish({ kind: "abandoned", ok: false });
  };
  document.addEventListener("visibilitychange", abandon);
  abandon();
  return tap;
}

export const cardLoad = {
  /** Open the flow and its `boot` stage, both dated from the script start:
   *  the bundle download and module evaluation before this line ran are
   *  part of the wait, and in `vite dev` most of it. */
  begin(): void {
    if (flow != null) return;
    const scriptStart = performance.timeOrigin / 1000;
    flow = openFlow("card.load", { startTime: scriptStart });
    reached = -1;
    open = openFromTap();
    cardLoad.stage("boot", scriptStart);
  },
  /** Enter `name` if the flow is in flight and `name` lies ahead. */
  stage(name: CardLoadStage, startTime?: number): void {
    if (flow == null || flow.finished) return;
    const index = STAGES.indexOf(name);
    if (index <= reached) return;
    reached = index;
    flow.stage(name, startTime);
  },
  set(attributes: FlowAttributes): void {
    flow?.set(attributes);
  },
  finish(outcome: FlowOutcome): void {
    flow?.finish(outcome);
    open?.finish(outcome);
  },
  fail(error: unknown): void {
    flow?.fail(error);
    open?.fail(error);
  },
  /** Whether a launch's card load is still being waited on. */
  get inFlight(): boolean {
    return flow != null && !flow.finished;
  },
};

/** Test seam: forget the flow so the next `begin` opens a fresh one. */
export function resetCardLoadForTests(): void {
  flow = null;
  open = null;
  reached = -1;
}
