// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readDocumentEvidence } from '../../lab/flows/post-game-capture.ts';
const page = { evaluate: async (read: (arg: unknown) => unknown, arg: unknown) => new Function('arg', `return (${read.toString()})(arg)`)(arg) } as unknown as BrowserPage;
const snapshot = async (since = 100) => (await readDocumentEvidence(page, since))!;
beforeEach(() => { sessionStorage.clear(); document.body.innerHTML = '<div role="dialog" aria-label="Debug logs"></div>'; vi.stubGlobal('performance', { timeOrigin: 50, getEntriesByType: () => [{type:'navigate'}] }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('captures timeOrigin against since and refuses missing, malformed and nonfinite origins', async () => {
  expect((await snapshot()).signals).toMatchObject({timeOrigin:50,timeOriginValid:true,documentBeforePayoff:true});
  for (const origin of [100, 150]) { vi.stubGlobal('performance',{timeOrigin:origin}); expect((await snapshot()).signals.documentBeforePayoff).toBe(false); }
  for (const origin of [undefined, 'private-fixture', NaN, Infinity, -1]) { vi.stubGlobal('performance',{timeOrigin:origin}); expect((await snapshot()).signals).toMatchObject({timeOrigin:-1,timeOriginValid:false,documentBeforePayoff:false}); }
});
it('encodes navigate/reload/back_forward numerically and never exports an unknown navigation type', async () => {
  for (const [type, encoded] of [['navigate',1],['reload',2],['back_forward',3],[undefined,0],['private-fixture',0],[42,0]] as const) {
    vi.stubGlobal('performance',{timeOrigin:50,getEntriesByType:()=>[{type}]});expect((await snapshot()).signals.navigationType).toBe(encoded);
  }
  vi.stubGlobal('performance',{timeOrigin:50,getEntriesByType:()=>[]});expect((await snapshot()).signals.navigationType).toBe(0);
});
it('reads the exact self-reload budget key and counts only finite numeric stamps at or after since', async () => {
  expect((await snapshot()).signals).toMatchObject({reloadStorageReadable:true,reloadDataValid:true,reloadCount:0,reloadLatest:-1});
  sessionStorage.setItem('jollity:host-reloads','[50,100,101]');expect((await snapshot()).signals).toMatchObject({reloadDataValid:true,reloadCount:2,reloadLatest:101});
  sessionStorage.setItem('jollity:host-reloads','[50,100,101,"private-fixture",null]');expect((await snapshot()).signals).toMatchObject({reloadDataValid:false,reloadCount:2,reloadLatest:101});
  for (const raw of ['{','{}','"private-fixture"']) {sessionStorage.setItem('jollity:host-reloads',raw);expect((await snapshot()).signals).toMatchObject({reloadDataValid:false,reloadCount:-1,reloadLatest:-1});}
});
it('captures postGame presence only, including malformed content, without returning its value', async () => {
  expect((await snapshot()).signals.postGamePresent).toBe(false);
  for (const raw of ['', '{', '{"identity":"private-fixture"}']) { sessionStorage.setItem('jollity.postGame',raw);expect((await snapshot()).signals).toMatchObject({postGamePresent:true,postGameStorageReadable:true}); }
});
it('reads the exact crash-reload key as a nonnegative integer and marks malformed values invalid', async () => {
  expect((await snapshot()).signals).toMatchObject({crashStorageReadable:true,crashDataValid:true,crashReload:0});
  sessionStorage.setItem('jollity.crash-reload','3');expect((await snapshot()).signals).toMatchObject({crashDataValid:true,crashReload:3});
  for (const raw of ['1.5','-1','Infinity','private-fixture','{}']) {sessionStorage.setItem('jollity.crash-reload',raw);expect((await snapshot()).signals).toMatchObject({crashDataValid:false,crashReload:-1});}
});
it('counts the complete debug ring and reconstructs its oldest UI timestamp, with absent/empty/malformed controls', async () => {
  expect((await snapshot()).signals).toMatchObject({ringReadable:true,ringCount:0,ringOldest:-1});
  const oldest=Date.now()-10_000, d=new Date(oldest), stamp=d.toLocaleTimeString('en-GB',{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0');
  document.querySelector('[role="dialog"]')!.innerHTML=`<div class="border-b"><div><span>${stamp}</span><span>[unrelated]</span><span>private-fixture</span></div></div><div class="border-b"><div><span>malformed</span><span>[reload]</span><span>ignored</span></div></div>`;
  expect((await snapshot()).signals).toMatchObject({ringReadable:true,ringCount:2,ringOldest:oldest});
  document.querySelector('[role="dialog"]')!.innerHTML='<div class="border-b"><div><span>malformed</span><span>[reload]</span><span>ignored</span></div></div>';
  expect((await snapshot()).signals).toMatchObject({ringCount:1,ringOldest:-1});document.body.innerHTML='';expect((await snapshot()).signals).toMatchObject({ringReadable:false,ringCount:-1,ringOldest:-1});
});
it('@negative-control marks inaccessible storage unavailable, rather than treating it as empty', async () => {
  vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('private-fixture');});
  expect((await snapshot()).signals).toMatchObject({reloadStorageReadable:false,reloadDataValid:false,reloadCount:-1,postGameStorageReadable:false,postGamePresent:false,crashStorageReadable:false,crashReload:-1});
});
it('@negative-control new evidence contains only finite numbers and booleans, never storage text, queries or identity', async () => {
  window.history.replaceState(null,'','/chest?identity=private-fixture');sessionStorage.setItem('jollity.postGame','{"secret":"private-fixture"}');sessionStorage.setItem('jollity:host-reloads','[101,"private-fixture"]');
  const record=await snapshot();expect(record.path).toBe('/chest');
  expect(Object.values(record.signals).every(value=>typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))).toBe(true);
  expect(JSON.stringify(record)).not.toMatch(/private-fixture|identity|secret|http/);
});
