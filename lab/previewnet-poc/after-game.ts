// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The way on after a game, as a person takes it: her coin dragged into the draw's slot ("INSERT COIN", for a player
// who is in the draw), a hold on the draw ("HOLD ANYWHERE"), then the book at the foot of the collectables screen,
// closed by dragging its cover across. Jollity 0.1.73 has no button for any of them, so a bot that only taps stood
// on the draw for good (Paseo game 375, 26 November 2026).
//
// The gestures are pointer events dispatched in the page, at the places the page itself reports: the draw's coin, its
// ring and the book's right page. So they are the same on a phone's WebView, an iOS simulator and the lab's own browser, and
// they reach the handlers a finger reaches. They are not the device's touch: what the app's shell does with a touch
// before the page hears of it is not exercised here.
//
// Written for a page and no more: every script closes over nothing and is sent to the page as source.
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserPage } from '@parity/product-lab/ports/browser';

type Page = Pick<BrowserPage, 'evaluate'>;

/** The draw's hold takes 1.5 s (lib/draw/hold/scene.ts HOLD_MS × 1.5); the lab holds a second longer. */
const HOLD_MS = 2_600;
/** How long the page has to leave the draw after a hold, and the book to shut after its cover is let go. */
const HOLD_SETTLES_MS = 20_000, BOOK_SHUTS_MS = 15_000;
/** How long the stage has to take the coin after it was let go over the slot. */
const COIN_GOES_IN_MS = 10_000;
/** How long the lab waits on "Drawing the winners…" for the wheel before it takes that screen's Continue past it. */
const DRAW_COMES_MS = 3 * 60_000;

export type AfterGameView = {
  path: string; width: number; height: number; text: string;
  /**
   * on the draw: the stage waits for the player's coin (where it is, and how far down its slot is), the hold is
   * offered and heard (and where its ring is), a Continue is shown instead (`drawing`: on the screen that waits for
   * the winners), or none of them yet. `state` is what the hold's scene says of itself for a test,
   * "<phase> held|free …" (lib/draw/hold/scene.ts): it hears a press only in "ready" and "hold".
   */
  draw: { way: 'coin'; x: number; y: number; to: number } | { way: 'hold'; x: number; y: number; state: string | null } | { way: 'continue'; drawing: boolean }
    | { way: 'wait'; state: string | null } | null;
  /** on the collectables screen: the book and its right page, when it is up */
  book: { shut: boolean; hidden: boolean; left: number; top: number; width: number } | null;
  /** on the collectables screen without a book: still waiting, nothing to keep (its Continue shown), or a restart card */
  collectables: 'waiting' | 'nothing' | 'restart' | 'book' | null;
};

/** What the page shows after a game. It names no function of its own: the TS runner wraps a named one in a helper
 *  the page does not have. */
const view = (): AfterGameView => {
  const path = location.pathname + location.search, onDraw = location.pathname.startsWith('/prize-draw'), onCollectables = location.pathname.startsWith('/collectables');
  const buttons = Array.from(document.querySelectorAll('button'));
  const holdWay = buttons.find(button => (button.textContent ?? '').trim() === 'Continue to your collectables') ?? null;
  const go = buttons.find(button => (button.textContent ?? '').trim() === 'Continue') ?? null;
  // A Continue counts only where a person could press it: the collectables screen lays its own out unseen.
  let goShown = go !== null && go.getClientRects().length > 0;
  for (let at: Element | null = go; at && goShown; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.5 || style.pointerEvents === 'none') goShown = false;
  }
  let draw: AfterGameView['draw'] = null;
  if (onDraw) {
    // The hold is live once the draw offers its way on: only then is its way for a keyboard in the page.
    // After a win the ring and that way are up while the scene still shows the prize and is deaf to a press: its own
    // word says when it listens. A build without that word is taken at the ring's.
    const ring = document.querySelector('.hold-hint-ring')?.getBoundingClientRect();
    const state = document.querySelector<HTMLElement>('canvas[data-hold]')?.dataset.hold ?? null;
    if (holdWay && ring && ring.width > 0 && (state === null || state.startsWith('ready') || state.startsWith('hold')))
      draw = { way: 'hold', x: ring.left + ring.width / 2, y: ring.top + ring.height / 2, state };
    else {
      // A player in the draw starts it herself: the stage shows her coin (#coin, in the DOM until it went in) over a
      // slot it paints, about 77 % down the stage, and waits for the coin to be dragged into it.
      const coin = document.querySelector('#app #coin:not(.is-hidden)')?.getBoundingClientRect(), stage = document.querySelector('#app')?.getBoundingClientRect();
      if (coin && coin.width > 0 && stage) draw = { way: 'coin', x: coin.left + coin.width / 2, y: coin.top + coin.height / 2, to: stage.top + stage.height * 0.83 };
      else draw = goShown ? { way: 'continue', drawing: (document.body.innerText || '').includes('Drawing the winners') } : { way: 'wait', state };
    }
  }
  let book: AfterGameView['book'] = null, collectables: AfterGameView['collectables'] = null;
  if (onCollectables) {
    const root = document.querySelector<HTMLElement>('[data-testid="pocket-claim"]'), page = document.querySelector('.pocket-book-page')?.getBoundingClientRect();
    if (root && page) book = { shut: root.dataset.shut === 'true', hidden: root.classList.contains('is-hidden'), left: page.left, top: page.top, width: page.width };
    collectables = book ? 'book' : document.querySelector('[data-testid="collectables-restart"]') ? 'restart'
      : !document.querySelector('[data-testid^="collectables-"]') && goShown ? 'nothing' : 'waiting';
  }
  return { path, width: innerWidth, height: innerHeight, text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240), draw, book, collectables };
};

