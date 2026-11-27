// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { UiReadiness } from "../../../../../../apps/humanity-app/lab/flows/ui-readiness.ts";
import { Enum } from "polkadot-api";
import { addressesEqual } from "@parity/product-sdk/address";
import { findEvent, type FoundEvent, type RuntimeEvent } from "@parity/product-lab/chain";
import type { AppSurface, LocatorRoot } from "@parity/product-lab/ports/browser";
import type { ActivityEvent } from "@parity/product-lab/ports/driving";
import type { PeopleConnection } from "../humanity/chain/people.ts";
import type { ConfirmRelease, ConfirmSeat } from "./confirm-together.ts";
import { DIM2_CAMERA_SCREEN, describeDim2Camera, diagnoseDim2Camera, dim2Launch, type Dim2CameraDiagnosis, type Dim2Launch } from "./camera-evidence.ts";

export interface LiveGame {
  readonly index: number;
  readonly fromBlock: number;
  /** The opt-in full journey schedules at most two game days in one scenario. */
  readonly journeyDay?: 1 | 2;
  /** Epoch milliseconds the game plays at, when it plays later than its phases require (a game resumed from a fixture). */
  readonly playsAt?: number;
}

/** Obtained by scanning finalized People, not by submitting a report from the lab. */
export interface Dim2ReportProof {
  readonly kind?: "reported";
  readonly event: FoundEvent;
  readonly txHash: string;
  readonly finalizedHead: number;
  readonly score: number;
  readonly lastAttendedGame: number;
  readonly archivedAt?: number;
}

/**
 * A report DIM2's early close shut out, read from finalized People (#596: the pallet leaves Reporting at report_ends, or
 * as soon as every attendance is decided). Three facts, never a timeout: the game left Reporting in `closedBlock`, whose
 * time is before the game's `report_ends`; at that block the player's `Game.Players` row is registered, holds no report and
 * holds its attendance already decided (`early_attendance_enactment`); and no finalized block from the game's start to
 * `finalizedHead` holds a `Game.ReportSubmitted` from the player for the game. After `closedBlock` the pallet takes no report.
 */
export interface Dim2ShutOutProof {
  readonly kind: "shut-out";
  readonly account: string;
  readonly game: number;
  readonly closedBlock: number;
  readonly closedBlockHash: string;
  /** The closing block's `Timestamp.Now`, epoch milliseconds. */
  readonly closedAt: number;
  /** The game's `report_ends` at the last block in Reporting, chain seconds. */
  readonly reportEnds: number;
  /** The player's decided attendance at the closing block, as the chain holds it (JSON). */
  readonly decided: string;
  readonly finalizedHead: number;
}

export type Dim2ReportOutcome = Dim2ReportProof | Dim2ShutOutProof;

export function isShutOut(outcome: Dim2ReportOutcome): outcome is Dim2ShutOutProof {
  return outcome.kind === "shut-out";
}

/** What the confirm stage did, for the run's record: when it opened, armed, was released and pressed (epoch ms). */
export interface Dim2ConfirmTiming {
  openedAt?: number;
  armedAt?: number;
  release?: ConfirmRelease;
  pressedAt?: number;
  /** The CTA's label when the loop last read it in the confirm stage. */
  lastLabel?: string;
}

/** Driver evidence kept separately from the report's finalized votes and the app's own turn-vote trail. */
export interface Dim2VoteDiagnostics {
  roundTaps: number;
  confirmTaps: number;
  corrections: { id: string; from: "pending" | "reject"; at: number }[];
  clickErrors: { id: string; stage: "round" | "confirm"; at: number; error: string }[];
  reads: number;
  views: { at: number; view: string }[];
  droppedViews: number;
  droppedErrors: number;
}

/**
 * How much of the report window the confirm-together hold leaves: two 6 s blocks, so a press at the deadline still
 * lands in a block before report_ends (DIM2's own last call is 3 s before it). Review round 2.
 */
export const REPORT_DEADLINE_MARGIN_MS = 12_000;
/** How often the hold re-reads the chain's reporting deadline. */
const DEADLINE_POLL_MS = 500;

/**
 * The local time (epoch ms) by which a held Confirm must be pressed: the game's `report_ends` less the best block's
 * time, less the margin, from now. Any doubt (the read fails, the best block holds another game or one not in
 * Reporting, no block time) answers "now", so the hold never outlives the window.
 */
