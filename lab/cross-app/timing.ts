// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { plainName } from './names.ts';
/**
 * Cross-app timing: one registration made in one app, timed until the other app shows it.
 * Pure math over wall-clock marks (Unix ms, one machine clock): the session's chain watch,
 * socket probe and DOM waits supply the marks, this module turns them into a breakdown.
 */

export type Direction = 'C6' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'B1' | 'B2' | 'B3' | 'U3' | 'U4';
export type Label = 'ok' | 'slow' | 'too slow';
export const thresholds = { okMs: 45_000, slowMs: 90_000 } as const;

/** How the reading app gets the registration: the head it reads and how it learns of a new value. */
export interface Reader {
  app: string;
  head: 'best' | 'finalized';
  how: string;
}

export interface Marks {
  direction: 'C1' | 'C2';
  run: string;
  reader: Reader;
  /** Just before the trusted click on Register. */
  tap: number;
  /** First seen in the node's pool (`author_pendingExtrinsics`), when the poll caught it. */
  submitted?: number;
  /** The lab's chainHead subscription first reporting the best block that holds the registration. */
  included: number;
  includedBlock: number;
  /** The best block that first showed the registration later lost a reorg to a sibling at the same height. */
  includedRetracted?: true;
  /** The lab first reporting a finalized block at or above `includedBlock` that holds the registration. */
  finalized?: number;
  finalizedBlock?: number;
  /** The first socket frame into the reading app's page that carries the registration's storage key. */
  handoff?: number;
  /** The reading app's DOM first showing the registered state. */
  rendered: number;
  actions?: Array<{ name: string; at: number; done: number }>;
}

export interface Segment {
  name: string;
  ms: number | null;
  /** Off the critical path: shown, never summed. */
  offPath?: boolean;
  note?: string;
  spans?: Array<{ start: number; end: number }>;
}

export interface Breakdown {
  direction: Direction;
  metric?: string;
  run: string;
  reader: Reader;
  totalMs: number;
  label: Label;
  includedBlock?: number;
  /** The lab's best block lost a reorg; its time stands, its body was pruned before the lab read it. */
  includedRetracted?: true;
  finalizedBlock?: number;
  segments: Segment[];
}

export function label(ms: number): Label {
  if (!Number.isFinite(ms) || ms < 0) throw Error(`Invalid duration ${ms}`);
  return ms <= thresholds.okMs ? 'ok' : ms <= thresholds.slowMs ? 'slow' : 'too slow';
}

/**
 * The critical path is tap -> submitted -> included -> [finalized, only for a finalized reader] -> hand-off -> rendered.
 * A mark that is missing, or earlier than the mark kept before it, or later than the render, is dropped; a part counts
 * only between two adjacent kept marks, so parts never overlap. For a best-head reader finality runs beside the path:
 * it is reported and not summed. Whatever the counted parts do not cover is "unattributed", so they add up to the total.
 */
export function assertFiniteNumbers(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Non-finite timing mark');
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertFiniteNumbers(child);
}

const retractedSigning = 'not measured: the best block that first showed it lost a reorg, so the lab could not read which transaction it held';

