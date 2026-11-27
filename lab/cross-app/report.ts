// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { plainName, sourceName } from './names.ts';
// Standalone timing views over saved measurements. No network or reconstructed timing marks.
import { assertAddsUp, assertFiniteNumbers, commentSection, summarize, type Breakdown } from './timing.ts';

export interface ConfigValue { value: string; basis: 'declared' | 'observed'; ref: string }
export const configKeys = ['topology', 'Humanity reads', 'Humanity card poll', 'Humanity next-game poll', 'Humanity live-record poll', 'Jollity reads', 'app commit', 'SDK', 'individuality SDK', 'host SDK', 'host', 'product-lab'] as const;
export type RunConfig = Record<typeof configKeys[number], ConfigValue>;
export interface Evidence { breakdown: Breakdown; raw: Record<string, unknown> }
export interface Dataset { source: string; command: string; config: RunConfig; rows: Evidence[]; verdict: string; seconds?: number }
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const sec = (n: number | null) => n === null ? 'not measured' : `${(n / 1000).toFixed(3)} s`;

export function validateDataset(data: Dataset): void {
  if (!data.source || !data.command || !data.verdict) throw Error('Missing run provenance');
  if (!data.rows?.length) throw Error('Empty run');
  assertFiniteNumbers(data);
  for (const key of configKeys) {
    const item = data.config?.[key];
    if (!item?.value || !['declared', 'observed'].includes(item.basis) || !item.ref) throw Error(`Missing config value: ${key}`);
  }
  for (const row of data.rows) { if (!row.raw || !row.breakdown?.run) throw Error('Empty run'); assertAddsUp(row.breakdown); }
}

/** Only explicit clock marks. Block heights, durations and inferred query/poll times never become events. */
export function events(row: Evidence): Array<{ name: string; at: number }> {
  const raw = row.raw;
  const found: Array<{ name: string; at: number }> = [];
  const add = (name: string, at: unknown) => { if (typeof at === 'number') { assertFiniteNumbers(at); found.push({ name, at }); } };
  for (const key of ['tap', 'start', 'endOfPlay', 'resultAt', 'returnFlowStart', 'exitTap', 'loaded', 'data']) add(key, raw[key]);
  for (const key of ['chain', 'navigation', 'follow', 'recovery', 'updatePromotion', 'nameClaimAction', 'labCardDisplay', 'humanity', 'jollity', 'jollityDate', 'shown']) {
    const v = raw[key] as Record<string, unknown> | undefined;
    if (v) for (const field of ['at', 'done', 'submitted', 'included', 'finalized', 'start', 'opened', 'foreground']) add(`${key}.${field}`, v[field]);
  }
  if (typeof raw.rendered === 'number') add('rendered', raw.rendered);
  else if (raw.rendered) { const r = raw.rendered as Record<string, unknown>; for (const key of ['at', 'usable', 'loaded', 'updated']) add(`rendered.${key}`, r[key]); }
  const actions = (raw.labActions ?? raw.actions ?? []) as Array<{ name: string; at: number; done: number }>;
  if (Array.isArray(actions)) for (const action of actions) { add(`${action.name}: start`, action.at); add(`${action.name}: end`, action.done); }
  return found.sort((a, b) => a.at - b.at);
}

function origin(row: Evidence, marks: ReturnType<typeof events>): number | undefined {
  const r = row.raw, b = row.breakdown;
  const chain = r.chain as Record<string, unknown> | undefined;
  const rec = r.recovery as Record<string, unknown> | undefined;
  const at = b.metric?.includes('return-cta') ? r.exitTap : ['C1', 'C2', 'C3', 'U3'].includes(b.direction) ? r.tap : b.direction === 'B1' || b.direction === 'B3' ? rec?.foreground : r.start ?? chain?.included;
  return typeof at === 'number' ? at : marks.find(m => m.name === 'tap')?.at;
}
const required = ['lab Register click', 'pure render', 'signing', 'inclusion', 'best block', 'finality', 'app read path', 'poll wait', 'render', 'unattributed'];
const displayName = (name: string) => /finalit/i.test(name) ? `${name} (lab-observed, upper bound)` : name === 'render' ? 'render (data proxy to state; mixed wait)' : name;