export async function readReportDeadline(chain: PeopleConnection, game: LiveGame, now: () => number = Date.now): Promise<number> {
  try {
    const best = await chain.access.bestHead();
    const [held, time] = await Promise.all([
      chain.access.historicalStorage("Game", "Game", [], best.hash) as Promise<GameRecord | undefined>,
      chain.access.historicalStorage("Timestamp", "Now", [], best.hash) as Promise<number | bigint | undefined>,
    ]);
    if (held?.index !== game.index || held.state.type !== "Reporting" || time === undefined) return now();
    const left = Number(held.report_ends) * 1000 - Number(time) - REPORT_DEADLINE_MARGIN_MS;
    return Number.isFinite(left) ? now() + Math.max(0, left) : now();
  } catch {
    return now();
  }
}

/** How often the play loop reads the screen: in the confirm stage the reports must go out together, so no throttles. */
const PLAY_POLL_MS = 1500;
const CONFIRM_POLL_MS = 250;
/** A Confirm press goes out once per this, so a retry ("Vote didn't send") is pressed at once but not hammered. */
const CONFIRM_PRESS_GAP_MS = 1000;

/**
 * The UI gesture is a click on a real tile, not a call to Game.report. Until DIM2 enters its /game route the player
 * waits for the game to start: `report` (the step's activity) shows that stretch as a wait of the lab, "Waiting for the
 * game to start", complete when /game shows (the lab window's activity, and the video's shortened waits, name it).
 */
/**
 * `launch`: the browser behind `page` for a camera diagnosis (camera-evidence.ts): the session's own page by default; a
 * visible surface passes the lab window's.
 *
 * With `together` (the game's other players' seats, `confirm-together.ts`), the confirm stage arms (every tile turned,
 * Confirm enabled), waits for the others and then presses at once; without it, it presses as soon as it is armed.
 */
