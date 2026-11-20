// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { Status, type ITestStepHookParameter, type IWorld } from '@cucumber/cucumber';
import { failureEvidenceHook } from '../../lab/scenarios/failure-evidence.ts';
import { ConsoleHistory, consoleLimits } from '../../../../lab/shared/console-history.ts';

const failure = { result: { status: 'FAILED', message: 'function timed out after 60000 milliseconds' }, pickleStep: { text: 'Ada sees the attendance row:' } } as ITestStepHookParameter;
it('attaches a PNG, visible text and accessibility snapshot through the report attachment API after a timeout', async () => {
  const png = Buffer.from('synthetic-png');
  const page = { screenshot: vi.fn(async () => png), evaluate: vi.fn(async () => ({ url: 'http://127.0.0.1/', text: 'Not this week', dialogs: ['urgent caution'] })),
    locator: vi.fn(() => ({ ariaSnapshot: vi.fn(async () => '- dialog "Today at 10:00"') })) } as unknown as BrowserPage;
  const attach = vi.fn(async (_data: unknown, _media: string) => undefined);
  await failureEvidenceHook(() => [{ id: 'ada', page }]).call({ attach } as unknown as IWorld, failure);
  expect(attach).toHaveBeenCalledWith(png, 'image/png');
  expect(attach.mock.calls.some(([data, media]) => media === 'application/json' && String(data).includes('Not this week'))).toBe(true);
  expect(attach).toHaveBeenCalledWith('- dialog "Today at 10:00"', 'text/plain');
});
it('attaches a finalized Game.Game read alongside the failure', async () => {
  const attach = vi.fn(async (_data: unknown, _media: string) => undefined);
  const read = { at: { hash: 'finalized', number: 7 }, value: { state: { type: 'Registration' }, game_date: 1000 } };
  const readGame = vi.fn(async () => read);
  await failureEvidenceHook(() => [], readGame).call({ attach } as unknown as IWorld, failure);
  expect(readGame).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledWith(JSON.stringify({ productLab: 'humanity-failure-chain', storage: 'Game.Game', read }), 'application/json');
});
it('does not change a passed result, and preserves a failure when capture or attachment fails', async () => {
  const pages = vi.fn(() => []);
  const attach = vi.fn(async (_data: unknown, _media: string) => { throw Error('report transport closed'); });
  const hook = failureEvidenceHook(pages);
  await hook.call({ attach } as unknown as IWorld, { ...failure, result: { ...failure.result!, status: Status.PASSED } });
  expect(pages).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
  await expect(hook.call({ attach } as unknown as IWorld, failure)).resolves.toBeUndefined();
  expect(attach).toHaveBeenCalledWith(expect.stringContaining('No actor page exists'), 'application/json');
});
const consolePage = { actor: 'ada-1', page: 'context-1/page-1', recorded: 2, dropped: 0, entries: [
  { at: 1, type: 'log', text: 'home ready' }, { at: 2, type: 'error', text: '[humanity] username upgrade failed; code=lite-owner-unavailable' }] };
/** A real history holding these lines for ada-1's first page. */
function consoleWith(...lines: [type: string, text: string][]) {
  let now = 0; const history = new ConsoleHistory(consoleLimits, () => ++now);
  for (const [type, text] of lines) history.record('ada-1', 'context-1/page-1', type, text);
  return () => history;
}
const appConsole = consoleWith(['log', 'home ready'], ['error', '[humanity] username upgrade failed; code=lite-owner-unavailable']);
const noGame = async (): Promise<never> => { throw Error('no chain'); };
const json = (attach: ReturnType<typeof vi.fn>) => attach.mock.calls.filter(([, media]) => media === 'application/json').map(([data]) => JSON.parse(String(data)));
it('attaches the app console first on a failed step, so the app\'s own failure line names the cause', async () => {
  const attach = vi.fn(async (_data: unknown, _media: string) => undefined);
  const readGame = vi.fn(async () => { throw Error('no chain'); });
  await failureEvidenceHook(() => [], readGame, appConsole).call({ attach } as unknown as IWorld, failure);
  const [first] = json(attach);
  expect(first).toMatchObject({ productLab: 'humanity-failure-console', step: failure.pickleStep.text, pages: [consolePage] });
  expect(first.limits).toEqual({ linesPerPage: 200, charsPerLine: 500, bytes: 48_000 });
  expect(JSON.stringify(first)).toContain('code=lite-owner-unavailable');
});
it('records a gap, never a failure, when the console is empty or cannot be read, and attaches nothing on a pass', async () => {
  const attach = vi.fn(async (_data: unknown, _media: string) => undefined);
  await failureEvidenceHook(() => [], noGame, consoleWith()).call({ attach } as unknown as IWorld, failure);
  expect(json(attach).some(entry => entry.productLab === 'humanity-failure-console')).toBe(false);
  expect(json(attach).at(-1).gaps).toContain('No app console line was recorded');
  attach.mockClear();
  const broken = failureEvidenceHook(() => [], noGame, () => { throw Error('No owned Humanity scenario session'); });
  await expect(broken.call({ attach } as unknown as IWorld, failure)).resolves.toBeUndefined();
  expect(json(attach).at(-1).gaps).toContain('Console: Error: No owned Humanity scenario session');
  attach.mockClear();
  const lines = vi.fn(appConsole);
  await failureEvidenceHook(() => [], noGame, lines).call({ attach } as unknown as IWorld, { ...failure, result: { ...failure.result!, status: Status.PASSED } });
  expect(lines).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
});

it('keeps the whole console attachment within its byte bound, even for a long step text', async () => {
  const attach = vi.fn(async (_data: unknown, _media: string) => undefined);
  const history = new ConsoleHistory();
  for (let n = 0; n < 1_000; n++) history.record('ada-1', `context-1/page-${n % 4}`, 'error', `${n} ${'word '.repeat(90)}`);
  const longStep = { ...failure, pickleStep: { text: 'Ada sees '.repeat(2_000) } } as ITestStepHookParameter;
  await failureEvidenceHook(() => [], noGame, () => history).call({ attach } as unknown as IWorld, longStep);
  const [data] = attach.mock.calls.find(([value]) => String(value).includes('humanity-failure-console'))!;
  expect(Buffer.byteLength(String(data))).toBeLessThanOrEqual(consoleLimits.attachBytes);
  expect(JSON.parse(String(data)).step).toHaveLength(500);
});
