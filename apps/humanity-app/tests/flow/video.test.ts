// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { it, expect } from 'vitest';
import { selectDemos, videoSegments } from '../../lab/flows/demo.mjs';
const recording = () => ({ id:'humanity-dim2-custom-flow',kind:'feature',feature:{uri:'lab/flows/humanity-dim2.feature'},status:'passed',startedAt:100,finishedAt:1000,
  actors:['alice','bob','carol'].map(id => ({id,role:id})), steps:[], capture:{videos:['alice','bob','carol'].flatMap((actor,i) => [
    {actor,file:`videos/${actor}-humanity.webm`,openedAt:50+i}, {actor,file:`videos/${actor}-dim2.webm`,openedAt:500+i}])} });
it('retains every actor and stitches Humanity into DIM2 at the handoff', () => {
  const jobs = selectDemos([recording()],{journeyStatus:'passed'}); expect(jobs).toHaveLength(3);
  const parts = videoSegments(jobs[0]); expect(parts).toHaveLength(2); expect(parts[0]!.end).toBe(parts[1]!.start); expect(parts[0]!.offsetMs).toBe(50);
});
it('runs the last page past the last step to its measured close, and only to that', () => {
  const closed = recording(); for (const video of closed.capture.videos as Array<{ closedAt?: number }>) video.closedAt = 1400;
  const parts = videoSegments(selectDemos([closed],{journeyStatus:'passed'})[0]);
  // The Humanity page still ends at the DIM2 opening; the DIM2 page keeps 400 ms after the last step.
  expect(parts.map(part => part.end)).toEqual([500, 1400]);
  expect(videoSegments(selectDemos([recording()],{journeyStatus:'passed'})[0]).at(-1)!.end).toBe(1000);
  // A close before the last step is not a tail.
  for (const video of closed.capture.videos as Array<{ closedAt?: number }>) video.closedAt = 900;
  expect(videoSegments(selectDemos([closed],{journeyStatus:'passed'})[0]).at(-1)!.end).toBe(1000);
});
it("cuts only the app's own record when product-lab saves its own recording of the same feature", () => {
  // Product-lab 0.1.2's own recording with --video: same feature, an id of its own, and all six page videos.
  const framework = { ...recording(), id:'1762870000000-humanity-dim2', frames:[{ id:'f1', featureStep:2, phase:'after', status:'captured', overlapping:[] }] };
  expect(selectDemos([framework, recording()],{journeyStatus:'passed'}).map(job => job.id)).toEqual(Array(3).fill('humanity-dim2-custom-flow'));
  expect(selectDemos([framework],{journeyStatus:'passed'})).toEqual([]);
  // The negative control's record has the same id and its own feature; its demos are always diagnostic.
  const control = { ...recording(), feature:{uri:'lab/flows/humanity-dim2-wrong-credits.feature'} };
  const jobs = selectDemos([{ ...framework, feature: control.feature }, control],{failed:true,journeyStatus:'failed'});
  expect(jobs.map(job => [job.id, job.failed])).toEqual(Array(3).fill(['humanity-dim2-custom-flow', true]));
});
it('@negative-control: refuses missing actor videos and never relabels diagnostic footage as a pass', () => {
  const r = recording(); r.capture.videos = r.capture.videos.filter(v => v.actor !== 'carol');
  expect(()=>selectDemos([r],{journeyStatus:'passed'})).toThrow(/missing actor videos/);
  expect(selectDemos([recording()],{journeyStatus:'failed'}).every(j => j.failed)).toBe(true);
});
it('cuts videos stored next to recording directories, matching the installed lab store', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { cutDemos } = await import('../../lab/flows/demo.mjs');
  const dir = mkdtempSync(join(tmpdir(),'flow-video-contract-'));
  try {
    const r = recording(); mkdirSync(join(dir,'runs','one'),{recursive:true}); mkdirSync(join(dir,'runs','videos'));
    writeFileSync(join(dir,'runs','one','recording.json'),JSON.stringify(r));
    for (const v of r.capture.videos) writeFileSync(join(dir,'runs',v.file),'video fixture');
    const result = cutDemos({runsDir:join(dir,'runs'),out:join(dir,'out'),workDir:join(dir,'edit')},(bin:string) => bin === 'ffprobe' ? '10' : '{}');
    expect(result.errors).toEqual([]); expect(result.demos).toHaveLength(3);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