export async function playDim2InApp(page: LocatorRoot, ui: AppSurface | undefined, signal: AbortSignal, playsAt?: number, report?: (event: ActivityEvent) => void, onView?: (view: string) => void, together?: ConfirmSeat, reportDeadline?: () => Promise<number>, launch: Dim2Launch | undefined = dim2Launch(page), onVotes?: (votes: Dim2VoteDiagnostics) => void): Promise<{ taps: number; confirmations: number; sawGame: boolean; sawChest: boolean; confirm: Dim2ConfirmTiming; votes: Dim2VoteDiagnostics }> {
  let taps = 0, confirmations = 0, sawGame = false, sawChest = false, lastTapAt = 0, lastConfirmAt = 0;
  const confirmTiming: Dim2ConfirmTiming = {};
  const votes: Dim2VoteDiagnostics = { roundTaps: 0, confirmTaps: 0, corrections: [], clickErrors: [], reads: 0, views: [], droppedViews: 0, droppedErrors: 0 };
  const kickoff = { type: "wait", id: `dim2-kickoff-${Math.random().toString(36).slice(2)}`, label: "Waiting for the game to start" } as const;
  let waiting = false;
  let lastClickProblem = "";
  const tileReadiness = new UiReadiness(), confirmReadiness = new UiReadiness();
  // A tap toggles a FinalTile's verdict, so a tile tapped moments ago whose turn has not rendered yet is left alone.
  const tappedAt = new Map<string, number>();
  const tappable = (id: string) => Date.now() - (tappedAt.get(id) ?? 0) >= 8000;
  let lastView = "no app state read";
  // Why no tile was voted, should none be: what /game last showed, the most tile slots (and votable ones) one read
  // saw, the last tap tried, and the post-game route. Read only for the failure message.
  let lastGameView = "never on /game", mostSlots = 0, mostVotable = 0, firstGameAt = 0, lastTapAttempt = "none", postGameRoute = "";
  // The camera diagnosis taken when DIM2 first shows one of its camera screens (camera-evidence.ts). Diagnostics only:
  // the loop never presses the screen's own "Try again".
  let camera: Dim2CameraDiagnosis | undefined;
  const cameraNote = () => camera ? `; ${describeDim2Camera(camera)}` : "";
  const tapTile = async (id: string, expected: "pending" | "reject", stage: "round" | "confirm") => {
    // Recheck the verdict at click time: a prior input that has just rendered approve must never be toggled back.
    const tile = page.locator(`[data-id=${JSON.stringify(id)}][data-tile-slot] .cursor-pointer[data-tile-verdict=${JSON.stringify(expected)}] >> nth=0`);
    try {
      if (ui) await ui.click(tile); else await tile.click({ timeout: 1000 });
      tappedAt.set(id, Date.now());
      taps++;
      if (stage === "round") votes.roundTaps++;
      else {
        votes.confirmTaps++;
        votes.corrections.push({ id, from: expected, at: Date.now() });
      }
      lastTapAttempt = `vote tile ${id}: tapped`;
    } catch (error) {
      lastClickProblem = lastTapAttempt = `vote tile ${id}: ${String(error)}`;
      if (votes.clickErrors.length < 32) votes.clickErrors.push({ id, stage, at: Date.now(), error: String(error).slice(0, 1000) });
      else votes.droppedErrors++;
    }
  };
  // 12 minutes of play, counted from when the game plays when that is later (a game resumed from a fixture was
  // scheduled well ahead, and its players wait in DIM2 until then).
  const deadline = Math.max(Date.now(), playsAt ?? 0) + 12 * 60_000;
  try {
    while (Date.now() < deadline) {
      let pollMs = PLAY_POLL_MS;
      signal.throwIfAborted();
      const state = await page.locator("body").evaluate((body) => ({
        path: location.pathname,
        headings: [...body.querySelectorAll("h1, h2, [role=heading]")].slice(0, 10).map((node) => (node.textContent ?? "").trim().slice(0, 200)),
        buttons: [...body.querySelectorAll("button")].slice(0, 20).map((node) => (node.textContent ?? "").trim().slice(0, 200)),
        debugOpen: body.querySelector('[role="dialog"][aria-label="Debug logs"]') !== null,
        slots: body.querySelectorAll("[data-id][data-tile-slot]").length,
        confirm: (() => {
          const button = [...body.querySelectorAll<HTMLButtonElement>("button")]
            .find((node) => /^(?:Confirm votes|Confirming|Submitting|Vote didn't send)/i.test((node.textContent ?? "").trim()));
          return button ? { label: (button.textContent ?? "").trim(), disabled: button.disabled } : null;
        })(),
        // FinalTile exposes its rendered verdict on the tile root. Its first approve pushes in at rotateY(0deg),
        // just like an undecided tile, so rotation cannot identify a vote. A tap toggles approve to reject:
        // leave an approved tile alone, including one whose rotation is still zero.
        tiles: [...body.querySelectorAll<HTMLElement>("[data-id][data-tile-slot]")]
          .flatMap((node) => {
            const root = node.querySelector<HTMLElement>("[data-tile-verdict], .cursor-pointer");
            if (!root) return [];
            const verdict = root.dataset.tileVerdict;
            const readable = verdict === "pending" || verdict === "approve" || verdict === "reject";
            const pointer = root.classList.contains("cursor-pointer");
            return [{ id: node.dataset.id ?? "", verdict: readable ? verdict : "unreadable", voted: readable && verdict !== "pending",
              votable: root.dataset.tileVotable === undefined ? pointer : root.dataset.tileVotable === "true",
              ready: readable && pointer && root.dataset.tileTapReady !== "false" }];
          }),
      }));
      lastView = `${state.path}, headings=${JSON.stringify(state.headings)}, buttons=${JSON.stringify(state.buttons)}, confirm=${state.confirm?.label ?? "none"}/${state.confirm?.disabled ?? "n/a"}, tiles=${state.tiles.map(({ id, verdict, votable, ready }) => `${id}:${verdict}/votable=${votable}/ready=${ready}`).join(",") || "none"}`;
      votes.reads++;
      if (votes.views.at(-1)?.view !== lastView) {
        if (votes.views.length === 256) { votes.views.shift(); votes.droppedViews++; }
        votes.views.push({ at: Date.now(), view: lastView });
      }
      onView?.(lastView);
      tileReadiness.observe(state.path === "/game" && state.tiles.some(tile => tile.verdict === "unreadable"),
        `DIM2 tile has no displayed verdict (${lastView})`);
      confirmReadiness.observe(state.path === "/game" && state.confirm?.label === "Confirm votes" && state.confirm.disabled
        && !state.tiles.some(tile => tile.votable && tile.verdict !== "approve"),
        `DIM2 shows a verdict on every confirm tile but leaves Confirm votes disabled (${lastView})`);
      const cameraScreen = state.headings.find((heading) => DIM2_CAMERA_SCREEN.test(heading));
      if (cameraScreen && !camera) camera = await diagnoseDim2Camera(page, `DIM2 showed "${cameraScreen}" on ${state.path}`, launch);
      if (state.path === "/game") {
        sawGame = true;
        firstGameAt ||= Date.now();
        lastGameView = lastView;
        mostSlots = Math.max(mostSlots, state.slots);
        mostVotable = Math.max(mostVotable, state.tiles.filter((tile) => tile.votable).length);
      }
      if (!sawGame && !waiting) { waiting = true; report?.({ ...kickoff, status: "waiting", timeoutMs: deadline - Date.now() }); }
      if (sawGame && waiting) { waiting = false; report?.({ ...kickoff, status: "complete" }); }
      // A diagnostic sheet can outlive registration after a browser-side error.
      // Dismiss only that product overlay so all votes still come from real tile
      // gestures on the displayed app.
      if (state.debugOpen) {
        await page.locator("body").evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (state.path === "/chest" || state.path === "/prize-draw" || state.path === "/results") {
        sawChest = true;
        postGameRoute = state.path;
        break;
      }
      // The confirm heading can sit after a long hydrated game tree in
      // body.textContent. Its actual button is the reliable displayed stage.
      if (sawGame && state.path === "/game" && state.confirm) {
        // The report phase has no throttles: a report one block behind the others can be shut out (#596).
        pollMs = CONFIRM_POLL_MS;
        confirmTiming.openedAt ??= Date.now();
        confirmTiming.lastLabel = state.confirm.label;
        // This action approves the peers it can judge. A missed turn seals NotPerson automatically, so the
        // confirm screen can start red without a reject gesture. A verdict-guarded input approves it without
        // toggling an approval back to reject. Include temporarily unready peers when deciding whether to arm.
        const undecided = state.tiles.filter((tile) => tile.votable && tile.verdict !== "approve");
        const pressable = !state.confirm.disabled && /^(?:Confirm votes|Confirming|Vote didn't send)/i.test(state.confirm.label);
        if (undecided.length > 0) {
          // DIM2 can auto-file in 7 s. Neither a recent round tap nor a failed click may impose the 8 s round
          // cooldown here. The selector rechecks the verdict, and the next read must see approve before arming.
          for (const { id, verdict } of undecided.filter((tile) => tile.ready)) await tapTile(id, verdict === "reject" ? "reject" : "pending", "confirm");
        } else if (pressable && confirmTiming.release === undefined) {
          // Armed. With DIM2's auto-confirm running, wait for the game's other players (DIM2 still files on its own
          // schedule), then read the screen again and press at once. A hand confirm or a retry is never held.
          confirmTiming.armedAt = Date.now();
          const autoConfirming = /^Confirming/i.test(state.confirm.label);
          confirmTiming.release = !together ? { waitedMs: 0, armed: 1, playing: 1, why: "alone" }
            : autoConfirming ? await holdUntilDeadline(together, signal, reportDeadline) : together.pressing();
          continue;
        } else if (pressable && Date.now() - lastConfirmAt >= CONFIRM_PRESS_GAP_MS) {
          lastConfirmAt = Date.now();
          const confirm = page.getByRole("button", { name: /Confirm votes|Confirming|Vote didn't send/i });
          try {
            if (ui) await ui.click(confirm); else await confirm.click({ timeout: 1000 });
            confirmations++;
            confirmTiming.pressedAt ??= lastConfirmAt;
          } catch (error) { lastClickProblem = `confirm button: ${String(error)}`; }
        }
      } else if (state.path === "/game" && state.tiles.some((tile) => tile.votable && tile.ready && !tile.voted) && Date.now() - lastTapAt >= 3500) {
        lastTapAt = Date.now();
        for (const { id } of state.tiles.filter((tile) => tile.votable && tile.ready && !tile.voted && tappable(tile.id))) await tapTile(id, "pending", "round");
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    together?.leave();
    if (waiting) report?.({ ...kickoff, status: "failed" });
    // Persist even on a UI throw/abort; the report wait that follows can also fail minutes later.
    onVotes?.(votes);
  }
  if (!sawGame) throw new Error(`DIM2 never entered the real /game route (last view: ${lastView})${cameraNote()}`);
  if (!sawChest) throw new Error(`DIM2 did not reach its post-game screen within 12 minutes (tile taps: ${taps}; confirmations: ${confirmations}; last view: ${lastView}; last click error: ${lastClickProblem || "none"})${cameraNote()}`);
  if (taps === 0) {
    const confirmStage = confirmTiming.openedAt === undefined ? "never shown" : `shown (last label "${confirmTiming.lastLabel}")`;
    throw new Error(`DIM2 reached the post-game screen without any UI tile vote: route ${postGameRoute} after ${((Date.now() - firstGameAt) / 1000).toFixed(1)} s on /game; `
      + `most tile slots in a read ${mostSlots}; most votable tiles in a read ${mostVotable} (each its own maximum); confirm stage ${confirmStage}; last tap attempt: ${lastTapAttempt}; `
      + `last /game view: ${lastGameView}; post-game view: ${lastView}; ${describeDim2Camera(camera ?? await diagnoseDim2Camera(page, "post-game screen without a tile vote", launch))}`);
  }
  return { taps, confirmations, sawGame, sawChest, confirm: confirmTiming, votes };
}

/** How long one read of the reporting deadline may take; a read that hangs or fails answers "now". Review round 3. */
const DEADLINE_READ_LIMIT_MS = 1000;

/**
 * Waits with the game's other players, but never past the reporting deadline (`readReportDeadline`): DIM2's
 * auto-confirm pulls its filing in only before its last call, so a hold that ran into the window's end could leave the
 * report unfiled. Each read is limited to DEADLINE_READ_LIMIT_MS (a read that hangs or fails answers "now"); a timer
 * from the first answer releases the hold, and the reads every DEADLINE_POLL_MS (a chain clock that jumped) can only
 * pull it earlier. Without a deadline reader the group's own hold bounds it.
 */
async function holdUntilDeadline(together: ConfirmSeat, signal: AbortSignal, reportDeadline: (() => Promise<number>) | undefined): Promise<ConfirmRelease> {
  if (!reportDeadline) return together.armed(signal);
  const armedAt = Date.now();
  const read = () => Promise.race([
    reportDeadline().catch(() => Date.now()),
    new Promise<number>((resolve) => setTimeout(() => resolve(Date.now()), DEADLINE_READ_LIMIT_MS)),
  ]);
  const closing = () => ({ ...together.pressing(), waitedMs: Date.now() - armedAt, why: `the report window closes (${REPORT_DEADLINE_MARGIN_MS / 1000} s margin before report_ends)` });
  let deadline = await read();
  if (Date.now() >= deadline) return closing();
  const windowEnds = new AbortController();
  let timer = setTimeout(() => windowEnds.abort(), deadline - Date.now());
  // read() cannot reject: a failed read answers "now" inside the race.
  const refresh = setInterval(() => void read().then((next) => {
    if (next >= deadline || windowEnds.signal.aborted) return;
    deadline = next;
    clearTimeout(timer);
    timer = setTimeout(() => windowEnds.abort(), Math.max(0, deadline - Date.now()));
  }), DEADLINE_POLL_MS);
  try {
    return await together.armed(AbortSignal.any([signal, windowEnds.signal]));
  } catch (error) {
    if (signal.aborted) throw error;
    return closing();
  } finally {
    clearTimeout(timer);
    clearInterval(refresh);
    windowEnds.abort();
  }
}

export function eventBelongsToAccount(value: unknown, account: string, gameIndex: number): boolean {
  if (!value || typeof value !== "object") return false;
  const event = value as { who?: { type?: unknown; value?: unknown }; game_index?: unknown };
  if (event.game_index !== gameIndex || event.who?.type !== "Account" || typeof event.who.value !== "string") return false;
  try { return addressesEqual(event.who.value, account); }
  catch { // A malformed account in a decoded event cannot prove this actor reported.
    return false;
  }
}

export function assertDim2PlayedGame(found: { score: number; lastAttendedGame: number; archivedAt?: number }, gameIndex: number): void {
  if (found.lastAttendedGame === gameIndex && found.score > 0) return;
  if (found.score === 0 && found.archivedAt !== undefined) return;
  throw new Error(`DIM2 UI report finalized for game ${gameIndex}, but its finalized outcome is neither attended with positive score nor archived with zero score (score ${found.score}, last attended ${found.lastAttendedGame}, archived at ${found.archivedAt ?? "none"})`);
}

/** Recheck the exact actor, game and finalized result before reusing a prior chain read. */
export function assertDim2ReportProof(proof: Dim2ReportProof, game: LiveGame, account: string): void {
  if (!eventBelongsToAccount(proof.event.value, account, game.index))
    throw new Error(`DIM2 report proof belongs to another actor or game, not ${account} in game ${game.index}`);
  if (!Number.isSafeInteger(proof.event.block) || proof.event.block < game.fromBlock || proof.event.block > proof.finalizedHead)
    throw new Error(`DIM2 report block ${proof.event.block} is outside finalized game ${game.index} history`);
  if (!Number.isSafeInteger(proof.event.extrinsicIndex) || proof.event.extrinsicIndex < 0 ||
      !/^0x[0-9a-f]{64}$/i.test(proof.event.blockHash) || !/^0x[0-9a-f]{64}$/i.test(proof.txHash))
    throw new Error(`DIM2 report proof for ${account} has no exact block and extrinsic hash`);
  assertDim2PlayedGame(proof, game.index);
}

function assertDim2Outcome(outcome: Dim2ReportOutcome, game: LiveGame, account: string): void {
  if (isShutOut(outcome)) assertDim2ShutOut(outcome, game, account);
  else assertDim2ReportProof(outcome, game, account);
}

/** A later Gherkin assertion uses the proven receipt (or shut-out record) before PAPI unpins history. */
export class Dim2ReportEvidence {
  private readonly scenarios = new Map<string, Map<string, Dim2ReportOutcome>>();

  forgetScenario(scenarioId: string): void { this.scenarios.delete(scenarioId); }

  remember(scenarioId: string, actorId: string, game: LiveGame, account: string, proof: Dim2ReportOutcome): void {
    assertDim2Outcome(proof, game, account);
    let actors = this.scenarios.get(scenarioId);
    if (!actors) { actors = new Map(); this.scenarios.set(scenarioId, actors); }
    actors.set(actorId, proof);
  }

  get(scenarioId: string, actorId: string, game: LiveGame, account: string): Dim2ReportOutcome {
    const proof = this.scenarios.get(scenarioId)?.get(actorId);
    if (!proof) throw new Error(`No previously verified finalized DIM2 UI report for ${account} in game ${game.index}`);
    assertDim2Outcome(proof, game, account);
    return proof;
  }
}

interface GameRecord { index: number; report_ends: number | bigint; state: { type: string } }
interface PlayerRecord { registered?: boolean; sent_report?: boolean; early_attendance_enactment?: unknown }
const OPEN_STATES = ["Registration", "Shuffle", "Reporting"];
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);

/**
 * Whether finalized People shows this player's report shut out by DIM2's early close (`Dim2ShutOutProof`). `head` is a
 * finalized block the caller has already searched, from `game.fromBlock`, for the player's `Game.ReportSubmitted`.
 * `final` says whether the answer can still change: once the game has left Reporting by `head`, the chain takes no
 * report, so a refusal then is final; a block it could not read is not.
 */
export async function readDim2ShutOut(chain: PeopleConnection, game: LiveGame, account: string, head: { number: number; hash: string }): Promise<{ proof?: Dim2ShutOutProof; reading: string; final: boolean }> {
  const gameAt = async (hash: string) => await chain.access.historicalStorage("Game", "Game", [], hash) as GameRecord | undefined;
  const current = await gameAt(head.hash);
  if (current?.index === game.index && OPEN_STATES.includes(current.state.type))
    return { reading: `game ${game.index} is still in ${current.state.type} at finalized #${head.number}`, final: false };
  // The last finalized block still in Reporting, newest first; the block after it is the one that closed the window.
  let lastReporting: { number: number; game: GameRecord } | undefined;
  for (let number = head.number - 1; number >= game.fromBlock && !lastReporting; number--) {
    const block = await chain.access.blockAt(number);
    if (!block) return { reading: `finalized block #${number} unreadable while looking for game ${game.index}'s last Reporting block`, final: false };
    const held = await gameAt(block.hash);
    if (held?.index === game.index && held.state.type === "Reporting") lastReporting = { number, game: held };
  }
  if (!lastReporting) return { reading: `game ${game.index} was never in Reporting in finalized #${game.fromBlock}..#${head.number}`, final: true };
  const closedBlock = lastReporting.number + 1;
  const closing = await chain.access.blockAt(closedBlock);
  if (!closing) return { reading: `finalized block #${closedBlock}, where game ${game.index} left Reporting, unreadable`, final: false };
  const [now, player] = await Promise.all([
    chain.access.historicalStorage("Timestamp", "Now", [], closing.hash) as Promise<number | bigint | undefined>,
    chain.access.historicalStorage("Game", "Players", [Enum("Account", account)], closing.hash) as Promise<PlayerRecord | undefined>,
  ]);
  const reportEnds = Number(lastReporting.game.report_ends);
  const closedAt = Number(now ?? Number.NaN);
  const closed = `game ${game.index} left Reporting at finalized #${closedBlock} (${Number.isFinite(closedAt) ? `${Math.round(reportEnds - closedAt / 1000)} s before report_ends ${reportEnds}` : "no block time"})`;
  if (!(closedAt < reportEnds * 1000)) return { reading: `${closed}: not an early close`, final: true };
  if (!player) return { reading: `${closed}, but Game.Players holds no row for ${account} there`, final: true };
  if (player.registered !== true) return { reading: `${closed}, but ${account} was not registered for it`, final: true };
  if (player.sent_report !== false) return { reading: `${closed}, but ${account}'s row reads sent_report ${json(player.sent_report)}`, final: true };
  if (player.early_attendance_enactment === undefined || player.early_attendance_enactment === null)
    return { reading: `${closed}, but ${account}'s attendance was not decided there`, final: true };
  const decided = json(player.early_attendance_enactment);
  return {
    proof: { kind: "shut-out", account, game: game.index, closedBlock, closedBlockHash: closing.hash, closedAt, reportEnds, decided, finalizedHead: head.number },
    reading: `${closed} with ${account}'s attendance decided (${decided}) and no report from it`,
    final: true,
  };
}

/** Recheck a shut-out proof for this game before a later assertion reuses it. */
export function assertDim2ShutOut(proof: Dim2ShutOutProof, game: LiveGame, account: string): void {
  if (proof.game !== game.index || !addressesEqual(proof.account, account))
    throw new Error(`DIM2 shut-out record belongs to another actor or game, not ${account} in game ${game.index}`);
  if (!Number.isSafeInteger(proof.closedBlock) || proof.closedBlock <= game.fromBlock || proof.closedBlock > proof.finalizedHead)
    throw new Error(`DIM2's early close at block ${proof.closedBlock} is outside finalized game ${game.index} history`);
  if (!/^0x[0-9a-f]{64}$/i.test(proof.closedBlockHash)) throw new Error(`DIM2's early close at #${proof.closedBlock} has no exact block hash`);
  if (!(proof.closedAt < proof.reportEnds * 1000)) throw new Error(`DIM2 game ${game.index} left Reporting at report_ends, not early: no report was shut out`);
  if (!proof.decided || proof.decided === "null") throw new Error(`DIM2's early close at #${proof.closedBlock} names no decided attendance`);
}

/**
 * Independent finalized-chain proof of the app's report and score, with its exact extrinsic hash; or, when DIM2's early
 * close shut the report out, the chain's record of that (`readDim2ShutOut`), never a timeout.
 */
export async function readDim2Report(chain: PeopleConnection, game: LiveGame, account: string, timing: { searchMs?: number; pollMs?: number; capture?: (event: FoundEvent, txHash: string) => Promise<void> } = {}): Promise<Dim2ReportOutcome> {
  const deadline = Date.now() + (timing.searchMs ?? 6 * 60_000);
  let next = game.fromBlock;
  let shutOut = "not read";
  while (Date.now() < deadline) {
    const head = await chain.access.finalizedHead();
    let event: FoundEvent | undefined;
    // A UI report is near the current finalized head. Search the retained
    // finalized range newest first, then only newly finalized blocks on the
    // next poll; long setup and waiting-room periods need no repeated scan.
    for (let number = head.number; number >= next; number--) {
      const block = await chain.access.blockAt(number);
      if (!block) continue;
      const events = await chain.access.historicalStorage("System", "Events", [], block.hash) as RuntimeEvent[] | undefined;
      const found = findEvent(events ?? [], "Game", "ReportSubmitted", (value) => eventBelongsToAccount(value, account, game.index));
      if (found) {
        event = { block: number, blockHash: block.hash, extrinsicIndex: found.extrinsicIndex, value: found.value };
        break;
      }
    }
    if (event) {
      const hashes = await chain.access.extrinsicHashes(event.blockHash);
      const txHash = hashes?.[event.extrinsicIndex];
      if (!txHash) throw new Error(`Game.ReportSubmitted at finalized #${event.block} has no extrinsic hash`);
      await timing.capture?.(event, txHash);
      // What the wait last read, so a wait that ends without an accepted outcome names the outcome it saw (22 October
      // 2026: every report landed, yet the wait ended with no reading in the failure).
      let lastRead = "nothing read";
      // The next finalized block to search for the game's GameEnded; blocks already searched are not read again.
      let endedFrom = 0;
      const played = await chain.waitFor("DIM2 processed score after UI report", async () => {
        // An explicit finalized hash can outlive the typed client's
        // chainHead pin set during this long browser journey.
        const finalized = await chain.access.finalizedHead();
        const [player, archived] = await Promise.all([
          chain.access.historicalStorage("Score", "Participants", [Enum("Account", account)], finalized.hash) as Promise<{ score: number; last_attended_game: number } | undefined>,
          chain.access.historicalStorage("Game", "ArchivedPlayers", [Enum("Account", account)], finalized.hash) as Promise<{ type: string; value: { first_game: number; archived_since: number } } | undefined>,
        ]);
        const score = player?.score ?? 0;
        const lastAttendedGame = player?.last_attended_game ?? -1;
        lastRead = `at finalized #${finalized.number}: score ${score}, last attended ${lastAttendedGame}, archived ${archived ? `${archived.type} ${JSON.stringify(archived.value)}` : "none"}`;
        if (lastAttendedGame === game.index && score > 0) return { score, lastAttendedGame };
        if (score === 0 && archived?.type === "Kickable" && archived.value.first_game <= game.index && archived.value.archived_since >= game.fromBlock) {
          // The pallet archives a player in a PlayerProcess step and emits GameEnded when the processing ends: in the
          // archive's block or a later one (22 October 2026: archived at #1795201, GameEnded at #1795202).
          const since = archived.value.archived_since;
          for (let number = Math.max(since, endedFrom); number <= finalized.number; number++) {
            const block = await chain.access.blockAt(number);
            if (!block) { lastRead += `; block #${number} unreadable`; return undefined; }
            const events = await chain.access.historicalStorage("System", "Events", [], block.hash) as RuntimeEvent[] | undefined;
            if (events?.some(({ event }) => event.type === "Game" && event.value.type === "GameEnded" && (event.value.value as { index?: number }).index === game.index))
              return { score, lastAttendedGame, archivedAt: since };
            endedFrom = number + 1;
          }
          lastRead += `; no GameEnded for game ${game.index} in finalized #${since}..#${finalized.number}`;
        }
        return undefined;
      }, 180_000).catch((cause: unknown) => {
        throw new Error(`${cause instanceof Error ? cause.message : String(cause)}; last read ${lastRead}`, { cause });
      });
      return { kind: "reported", event, txHash, finalizedHead: head.number, ...played };
    }
    // No report through `head`: a game that has left Reporting takes none any more, so the chain's record says whether
    // DIM2's early close shut this player out. A refusal then is final, and the search ends with it.
    const closed = await readDim2ShutOut(chain, game, account, head);
    if (closed.proof) return closed.proof;
    shutOut = closed.reading;
    if (closed.final) break;
    next = head.number + 1;
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs ?? 1000));
  }
  throw new Error(`No finalized Game.ReportSubmitted for ${account} in game ${game.index}; not shut out by an early close: ${shutOut}`);
}
