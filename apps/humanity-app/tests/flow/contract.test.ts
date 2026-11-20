// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { it, expect } from 'vitest';
import { assertFlowReport, requireThree } from '../../lab/flows/contract.ts';
import { cardReady, firstAppFailure, bindRetryWatch, holdBindRetries, type View } from '../../lab/flows/guards.mjs';
const keys = ['0x'+'01'.repeat(32),'0x'+'02'.repeat(32),'0x'+'03'.repeat(32)];
it('admits exactly three distinct owned game accounts', () => {
  requireThree([...keys].reverse(), keys);
  for (const actual of [keys.slice(1),[...keys, '0x'+'04'.repeat(32)],[keys[0]!,keys[0]!,keys[2]!]]) expect(() => requireThree(actual,keys)).toThrow(/exactly the three/);
});
const report = (control: boolean) => [{ elements: [{ type: 'scenario', steps: Array.from({length: control ? 20 : 22}, (_,i) => ({ name: control && i === 19 ? 'Alice has 3 DIM2 credits to keep on chain' : 'earlier step', result: { status: control && i === 19 ? 'failed' : 'passed', error_message: control && i === 19 ? 'not-on-chain: 2 DIM2 credits to keep, not 3' : '' } })) }] }];
it('accepts a complete positive and the exact late control failure', () => { assertFlowReport(report(false),false); assertFlowReport(report(true),true); });
it('@negative-control: rejects early, skipped, missing and wrong failures', () => {
  const early = report(true); early[0]!.elements[0]!.steps[0]!.result.status = 'failed';
  const skip = report(false); skip[0]!.elements[0]!.steps[4]!.result.status = 'skipped';
  const wrong = report(true); wrong[0]!.elements[0]!.steps.at(-1)!.result.error_message = 'RPC timeout';
  const missing = report(false); missing[0]!.elements[0]!.steps.pop();
  for (const [r,control] of [[early,true],[skip,false],[wrong,true],[missing,false],[report(false),true]] as const) expect(() => assertFlowReport(r,control)).toThrow();
});
it('accepts Candidates with enabled registration and refuses closed or disabled cards', () => {
  const card: View = { markers: [{id:'humanity-home',attrs:{'data-card-state':'candidate'}}], buttons:[{disabled:false,text:'Register',aria:''}],text:'' };
  expect(cardReady(card)).toBe(true);
  expect(cardReady({...card,buttons:[{...card.buttons[0]!,disabled:true}]})).toBe(false);
  expect(cardReady({...card,text:'Registration has closed'})).toBe(false);
});
it('allows a bind retry only on the actor\'s timely finalized alias, retaining other failures', async () => {
  const records: unknown[] = [];
  const watcher = bindRetryWatch({ aliasContext:'ours',record:r => records.push(r),accountFor:() => keys[0]!,readAlias: async () => ({value:{ca:{context:'ours'}},readAt:100,block:{number:12,hash:'final'}}),now:()=>100 });
  holdBindRetries(watcher.hold);
  expect(firstAppFailure('bind failed, retrying (Stale)',{actor:'Alice',via:'test'})).toBeNull();
  await watcher.idle(); watcher.overdue(); expect(records).toHaveLength(1);
  expect(firstAppFailure('bind refused for good',{actor:'Alice',via:'test'})).toBeTruthy();
  expect(firstAppFailure('bind failed, retrying\nregistration failed',{actor:'Alice',via:'test'})).toContain('registration failed');
  holdBindRetries(null);
});
it('@negative-control: a wrong context, unreadable alias or late read stays fatal', async () => {
  for (const variant of ['wrong','late','rpc']) {
    let now = 100;
    const watcher = bindRetryWatch({aliasContext:'ours',record:()=>{},accountFor:()=>keys[0]!,now:()=>now,windowMs:10,wait:async()=>{now+=11;},readAlias:async()=> {
      if (variant==='rpc') throw new Error('unreadable');
      return {value:{ca:{context:variant==='wrong'?'theirs':'ours'}},readAt:variant==='late'?111:now,block:{number:12,hash:'final'}};
    }});
    watcher.observe('bind failed, retrying (Stale)',{actor:'Alice',via:'test'}); await watcher.idle(); expect(()=>watcher.overdue()).toThrow(/finalized/);
  }
});