/** One pointer event of a finger, at a point of the page, on the element named or the one under the point. */
const pointer = ({ type, x, y, onto }: { type: 'pointerdown' | 'pointermove' | 'pointerup'; x: number; y: number; onto?: string }) => {
  const target = (onto ? document.querySelector(onto) : null) ?? document.elementFromPoint(x, y) ?? document.documentElement;
  const up = type === 'pointerup';
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: up ? 0 : 1,
    pressure: up ? 0 : 0.5, bubbles: true, cancelable: true, composed: true }));
  return target.tagName.toLowerCase();
};

/** A click on the button with this name, where the page has one. */
const press = (name: string) => {
  const button = Array.from(document.querySelectorAll('button')).find(candidate => (candidate.textContent ?? '').trim() === name);
  button?.click();
  return button !== undefined;
};

/** Where the book's cover is taken and let go: from the middle of the open cover, left of the spine, to past the right page. */
export function coverDrag(book: { left: number; top: number; width: number }, screen: { width: number; height: number }) {
  return { from: Math.max(4, book.left - 0.6 * book.width), to: Math.min(screen.width - 4, book.left + 1.3 * book.width), y: Math.min(screen.height - 24, book.top + 40) };
}

export type AfterGame = {
  /** the draw's coin: dragged into its slot, still there after three drags, or the stage never asked for it */
  coin: 'went-in' | 'stayed' | 'not-asked';
  /** the draw's hold: it took the page on, it did not (and the page's own way on was taken), or no hold was offered */
  hold: 'went-on' | 'did-nothing' | 'not-offered';
  /** the book: closed by the drag, still open after it, or never up (and why) */
  book: 'closed' | 'still-open' | 'nothing-to-keep' | 'not-shown';
  /** where the walk ended, in words */
  ended: string;
  trail: { at: string; did: string; path: string }[];
  last: AfterGameView | { unreadable: string };
};

/**
 * Walks from the screen a game ended on to the end of its collectables: holds on the draw, closes the book. Returns
 * what happened and throws nothing of its own; the caller decides what fails. `waitMs` is how long the collectables
 * may take to come (they wait for the votes), `shot` takes a picture where the host can.
 */
