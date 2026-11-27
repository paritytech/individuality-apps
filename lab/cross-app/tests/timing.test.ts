// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { assertAddsUp, breakdown, commentSection, label, median, summarize, type Marks } from '../timing.ts';
import { extrinsicHash, frameCarries, FrameProbe, submittedMark } from '../chain-watch.ts';

const best = { app: 'Jollity', head: 'best' as const, how: 'subscription' };
const marks = (over: Partial<Marks> = {}): Marks => ({ direction: 'C2', run: '1', reader: best, tap: 1_000, submitted: 3_000, included: 9_000, includedBlock: 10,
  finalized: 30_000, finalizedBlock: 12, handoff: 9_200, rendered: 9_250, ...over });
const part = (value: ReturnType<typeof breakdown>, name: string) => value.segments.find(s => s.name === name)!;

describe('cross-app labels', () => {
  it('labels at the 45 s and 90 s boundaries', () => {
    expect(label(0)).toBe('ok'); expect(label(45_000)).toBe('ok'); expect(label(45_001)).toBe('slow');
    expect(label(90_000)).toBe('slow'); expect(label(90_001)).toBe('too slow');
  });
  it('a too-slow run is still a result, not a failure', () => {
    const value = breakdown(marks({ rendered: 200_000, handoff: 199_000 }));
    expect(value.label).toBe('too slow'); expect(() => assertAddsUp(value)).not.toThrow();
  });
  it('refuses a negative or non-finite duration', () => { expect(() => label(-1)).toThrow(); expect(() => label(Number.NaN)).toThrow(); });
});

describe('cross-app breakdown', () => {
  it('a best-head reader: finality is shown beside the path and not summed', () => {
    const value = breakdown(marks());
    expect(value.totalMs).toBe(8_250);
    expect(part(value, 'signing').ms).toBe(2_000); expect(part(value, 'inclusion').ms).toBe(6_000);
    expect(part(value, 'finality')).toMatchObject({ ms: 21_000, offPath: true });
    expect(part(value, 'hand-off').ms).toBe(200); expect(part(value, 'render').ms).toBe(50);
    expect(part(value, 'unattributed').ms).toBe(0);
    assertAddsUp(value);
  });
  it('a finalized-head reader: finality is on the path and hand-off starts at finality', () => {
    const value = breakdown(marks({ reader: { ...best, head: 'finalized' }, handoff: 31_000, rendered: 31_100 }));
    expect(part(value, 'finality').offPath).toBeUndefined();
    expect(part(value, 'hand-off').ms).toBe(1_000);
    expect(part(value, 'unattributed').ms).toBe(0);
    assertAddsUp(value);
  });
  it('a missing pool sighting leaves tap-to-inclusion unattributed', () => {
    const value = breakdown(marks({ submitted: undefined }));
    expect(part(value, 'signing').ms).toBeNull(); expect(part(value, 'inclusion').ms).toBeNull();
    expect(part(value, 'unattributed').ms).toBe(8_000);
    assertAddsUp(value);
  });
  it('a missing hand-off frame leaves inclusion-to-render unattributed', () => {
    const value = breakdown(marks({ handoff: undefined, rendered: 39_000 }));
    expect(part(value, 'hand-off').ms).toBeNull(); expect(part(value, 'render').ms).toBeNull();
    expect(part(value, 'unattributed').ms).toBe(30_000);
    assertAddsUp(value);
  });
  it('an out-of-order frame is noted, not counted as negative time', () => {
    const value = breakdown(marks({ handoff: 8_500 }));
    expect(part(value, 'hand-off')).toMatchObject({ ms: null, note: 'marks out of order (-500 ms)' });
    assertAddsUp(value);
  });
  it('refuses a render before the tap and an inclusion before the tap', () => {
    expect(() => breakdown(marks({ rendered: 500 }))).toThrow(/rendered before the tap/);
    expect(() => breakdown(marks({ included: 500 }))).toThrow(/included before the tap/);
  });
  it('negative control: a tampered breakdown fails the sum and label checks', () => {
    const value = breakdown(marks());
    const tampered = { ...value, segments: value.segments.map(s => s.name === 'render' ? { ...s, ms: 5_000 } : s) };
    expect(() => assertAddsUp(tampered)).toThrow(/parts add up to/);
    expect(() => assertAddsUp({ ...value, label: 'slow' })).toThrow(/label slow does not match/);
    expect(() => commentSection([tampered])).toThrow();
  });
});