export function breakdown(marks: Marks): Breakdown {
  assertFiniteNumbers(marks);
  const totalMs = marks.rendered - marks.tap;
  if (!Number.isFinite(totalMs) || totalMs < 0) throw Error(`${marks.direction} run ${marks.run}: rendered before the tap`);
  if (marks.included < marks.tap) throw Error(`${marks.direction} run ${marks.run}: included before the tap`);
  const onFinality = marks.reader.head === 'finalized';
  const points: Array<{ part: Segment['name'] | null; at: number | undefined }> = [
    { part: null, at: marks.tap }, { part: 'signing', at: marks.submitted }, { part: 'inclusion', at: marks.included },
    ...(onFinality ? [{ part: 'finality' as const, at: marks.finalized }] : []), { part: 'hand-off', at: marks.handoff }, { part: 'render', at: marks.rendered }];
  const path: Segment[] = [];
  let lastAt = marks.tap, previousKept = true;
  for (const point of points.slice(1)) {
    const name = point.part!;
    if (point.at === undefined || !Number.isFinite(point.at)) { path.push({ name, ms: null, note: name === 'signing' && marks.includedRetracted ? retractedSigning : 'not measured' }); previousKept = false; continue; }
    const late = name !== 'render' && point.at > marks.rendered;
    if (point.at < lastAt || late) {
      path.push({ name, ms: null, note: `marks out of order (${point.at - (late ? marks.rendered : lastAt)} ms)` }); previousKept = false; continue;
    }
    path.push(previousKept ? { name, ms: point.at - lastAt, spans: [{ start: lastAt, end: point.at }] } : { name, ms: null, note: 'previous mark not measured' });
    lastAt = point.at; previousKept = true;
  }
  if (!onFinality) {
    const ms = marks.finalized === undefined ? null : marks.finalized - marks.included;
    path.splice(2, 0, { name: 'finality', ms: ms !== null && ms >= 0 ? ms : null, offPath: true,
      note: marks.finalized === undefined || !Number.isFinite(marks.finalized) ? 'not measured' : ms! < 0 ? 'marks out of order' : `${marks.reader.app} reads the best head; lab-observed, upper bound` });
  }
  applyActions(path, marks.actions ?? [], marks.tap, marks.rendered);
  const summed = path.filter(s => !s.offPath && s.ms !== null).reduce((sum, s) => sum + s.ms!, 0);
  const unattributed = totalMs - summed;
  if (unattributed < 0) throw Error(`${marks.direction} run ${marks.run}: parts exceed the total by ${-unattributed} ms`);
  path.push({ name: 'unattributed', ms: unattributed, spans: residualSpans(path, marks.tap, marks.rendered) });
  return { direction: marks.direction, run: marks.run, reader: marks.reader, totalMs, label: label(totalMs),
    includedBlock: marks.includedBlock, ...(marks.includedRetracted ? { includedRetracted: true as const } : {}), ...(marks.finalizedBlock === undefined ? {} : { finalizedBlock: marks.finalizedBlock }), segments: path };
}

/** The invariant the report relies on: on-path parts plus unattributed equal the total. */
export function assertAddsUp(value: Breakdown): void {
  if (value.segments.some(s => s.ms !== null && (!Number.isFinite(s.ms) || s.ms < 0))) throw Error('Invalid segment duration');
  const sum = value.segments.filter(s => !s.offPath).reduce((total, s) => total + (s.ms ?? 0), 0);
  if (sum !== value.totalMs) throw Error(`${value.direction} run ${value.run}: parts add up to ${sum} ms, total is ${value.totalMs} ms`);
  if (label(value.totalMs) !== value.label) throw Error(`${value.direction} run ${value.run}: label ${value.label} does not match ${value.totalMs} ms`);
  for (const segment of value.segments) if (segment.spans) {
    assertFiniteNumbers(segment.spans);
    if (segment.spans.some(s => s.end < s.start) || segment.spans.reduce((n, s) => n + s.end - s.start, 0) !== segment.ms) throw Error('Invalid segment interval sum');
  }
  const measured = value.segments.filter(s => !s.offPath && s.ms !== null && s.ms > 0);
  if (measured.length && measured.every(s => s.spans)) {
    const spans = measured.flatMap(s => s.spans!).sort((a, b) => a.start - b.start);
    if (!spans.length || spans.some((s, i) => i > 0 && s.start !== spans[i - 1]!.end) || spans.at(-1)!.end - spans[0]!.start !== value.totalMs) throw Error('Overlapping or incomplete segment timeline');
  }
}

export function median(values: readonly number[]): number {
  if (!values.length) throw Error('No values');
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export interface Summary { direction: Direction; metric?: string; runs: number; medianMs: number; minMs: number; maxMs: number; label: Label; segments: Record<string, { medianMs: number; minMs: number; maxMs: number; measured: number }> }

export function summarize(runs: readonly Breakdown[]): Summary[] {
  const groups = [...new Set(runs.map(r => JSON.stringify([r.direction, r.metric ?? null])))].sort();
  return groups.map(group => {
    const mine = runs.filter(r => JSON.stringify([r.direction, r.metric ?? null]) === group), totals = mine.map(r => r.totalMs);
    const { direction, metric } = mine[0]!;
    const segments: Summary['segments'] = {};
    for (const name of [...new Set(mine.flatMap(r => r.segments.map(s => s.name)))]) {
      const values = mine.map(r => {
        const parts = r.segments.filter(s => s.name === name);
        const onPath = parts.filter(s => !s.offPath);
        const measured = (onPath.length ? onPath : parts).filter(s => typeof s.ms === 'number');
        return measured.length ? measured.reduce((n, s) => n + s.ms!, 0) : null;
      }).filter((v): v is number => typeof v === 'number');
      if (values.length) segments[name] = { medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values), measured: values.length };
    }
    const medianMs = median(totals);
    return { direction, ...(metric ? { metric } : {}), runs: mine.length, medianMs, minMs: Math.min(...totals), maxMs: Math.max(...totals), label: label(medianMs), segments };
  });
}