export function renderReport(datasets: Dataset[]): { html: string; markdown: string } {
  if (!datasets.length) throw Error('Empty run');
  datasets.forEach(validateDataset);
  // Humanity missed + next-date are the same predicate. Preserve only the combined endpoint.
  const sets = datasets.map(data => ({ ...data, rows: data.rows.filter(row => !/humanity-next(?:$|-)/.test(row.breakdown.metric ?? '')).flatMap(row => {
    const cta = row.raw.returnBreakdown as Breakdown | undefined;
    const context = row.breakdown.run.startsWith('C6-') ? plainName('C6') + ' / ' : row.breakdown.run.startsWith('B2-') ? plainName('B2') + ' / ' : row.breakdown.direction === 'C1' && row.breakdown.run.startsWith('C5-') ? plainName('C5') + ' setup / ' : row.breakdown.direction === 'C1' && row.breakdown.run.startsWith('B1-') ? plainName('B1') + ' setup / ' : '';
    const primary = context ? { ...row, breakdown: { ...row.breakdown, metric: context + (row.breakdown.metric ?? 'primary') } } : row;
    return cta ? [primary, { raw: row.raw, breakdown: { ...cta, metric: context + 'return-cta' } }] : [primary];
  }) }));
  sets.forEach(validateDataset);
  const all = sets.flatMap(d => d.rows.map(r => r.breakdown));
  const summaries = summarize(all);
  const summaryTable = `<table><thead><tr><th>Direction / endpoint</th><th>Runs</th><th>Median</th><th>Spread (min to max)</th><th>Label</th></tr></thead><tbody>${summaries.map(s => `<tr><td>${esc(plainName(s.direction))} / ${esc(s.metric ?? 'primary')}</td><td>${s.runs}</td><td>${sec(s.medianMs)}</td><td>${s.runs === 1 ? 'single run' : `${sec(s.minMs)} to ${sec(s.maxMs)}`}</td><td>${s.label}</td></tr>`).join('')}</tbody></table>`;
  const cards = sets.map(data => `<section><h2>${esc(sourceName(data.source))}</h2><p>Source command: ${esc(data.command)}. Run verdict: ${esc(data.verdict)}${data.seconds === undefined ? '' : `; wall ${data.seconds.toFixed(1)} s`}.</p><details><summary>Per-app configuration and build provenance</summary><table><tr><th>Value</th><th>Setting</th><th>Basis</th><th>Evidence</th></tr>${configKeys.map(key => { const c = data.config[key]; return `<tr><td>${esc(key)}</td><td>${esc(c.value)}</td><td>${c.basis}</td><td>${esc(c.ref)}</td></tr>`; }).join('')}</table></details>${data.rows.map(row => {
    const b = row.breakdown, marks = events(row), start = origin(row, marks);
    const parts = b.segments.filter(s => !s.offPath), sum = parts.reduce((n, s) => n + (s.ms ?? 0), 0);
    const spans = parts.flatMap(s => (s.spans ?? []).map(span => ({ ...span, name: s.name }))).sort((a, b) => a.start - b.start);
    const spanStart = spans[0]?.start;
    const chronology = spans.length ? `<h4>Chronological exclusive intervals</h4><div class="bar">${spans.map((span, i) => `<span style="flex:${span.end - span.start};background:var(--chart-${i % 6 + 1})" title="${esc(span.name)}: ${sec(span.end - span.start)}"></span>`).join('')}</div><table><tr><th>From</th><th>To</th><th>Measured segment</th><th>Duration</th></tr>${spans.map(span => `<tr><td>${sec(span.start - spanStart!)}</td><td>${sec(span.end - spanStart!)}</td><td>${esc(displayName(span.name))}</td><td>${sec(span.end - span.start)}</td></tr>`).join('')}</table>` : '<p>Exclusive chronological segment boundaries: not measured by the older recorder. The real-mark timeline below retains event order; accounting parts are unchanged.</p>';
    const unseen = required.filter(key => !b.segments.some(s => key === 'app read path' ? /hand-off|data/.test(s.name) : key === 'best block' ? /inclusion/.test(s.name) : s.name === key));
    const chain = row.raw.chain as { included?: number; finalized?: number } | undefined;
    const signedRows = ['humanity', 'jollity', 'jollityDate'].flatMap(key => {
      const endpoint = row.raw[key] as { at?: number } | undefined;
      return typeof endpoint?.at === 'number' && typeof chain?.included === 'number' ? [`<tr><td>${esc(key === 'humanity' ? 'Humanity missed state + next date' : key)}</td><td>${sec(endpoint.at - chain.included)}</td><td>${typeof chain.finalized === 'number' ? sec(endpoint.at - chain.finalized) : 'not measured'}</td></tr>`] : [];
    }).join('');
    const signed = signedRows ? `<h4>Signed endpoint observations</h4><table><tr><th>Endpoint</th><th>UI minus best result</th><th>UI minus lab finality (upper bound)</th></tr>${signedRows}</table><p>Signed leads stay visible and are not treated as zero-duration latency.</p>` : '';
    const eventRows = marks.map(m => `<tr><td>${esc(displayName(m.name))}</td><td>${start === undefined ? 'origin not measured' : sec(m.at - start)}</td></tr>`).join('');
    return `<article data-direction="${esc(b.direction)}"><h3>${esc(plainName(b.direction))} / ${esc(b.metric ?? 'primary')} / run ${esc(b.run)}</h3><p class="total">${sec(b.totalMs)} <span class="${b.label === 'ok' ? 'ok' : 'slow'}">${b.label}</span></p><p>Reader: ${esc(b.reader.app)}, ${esc(b.reader.head)} head; ${esc(b.reader.how)}.</p><p>Lab best block: ${b.includedBlock === undefined ? 'not measured' : '#' + b.includedBlock + (b.includedRetracted ? ' (lost a reorg to a sibling at the same height)' : '')}; lab-observed finalized block (upper bound): ${b.finalizedBlock === undefined ? 'not measured' : '#' + b.finalizedBlock}.</p><p>Origin: ${esc(b.direction === 'B1' || b.direction === 'B3' ? 'foreground' : b.direction === 'C4' || b.direction === 'U4' ? 'first best block holding Ada\'s attended score row (CTA variant starts at trusted return tap)' : b.direction === 'C5' ? 'best result (CTA variant starts at trusted return tap)' : 'trusted Register tap')}. Source command above identifies registration setup samples within missed-game and background setup samples.</p><div class="bar" role="img" aria-label="Measured parts sum to ${b.totalMs} milliseconds">${parts.filter(s => s.ms !== null && s.ms > 0).map((s, i) => `<span style="flex:${s.ms};background:var(--chart-${i % 6 + 1},hsl(${i * 57 % 360} 45% 50%))" title="${esc(s.name)}: ${sec(s.ms)}"></span>`).join('')}</div><p class="note">Accounting bar in recorded part order. Action intervals can overlap other clocks; their time is removed once. This bar does not invent chronological boundaries for older recordings.</p>${chronology}${signed}<p class="proof">Sum proof: ${parts.filter(s => s.ms !== null).map(s => s.ms).join(' + ')} = ${sum} ms = total ${b.totalMs} ms. Difference: ${b.totalMs - sum} ms.</p><table><tr><th>Recorded segment, in recorder order</th><th>Time</th><th>Evidence / limits</th></tr>${b.segments.map(s => `<tr><td>${esc(displayName(s.name))}${s.offPath ? ' (beside, excluded from sum)' : ''}</td><td>${sec(s.ms)}</td><td>${esc(s.note ?? '')}</td></tr>`).join('')}${unseen.map(n => `<tr><td>${esc(displayName(n))}</td><td>not measured</td><td>No separate real mark</td></tr>`).join('')}</table><p>Signing is tap to first observed pool sighting (200 ms polling), not a native signing trace. Inclusion is the lab's best-block observation. Data arrival is a received-key proxy. Data-to-state may include polling and processing; pure render and actual poll wait are not separately measured. No split is inferred from a declared interval.</p><details><summary>Chronological timeline of real marks (${marks.length})</summary><table><tr><th>Observed mark</th><th>Offset from origin</th></tr>${eventRows || '<tr><td>No retained clock marks</td><td>not measured</td></tr>'}</table><p>Negative offsets and marks after the endpoint are retained beside the window. Independent lab finality can arrive after the app has rendered. Unix millisecond marks share one machine clock.</p></details></article>`;
  }).join('')}</section>`).join('');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cross-app hand-off timing</title><style>:root{color-scheme:light dark;--foreground:light-dark(#17212b,#e8edf1);--muted:light-dark(#52606d,#bac3cd);--border:light-dark(#c8d0d8,#48535f);--chart-1:#397da5;--chart-2:#af7832;--chart-3:#638c59;--chart-4:#9466a7;--chart-5:#b76066;--chart-6:#4f9591}body{font:14px/1.5 system-ui;color:var(--foreground);margin:16px auto;max-width:1100px}h1,h2,h3{line-height:1.2}section,article{margin:24px 0}article{border-top:1px solid var(--border);padding-top:14px}table{border-collapse:collapse;width:100%;font-size:13px;overflow-wrap:anywhere}th,td{text-align:left;padding:7px;border-bottom:1px solid var(--border);vertical-align:top}th{font-weight:650}.total{font-size:24px;margin:8px 0}.ok{color:light-dark(#26603e,#8fd4a6)}.slow{color:light-dark(#8d4a09,#f1bd78)}.bar{display:flex;height:26px;gap:1px;border:1px solid var(--border);border-radius:4px;overflow:hidden}.note{color:var(--muted);font-size:12px}.proof{font-family:monospace;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}select{font:inherit;padding:5px}article[hidden]{display:none}@media(max-width:600px){body{margin:8px}td,th{padding:4px;font-size:11px}}</style><body><h1>Cross-app hand-off timing</h1><p>Two-host lab: Humanity and Jollity have separate CLI processes and host storage. Finality is <strong>lab-observed, upper bound</strong>. Labels only: ok ≤45 s, slow ≤90 s, too slow &gt;90 s. Every number remains visible; labels never fail a run.</p><p>Sign up in Jollity, Humanity shows it (C1) near 29 s was aligned near the worst phase of Humanity's 30 s poll. Open Jollity from Humanity (C3) includes the lab permission click (not separately retained in early samples). Play a real game, Humanity's card updates (C4) includes payoff walks, about 7 s in the historical sample; its CTA variant isolates the return window. Miss a game, both apps show it (C5) includes caution-sheet dismissal. Apps catch up after being in the background: missed game while Humanity was away (B1) is one poll after debugger resume, not a phone recovery cost. Jollity next-date is unfinalized best-head state. Humanity missed state plus next date is one combined endpoint.</p><h2>Median and spread</h2>${summaryTable}<p><label>Show direction <select id="direction"><option value="">All</option>${[...new Set(all.map(r => r.direction))].sort().map(d => `<option value="${esc(d)}">${esc(plainName(d))}</option>`).join('')}</select></label></p>${cards}<script>document.getElementById('direction').addEventListener('change',function(){document.querySelectorAll('article[data-direction]').forEach(el=>{el.hidden=Boolean(this.value&&el.dataset.direction!==this.value)})})</script></body></html>`;
  const markdown = ['<!-- cross-app-lab-comment:v1 -->', '## Cross-app lab', '', ...sets.map(d => `- ${sourceName(d.source)}: **${d.verdict}**, ${d.rows.length} timing endpoints; command ${d.command}.`), '', 'Finality: lab-observed, upper bound. Two-host lab; separate host storage. Labels only: 45 s / 90 s.', '', '| Direction / endpoint | Runs | Median | Min to max | Label |', '| --- | --- | --- | --- | --- |', ...summaries.map(s => `| ${plainName(s.direction)} / ${s.metric ?? 'primary'} | ${s.runs} | ${sec(s.medianMs)} | ${s.runs === 1 ? 'single run' : `${sec(s.minMs)} to ${sec(s.maxMs)}`} | ${s.label} |`), '', 'The HTML artifact contains every run, exact sum proofs, recorded parts, chronological real marks and declared/observed configuration. Poll wait and pure render are not separately measured. Sign up in Jollity, Humanity shows it (C1) near 29 s was aligned near the worst phase of Humanity\'s 30 s poll. Open Jollity from Humanity (C3) includes the lab permission click. Miss a game, both apps show it (C5) includes lab dismissal; Apps catch up after being in the background: missed game while Humanity was away (B1) measures poll timing after debugger resume. Play a real game, Humanity\'s card updates (C4) includes lab payoff walking; CTA rows use the trusted return tap.'].join('\n');
  return { html, markdown };
}
export { commentSection };