it('@negative-control: breakdown refuses a non-finite optional mark', () => {
  expect(() => breakdown(marks({ finalized: Infinity }))).toThrow('Non-finite');
  expect(() => breakdown(marks({ submitted: NaN }))).toThrow('Non-finite');
});

describe('cross-app summary', () => {
  it('median and spread per direction', () => {
    expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(3);
    const runs = [breakdown(marks({ run: '1', rendered: 11_000, handoff: 10_000 })), breakdown(marks({ run: '2' })), breakdown(marks({ run: '3', rendered: 61_000, handoff: 60_000 })),
      breakdown(marks({ direction: 'C1', reader: { app: 'Humanity', head: 'best', how: 'poll' }, rendered: 40_000, handoff: 39_000 }))];
    const [c1, c2] = summarize(runs);
    expect(c1).toMatchObject({ direction: 'C1', runs: 1, medianMs: 39_000, label: 'ok' });
    expect(c2).toMatchObject({ direction: 'C2', runs: 3, medianMs: 10_000, minMs: 8_250, maxMs: 60_000, label: 'ok' });
    const section = commentSection(runs);
    expect(section).toContain('Sign up in Humanity, Jollity shows it (C2), run 3: **60.000 s (slow)**');
    expect(section).toContain('| Sign up in Jollity, Humanity shows it (C1) | 1 | 39.000 s | single run |');
    expect(section).toContain('single run)');
    expect(section).toContain('| Sign up in Humanity, Jollity shows it (C2) | 3 | 10.000 s | 8.250 s-60.000 s | ok |');
  });
});

describe('cross-app probes', () => {
  const key = '0x' + 'ab'.repeat(16) + 'cd'.repeat(33);
  it('finds the storage key in JSON text and in raw or hex-text bytes', () => {
    expect(frameCarries(`{"items":[{"key":"${key}","value":"0x01"}]}`, key)).toBe(true);
    expect(frameCarries(Buffer.concat([Buffer.from([1, 2]), Buffer.from(key.slice(2), 'hex')]), key)).toBe(true);
    expect(frameCarries(Buffer.from(`xx${key.toUpperCase().replace('0X', '')}`, 'latin1'), key)).toBe(true);
  });
  it('negative control: another key or a short needle does not match', () => {
    expect(frameCarries(`{"key":"0x${'ab'.repeat(16)}${'ce'.repeat(33)}"}`, key)).toBe(false);
    expect(() => frameCarries('anything', '0xabcd')).toThrow();
  });
  it('keeps only frames from the reading app origin, first at or after a mark', () => {
    const probe = new FrameProbe('http://127.0.0.1:4000', key);
    probe.listener({ at: 5, url: 'http://127.0.0.1:4000/x', payload: key });
    probe.listener({ at: 9, url: 'http://127.0.0.1:4001/', payload: key });
    probe.listener({ at: 12, url: 'http://127.0.0.1:4000/', payload: key });
    probe.listener({ at: 7, url: 'http://127.0.0.1:4000/', payload: 'nothing' });
    expect(probe.hits).toEqual([5, 12]); expect(probe.first(6)).toBe(12); expect(probe.first(13)).toBeUndefined();
  });
  it('submitted is the newest pool sighting among the block extrinsics, undefined when the pool missed them', () => {
    const a = '0x0102', b = '0x0304', pool = new Map([[extrinsicHash(a), 100], [extrinsicHash(b), 300]]);
    expect(submittedMark([a, b, '0x05'], pool)).toBe(300);
    expect(submittedMark(['0x05'], pool)).toBeUndefined();
  });
});

it('retains chronological signing and lab-click intervals without counting the click twice', () => {
  const value = breakdown(marks({ actions: [{ name: 'lab Register click', at: 1000, done: 1200 }] }));
  expect(part(value, 'signing').ms).toBe(1800);
  expect(part(value, 'signing').spans).toEqual([{ start: 1200, end: 3000 }]);
  expect(part(value, 'lab Register click').ms).toBe(200);
  assertAddsUp(value);
  const moved = structuredClone(value);
  part(moved, 'lab Register click').spans = [{ start: 1200, end: 1400 }];
  expect(() => assertAddsUp(moved)).toThrow('Overlapping or incomplete');
});