const seconds = (ms: number | null | undefined) => ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(3)} s`;


/** The comment section: every run's total, label and breakdown, then the median and spread per direction. */
export function commentSection(runs: readonly Breakdown[]): string {
  const lines = ['## Cross-app timing (two-host topology)', '',
    'Block observations use the lab clock; lab-observed finality is an upper bound.', '',
    `Labels: ok <= ${thresholds.okMs / 1000} s, slow <= ${thresholds.slowMs / 1000} s, too slow above. A label never fails the run.`, ''];
  for (const value of runs) {
    assertAddsUp(value);
    lines.push(`### ${plainName(value.direction)}${value.metric ? ` / ${value.metric}` : ''}, run ${value.run}: **${seconds(value.totalMs)} (${value.label})**`, '',
      `Two-host topology. Reader: ${value.reader.app}, ${value.reader.head} head, ${value.reader.how}.` + (value.includedBlock === undefined ? '' : ` Included in best block #${value.includedBlock}${value.includedRetracted ? ' (that block later lost a reorg to a sibling at the same height)' : ''}`) +
      (value.finalizedBlock === undefined ? '.' : `, finalized by #${value.finalizedBlock}.`), '',
      '| Part | Time | Note |', '| --- | --- | --- |',
      ...value.segments.map(s => `| ${s.name}${s.offPath ? ' (beside the path)' : ''} | ${seconds(s.ms)} | ${s.note ?? ''} |`), '');
  }
  const summaries = summarize(runs);
  if (summaries.length) {
    lines.push('### Median and spread (two-host topology)', '', '| Direction | Runs | Median | Min-max | Label | Signing | Inclusion | Finality | Hand-off | Render | Unattributed |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of summaries) {
      const part = (name: string) => { const v = s.segments[name]; return v ? `${seconds(v.medianMs)} (${v.measured === 1 ? 'single run' : `${seconds(v.minMs)}-${seconds(v.maxMs)}`})` : 'n/a'; };
      lines.push(`| ${plainName(s.direction)}${s.metric ? ` / ${s.metric}` : ''} | ${s.runs} | ${seconds(s.medianMs)} | ${s.runs === 1 ? 'single run' : `${seconds(s.minMs)}-${seconds(s.maxMs)}`} | ${s.label} | ${part('signing')} | ${part('inclusion')} | ${part('finality')} | ${part('hand-off')} | ${part('render')} | ${part('unattributed')} |`);
    }
    lines.push('', '| Direction (two-host topology) | Part | Median | Min-max | Measured |', '| --- | --- | --- | --- | --- |');
    for (const s of summaries) for (const [name, p] of Object.entries(s.segments)) lines.push(`| ${plainName(s.direction)}${s.metric ? ` / ${s.metric}` : ''} | ${name} | ${seconds(p.medianMs)} | ${p.measured === 1 ? 'single run' : `${seconds(p.minMs)}-${seconds(p.maxMs)}`} | ${p.measured}/${s.runs} |`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface MeasurementWindow { start: number; end: number }
/** Verification may read concurrently, but its awaited check must follow every captured endpoint. */
export function assertVerificationAfter(verification: { at: number; done: number }, windows: readonly MeasurementWindow[]) {
  assertFiniteNumbers({ verification, windows });
  if (!windows.length || verification.done < verification.at || windows.some(window => window.end < window.start || verification.at < window.end))
    throw Error('Finalized verification must be outside and after every measured window');
}

/** The same recorder invariant for entry/return paths. Lab overhead is an explicit part of wall time,
 * not silently subtracted from an app segment. Missing adjacent marks leave a residual, as in C1/C2. */
export function journeyBreakdown(input: {
  direction: Direction; metric?: string; run: string; reader: Reader;
  start: number; end: number; endName?: string; points: Array<{ name: string; at?: number }>;
  beside?: Segment[]; includedBlock?: number; includedRetracted?: true; finalizedBlock?: number;
  verification?: { at: number; done: number };
  actions?: Array<{ name: string; at: number; done: number }>;
}): Breakdown {
  if (input.verification) assertVerificationAfter(input.verification, [input]);
  const totalMs = input.end - input.start;
  label(totalMs);
  let last = input.start, kept = true;
  const segments: Segment[] = [];
  for (const point of [...input.points, { name: input.endName ?? 'render', at: input.end }]) {
    if (point.at === undefined || !Number.isFinite(point.at) || point.at < last || point.at > input.end) {
      segments.push({ name: point.name, ms: null, note: 'missing or out-of-order mark' }); kept = false; continue;
    }
    segments.push({ name: point.name, ms: kept ? point.at - last : null, ...(kept ? { spans: [{ start: last, end: point.at }] } : {}), ...(kept ? {} : { note: 'previous mark not measured' }) });
    last = point.at; kept = true;
  }
  applyActions(segments, input.actions ?? [], input.start, input.end);
  const actionNames = new Set((input.actions ?? []).map(a => a.name));
  const overhead = segments.filter(s => s.name === 'lab overhead' || actionNames.has(s.name)).reduce((n, s) => n + (s.ms ?? 0), 0);
  if (overhead) segments.push({ name: 'wall time outside recorded lab intervals', ms: totalMs - overhead, offPath: true });
  segments.push(...(input.beside ?? []).map(s => ({ ...s, offPath: true })));
  segments.push({ name: 'unattributed', ms: totalMs - segments.filter(s => !s.offPath).reduce((n, s) => n + (s.ms ?? 0), 0), spans: residualSpans(segments, input.start, input.end) });
  const value = { direction: input.direction, ...(input.metric ? { metric: input.metric } : {}), run: input.run, reader: input.reader, totalMs, label: label(totalMs), segments,
    includedBlock: input.includedBlock, ...(input.includedRetracted ? { includedRetracted: true as const } : {}), finalizedBlock: input.finalizedBlock };
  assertAddsUp(value); return value;
}

/** Retain real interval boundaries, removing lab intervals from every overlapping measured clock once. */
function applyActions(segments: Segment[], actions: Array<{ name: string; at: number; done: number }>, start: number, end: number): void {
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const action of [...actions].sort((a, b) => a.at - b.at)) {
    if (![action.at, action.done].every(Number.isFinite) || action.done < action.at || action.at < previousEnd) throw Error('Invalid or overlapping lab action');
    previousEnd = action.done;
    const at = Math.max(start, action.at), done = Math.min(end, action.done);
    if (done < at || done === at && action.at !== action.done) continue;
    for (const segment of segments) {
      if (segment.offPath || !segment.spans) continue;
      let overlap = 0;
      segment.spans = segment.spans.flatMap(span => {
        const amount = Math.max(0, Math.min(done, span.end) - Math.max(at, span.start));
        overlap += amount;
        if (!amount) return [span];
        return [...(span.start < at ? [{ start: span.start, end: at }] : []), ...(span.end > done ? [{ start: done, end: span.end }] : [])];
      });
      if (overlap) { const wall = segment.ms!; segment.ms! -= overlap; segment.note = `Recorded lab actions excluded from this ${wall} ms wall span; not a causal split`; }
    }
    segments.push({ name: action.name, ms: done - at, spans: [{ start: at, end: done }], note: done === at ? 'lab action below wall-clock millisecond resolution' : 'lab action, intersected with measured window' });
  }
}
function residualSpans(segments: Segment[], start: number, end: number): Array<{ start: number; end: number }> {
  const ranges = segments.filter(s => !s.offPath).flatMap(s => s.spans ?? []).sort((a, b) => a.start - b.start);
  const result: Array<{ start: number; end: number }> = [];
  let at = start;
  for (const span of ranges) { if (span.start > at) result.push({ start: at, end: span.start }); at = Math.max(at, span.end); }
  if (at < end) result.push({ start: at, end });
  return result;
}
