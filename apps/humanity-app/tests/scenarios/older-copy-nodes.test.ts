// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import { refuseOlderScenarioNodes } from '../../../../lab/shared/older-copy-nodes.ts';
const parent = '/lab/scenarios [fixture]';
it('names all matching PIDs and IPv4/IPv6 listener ports without touching unrelated copies or killing nodes', () => {
  const run = vi.fn().mockReturnValueOnce({ code: 0, stdout: `10 node --base-path "${parent}/run-Old123/paseo-copy/network"\n11 node --base-path "${parent}/run-Old123/paseo-copy/other"\n12 node /unrelated/run-Other/network\n13 node /different${parent}/run-NoMatch/network\n`, stderr: '' })
    .mockReturnValueOnce({ code: 0, stdout: 'p10\nn127.0.0.1:9944\nn[::1]:9944\np11\nn*:30333\n', stderr: '' });
  expect(() => refuseOlderScenarioNodes(parent, { run })).toThrow(/PID 10, TCP ports 9944.*PID 11, TCP ports 30333.*Nothing was stopped/);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]![0].args).toEqual(['-nP', '-a', '-p', '10,11', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
});
it('allows no survivors and reports non-listening survivors without killing them', () => {
  const empty = vi.fn(() => ({ code: 0, stdout: '12 node /unrelated/run-Other/network\n', stderr: '' }));
  expect(() => refuseOlderScenarioNodes(parent, { run: empty })).not.toThrow(); expect(empty).toHaveBeenCalledTimes(1);
  const run = vi.fn().mockReturnValueOnce({ code: 0, stdout: `10 node "${parent}/run-Old123/network"\n`, stderr: '' }).mockReturnValueOnce({ code: 1, stdout: '', stderr: '' });
  expect(() => refuseOlderScenarioNodes(parent, { run })).toThrow('PID 10, TCP ports none reported');
});
it('fails closed when process inspection fails', () => {
  const run = vi.fn(() => ({ code: 2, stdout: '', stderr: 'unavailable' }));
  expect(() => refuseOlderScenarioNodes(parent, { run })).toThrow('Cannot inspect older scenario copy processes');
  run.mockImplementation(() => { throw Error('inspector unavailable'); });
  expect(() => refuseOlderScenarioNodes(parent, { run })).toThrow('Cannot inspect older scenario copy processes');
});
it('still names the survivor when listener inspection is unavailable', () => {
  const run = vi.fn().mockReturnValueOnce({ code: 0, stdout: `10 node "${parent}/run-Old123/network"\n`, stderr: '' })
    .mockImplementationOnce(() => { throw Error('lsof unavailable'); });
  expect(() => refuseOlderScenarioNodes(parent, { run })).toThrow('PID 10, TCP ports unavailable');
});
