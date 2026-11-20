// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Admission checks for the displayed game and first app failure.
// A lite player's card is either devicehood (labelled Person; no game played yet) or candidate (a returning player
// below the threshold). Both offer the same Register.
export function cardState(card) {
 return card.markers.find(m=>m.id==='humanity-home')?.attrs['data-card-state']??card.markers.find(m=>m.id==='membership-card')?.attrs['data-card-state']??null;
}
export function cardReady(card) {
 return (card.markers.some(m=>m.id==='humanity-home'&&/^(devicehood|candidate)$/.test(m.attrs['data-card-state']??'')) || /^(person|devicehood|candidate)$/i.test(card.card?.status??''))
  && card.buttons.some(b=>!b.disabled&&/^(Register|Open the game)$/i.test((b.aria||b.text||'').trim()))
  && !/registration has closed|game is under way/i.test(card.text);
}
const pattern=/(?:linking the name failed|name link (?:failed|unfunded|not-signed|skipped|timed out)|cannot pay the link's deposit|bind failed|bind refused for good|registration failed|sign-up failed|report failed|host path failed|A new version is out|Your Humanity card isn't available right now)/i;
// The same patterns without "bind failed": a held bind-retry entry still fails on any of these.
const otherPattern=/(?:linking the name failed|name link (?:failed|unfunded|not-signed|skipped|timed out)|cannot pay the link's deposit|bind refused for good|registration failed|sign-up failed|report failed|host path failed|A new version is out|Your Humanity card isn't available right now)/i;
let holdBindRetry=null;
export function holdBindRetries(hold){holdBindRetry=hold;}
// source: {actor, via}, the actor whose app produced the text and the reader that read it. A held entry is attributed
// to the first reader's actor, whichever reader that is.
export function firstAppFailure(text,source) {
 const lines=text.split('\n'),held=new Set();
 if(holdBindRetry)for(const entry of bindRetries(text))if(holdBindRetry(entry,source))for(let k=entry.from;k<=entry.to;k++)held.add(k);
 return lines.find((line,k)=>pattern.test(line)&&!(held.has(k)&&!otherPattern.test(line)))??null;
}
// A DIM2 bind-retry entry stays a failure unless the actor's PeopleLite alias for its game account
// is independently read at a finalized block within 60 seconds of the line. A matching alias makes
// it a recorded warning. An app log or a later success line is insufficient. Other failures stay fatal.
const retryLine=/^bind failed, retrying\b/i,stampLine=/^\d\d:\d\d:\d\d\.\d{3}$/;
export function bindRetries(text){
 const lines=text.split('\n'),out=[];
 for(let k=0;k<lines.length;k++){
  const line=lines[k].trim();if(!retryLine.test(line))continue;
  let s=k-1;while(s>=Math.max(0,k-2)&&!stampLine.test(lines[s].trim()))s--;
  const stamp=s>=0&&stampLine.test(lines[s].trim())?lines[s].trim():null;
  // The entry's JSON detail ("lite bind failed: ...") belongs to it: a top-level { ... } block right after the line.
  let to=k;if(lines[k+1]==='{'){const end=lines.indexOf('}',k+2);if(end>0)to=end;}
  const detail=lines.slice(k+1,to+1).join('\n');
  out.push({key:[stamp,line,detail].join('\n'),stamp,line,detail,from:k,to});
 }
 return out;
}
function lineTime(stamp,seenAt){
 if(!stamp)return seenAt;
 const [h,m,rest]=stamp.split(':'),[sec,ms]=rest.split('.'),d=new Date(seenAt);d.setHours(+h,+m,+sec,+ms);
 let at=d.getTime();if(at>seenAt+5000)at-=86400000;return Math.min(at,seenAt);
}
// The first flow-monitor or gameplay reader attributes an entry and starts its finalized alias read.
// An unattributed entry, or one shown by two actors, is fatal. overdue() raises expired entries.
export function bindRetryWatch({readAlias,aliasContext,record,accountFor=()=>undefined,now=()=>Date.now(),wait=ms=>new Promise(r=>setTimeout(r,ms)),pollMs=1000,windowMs=60000,signal}){
 const entries=new Map();
 const entryFor=entry=>{if(!entries.has(entry.key)){const seenAt=now(),lineAt=lineTime(entry.stamp,seenAt);entries.set(entry.key,{...entry,seenAt,lineAt,deadline:lineAt+windowMs,state:'pending',actor:null,account:null,reads:0});}return entries.get(entry.key);};
 const fatal=(held,why)=>{if(held.state!=='fatal'){held.state='fatal';held.error=Error((held.actor?held.actor+': ':'')+held.line+' ('+why+')');}return held.error;};
 const lateWhy=held=>'no finalized PeopleLite alias for '+held.account+' read within 60 s of the line';
 async function readLoop(held){
  try{
   while(held.state==='pending'&&!signal?.aborted){
    if(now()>held.deadline){fatal(held,lateWhy(held));return;}
    const found=await readAlias(held.account);held.reads++;
    if(held.state!=='pending')return;
    if(found.readAt>held.deadline){fatal(held,lateWhy(held));return;}
    if(found.value&&found.value.ca?.context===aliasContext){
     held.state='warning';
     record({type:'app-bind-warning',actor:held.actor,account:held.account,line:held.line,lineTimestamp:held.stamp,lineAt:new Date(held.lineAt).toISOString(),detail:held.detail,
      firstSeenBy:held.firstSeenBy,firstSeenAt:new Date(held.seenAt).toISOString(),attributedBy:held.attributedBy,attributedAt:new Date(held.attributedAt).toISOString(),
      deadline:new Date(held.deadline).toISOString(),reads:held.reads,
      finalizedBlock:found.block.number,finalizedHash:found.block.hash,aliasKey:found.key,aliasRaw:found.raw,readAt:new Date(found.readAt).toISOString()});
     return;
    }
    await wait(Math.max(0,Math.min(pollMs,held.deadline-now()+1)));
   }
  }catch(error){fatal(held,'finalized alias read failed: '+error.message);}
 }
 // Attribute an entry to the actor whose app showed it, and start its read. Returns the held entry.
 const see=(entry,source)=>{
  const held=entryFor(entry);held.firstSeenBy??=source?.via??'unattributed reader';
  const actor=source?.actor;if(!actor||held.state==='fatal')return held;
  if(held.actor&&held.actor!==actor){fatal(held,'shown by both '+held.actor+' and '+actor+'; not attributable to one actor');return held;}
  if(held.actor)return held;
  const account=source.account??accountFor(actor);if(!account)return held;
  Object.assign(held,{actor,account,attributedBy:source.via??'unnamed reader',attributedAt:now()});
  if(held.state==='pending')held.reading=readLoop(held);
  return held;
 };
 return {
  entries,
  hold:(entry,source)=>see(entry,source).state!=='fatal',
  // Attribute every entry in a text without judging the text (a capture that is checked later, or not at all).
  observe(text,source){for(const entry of bindRetries(text))see(entry,source);},
  // Attribute, then raise this text's fatal entries. A pending read keeps running in the background.
  async settle(actor,account,text,via='flow monitor'){
   for(const entry of bindRetries(text)){const held=see(entry,{actor,account,via});if(held.state==='fatal')throw held.error;}
  },
  // Every read started so far, finished (offline controls and orderly ends).
  async idle(){for(;;){const open=[...entries.values()].filter(h=>h.reading&&h.state==='pending');if(!open.length)return;await Promise.all(open.map(h=>h.reading));}},
  overdue(){for(const held of entries.values()){
   if(held.state==='pending'&&now()>held.deadline)fatal(held,held.actor?lateWhy(held):'not attributed to an actor, so no finalized alias read within 60 s of the line');
   if(held.state==='fatal')throw held.error;
  }},
 };
}
