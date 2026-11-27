// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { capturePostGameEntry, projectEntry, projectNavigations } from '../../lab/flows/post-game-capture.ts';
import { readChest } from '../../lab/flows/post-game.ts';
function page() {
  return { evaluate: async (read: (arg: unknown) => unknown, arg: unknown) => new Function('arg', `return (${read.toString()})(arg)`)(arg),
    locator: () => ({ evaluate: async (read: (body: Element, arg: unknown) => unknown, arg: unknown) => new Function('body','arg', `return (${read.toString()})(body,arg)`)(document.body,arg), press: async () => {} }),
    getByRole: () => ({ waitFor: async () => {}, evaluate: async (read: (el: Element, arg: unknown) => unknown, arg: unknown) => new Function('el','arg', `return (${read.toString()})(el,arg)`)(document.querySelector('[role="dialog"]')!,arg) }) } as unknown as BrowserPage;
}
it('reads the actual shipped debug-row DOM before recovery and retains only diagnostic fields', async () => {
  window.history.replaceState(null, '', '/?password=private-fixture');
  document.body.innerHTML = '<div role="dialog" aria-label="Debug logs"></div>';
  const since = Date.now()-1000, stamp = (ts: number) => { const d=new Date(ts);return d.toLocaleTimeString('en-GB',{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0'); };
  for (const entry of [
    { ts: since-500, tag: 'reload', message: 'reloading the app', data: { reason: 'left-product' } },
    { ts: since+100, tag: 'front-door', message: 'a page load came in past home — home first', data: { href: '/chest?game=308&password=private-fixture' } },
    { ts: since+200, tag: 'reload', message: 'reloading the app', data: { reason: 'host-channel', reload: 1, password: 'private-fixture', seed: 'discard this field' } },
    { ts: since+300, tag: 'unrelated', message: 'private-fixture', data: {} } ]) {
    const line=document.createElement('div');line.className='border-b';
    const header=document.createElement('div');for(const value of [stamp(entry.ts), '['+entry.tag+']',entry.message]) {const span=document.createElement('span');span.textContent=value;header.append(span);}
    const pre=document.createElement('pre');pre.textContent=JSON.stringify(entry.data);line.append(header,pre);document.querySelector('[role="dialog"]')!.append(line);
  }
  const result = await capturePostGameEntry(page(), 'alice', since, [{ actorId:'alice',fromApp:'dim2',toApp:'peopl',requestedAt:since+250,outcome:'opened',path:'/?password=private-fixture',error:'discard this field' }]);
  expect(result.path).toBe('/');expect(result.devLog.entries).toHaveLength(2);
  expect(result.devLog.entries[0]).toMatchObject({ tag:'front-door',path:'/chest' });
  expect(result.devLog.entries[1]).toMatchObject({ tag:'reload',reason:'host-channel',reload:1 });
  expect(result.hostNavigations).toHaveLength(1);expect(result.selfReloadMetrics.status).toContain('unavailable');
  expect(JSON.stringify(result)).not.toMatch(/private-fixture|discard this field|password|seed/);
});
it('@negative-control strips arbitrary messages, payloads, paths and other actors from capture', () => {
  const privatePath=['','Users','private-person','state'].join('/');
  const entry=projectEntry({ts:10,tag:'reload',message:privatePath,data:{reason:privatePath,href:privatePath,password:'secret fixture'}},0);
  expect(entry).toEqual({ts:10,tag:'reload',message:'[other diagnostic message]',path:'[other route]'});
  expect(projectEntry({ts:10,tag:'reload',message:'reloading the app',data:'null'},0)).toEqual({ts:10,tag:'reload',message:'reloading the app'});
  expect(projectEntry({ts:1,tag:'reload',message:'reloading the app'},2)).toBeUndefined();
  expect(projectNavigations([{actorId:'bob',fromApp:'dim2',requestedAt:10,path:privatePath}],'alice',0)).toEqual([]);
});
it('reads the no-identity and slow markers from real DOM rather than an enabled exit alone', async () => {
  window.history.replaceState(null,'','/chest?game=308');
  document.body.innerHTML='<h1>The chest</h1><p>No player identity here — open Jollity in the Polkadot app</p><button>Continue</button>';
  Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => document.body.textContent ?? '' });
  let view=await readChest(page());expect(view?.noIdentity).toBe(true);expect(view?.gameLabel).toBe(false);
  document.body.innerHTML='<main data-testid="chest-slow"><h1>Taking longer than usual</h1><button>Continue</button></main>';
  const marker=document.querySelector('main')!;marker.getClientRects=()=>({length:1}) as DOMRectList;
  view=await readChest(page());expect(view?.slow).toBe(true);
});

it('matches the CSS-uppercase GAME label while requiring the selected game and real chest heading', async () => {
  window.history.replaceState(null,'','/chest?game=308');document.body.innerHTML='<div>Game #308</div><h1>The chest</h1><button>Continue</button>';
  Object.defineProperty(document.body,'innerText',{configurable:true,value:'GAME #308\nThe chest\nContinue'});
  document.querySelector('h1')!.getClientRects=()=>({length:1}) as DOMRectList;
  expect(await readChest(page())).toMatchObject({heading:true,gameLabel:true});
});