export async function goOnAfterGame(page: Page, options: { waitMs: number; signal: AbortSignal; shot?: (name: string) => Promise<unknown> }): Promise<AfterGame> {
  const { signal } = options, deadline = Date.now() + options.waitMs, trail: AfterGame['trail'] = [];
  const pause = (ms: number) => delay(ms, undefined, { signal }).catch(() => undefined);
  const look = async () => page.evaluate(view, undefined).catch(error => ({ unreadable: String(error).slice(0, 200) }));
  const shoot = async (name: string) => { await options.shot?.(name).catch(() => undefined); };
  let coin: AfterGame['coin'] = 'not-asked', hold: AfterGame['hold'] = 'not-offered', book: AfterGame['book'] = 'not-shown', ended = 'the wait ran out', last: AfterGame['last'] = { unreadable: 'never read' };
  let coins = 0, holds = 0, drags = 0, sawPostGame = false, drawingSince = 0;
  const did = (what: string) => { trail.push({ at: new Date().toISOString(), did: what, path: 'path' in last ? last.path : '?' }); };
  /** Reads the page until `until` holds or the time is up; true when it held. */
  const waitFor = async (ms: number, until: (seen: AfterGameView) => boolean) => {
    for (const end = Date.now() + ms; Date.now() < end && !signal.aborted; await pause(500)) {
      last = await look();
      if (!('unreadable' in last) && until(last)) return true;
    }
    return false;
  };
  while (Date.now() < deadline && !signal.aborted) {
    last = await look();
    if ('unreadable' in last) { await pause(2_000); continue; }
    const seen = last;
    if (seen.draw) {
      sawPostGame = true;
      if (seen.draw.way === 'coin') {
        // Three drags that the stage did not take: the lab waits on, for the stage's own bound and its Continue.
        if (coins >= 3) { coin = 'stayed'; await pause(2_000); continue; }
        coins++;
        await shoot('draw-coin');
        const { x, y, to } = seen.draw;
        await page.evaluate(pointer, { type: 'pointerdown', x, y });
        for (let move = 1; move <= 12; move++) { await pause(40); await page.evaluate(pointer, { type: 'pointermove', x, y: y + (to - y) * move / 12 }); }
        await page.evaluate(pointer, { type: 'pointerup', x, y: to });
        did(`dragged the coin from ${Math.round(x)},${Math.round(y)} down to ${Math.round(to)} (try ${coins})`);
        if (await waitFor(COIN_GOES_IN_MS, now => now.draw?.way !== 'coin')) { coin = 'went-in'; did('the coin went in'); }
        else coin = 'stayed';
        continue;
      }
      if (seen.draw.way === 'hold' && holds < 2) {
        holds++;
        await shoot('draw-before-hold');
        const { x, y } = seen.draw;
        await page.evaluate(pointer, { type: 'pointerdown', x, y });
        // What the scene says of itself under the press tells a deaf page from a hold that began.
        await pause(800);
        const under = await look(), heard = 'unreadable' in under ? 'unreadable' : under.draw && 'state' in under.draw ? String(under.draw.state) : under.draw ? under.draw.way : 'off the draw';
        await pause(HOLD_MS - 800);
        await page.evaluate(pointer, { type: 'pointerup', x, y });
        did(`held ${HOLD_MS} ms at ${Math.round(x)},${Math.round(y)} (try ${holds}); the scene said "${String(seen.draw.state)}" before and "${heard}" under the press`);
        if (await waitFor(HOLD_SETTLES_MS, now => now.draw === null)) { hold = 'went-on'; did('the hold took the page on'); }
        else { hold = 'did-nothing'; await shoot('draw-after-hold'); }
        continue;
      }
      if (seen.draw.way === 'hold') {
        // Two holds did nothing: go on by the page's own way for a keyboard, so that the book is still met.
        await page.evaluate(press, 'Continue to your collectables');
        did('the holds did nothing: pressed the page\'s "Continue to your collectables"');
        await waitFor(HOLD_SETTLES_MS, now => now.draw === null);
        continue;
      }
      if (seen.draw.way === 'continue') {
        // "Drawing the winners…" has a Continue that goes past the draw: the wheel is waited for first.
        if (seen.draw.drawing && Date.now() - (drawingSince ||= Date.now()) < DRAW_COMES_MS) { await pause(2_000); continue; }
        await page.evaluate(press, 'Continue');
        did(seen.draw.drawing ? `the winners were not drawn within ${DRAW_COMES_MS / 60_000} minutes: pressed Continue past the draw` : `the draw showed words and a Continue ("${seen.text.slice(0, 100)}"): pressed it`);
        await pause(2_000);
        continue;
      }
    } else if (seen.collectables === 'book' && seen.book) {
      sawPostGame = true;
      if (seen.book.shut) { book = 'closed'; ended = 'the book is shut'; break; }
      if (seen.book.hidden || seen.book.top > seen.height - 40) { await pause(1_000); continue; }
      // The book comes up from below: take its cover once it lies still.
      const before = seen.book;
      await pause(700);
      const steady = await look();
      if ('unreadable' in steady || !steady.book || Math.abs(steady.book.top - before.top) > 1 || Math.abs(steady.book.left - before.left) > 1) continue;
      if (drags >= 2) { book = 'still-open'; ended = 'the book stayed open after two drags of its cover'; break; }
      drags++;
      await shoot('book-open');
      const { from, to, y } = coverDrag(steady.book, steady);
      await page.evaluate(pointer, { type: 'pointerdown', x: from, y, onto: '.pocket-book' });
      await pause(200);
      for (let move = 1; move <= 14; move++) { await page.evaluate(pointer, { type: 'pointermove', x: from + (to - from) * move / 14, y, onto: '.pocket-book' }); await pause(60); }
      // The cover follows the finger with a lag: keep it there before letting go.
      await pause(700);
      await shoot('book-cover-across');
      await page.evaluate(pointer, { type: 'pointerup', x: to, y, onto: '.pocket-book' });
      did(`dragged the cover from ${Math.round(from)} to ${Math.round(to)} at ${Math.round(y)} (try ${drags})`);
      if (await waitFor(BOOK_SHUTS_MS, now => now.book?.shut === true || now.collectables === null)) { book = 'closed'; ended = 'the book is shut'; did('the book shut'); await pause(3_000); await shoot('book-shut'); break; }
      continue;
    } else if (seen.collectables === 'nothing') {
      sawPostGame = true;
      book = 'nothing-to-keep';
      await shoot('collectables-nothing');
      await page.evaluate(press, 'Continue');
      ended = `nothing to keep ("${seen.text.slice(0, 140)}"): pressed Continue`; did(ended);
      break;
    } else if (seen.collectables === 'restart') { sawPostGame = true; ended = `the collectables screen asks for a restart ("${seen.text.slice(0, 140)}")`; break; }
    else if (seen.collectables === 'waiting') sawPostGame = true;
    else if (sawPostGame) { ended = `the page went on to ${seen.path}`; break; }
    else { ended = `the page is on ${seen.path}, not on a screen after a game`; break; }
    await pause(1_500);
  }
  if (ended === 'the wait ran out' && !('unreadable' in last)) ended = `the wait ran out on ${last.path} ("${last.text.slice(0, 140)}")`;
  return { coin, hold, book, ended, trail, last };
}
