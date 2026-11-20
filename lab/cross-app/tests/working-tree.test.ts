// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawn, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { workingTreeHash } from '../working-tree.ts';
const script = "process.stdout.end(Buffer.alloc(17 * 1024 * 1024, 'x'))";
it('hashes a complete diff above the previous 16 MB collector limit', async () => {
  const digest = await workingTreeHash('.', () => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }));
  expect(digest).toBe('397fa93fdb906d5a278075e087c5b1bef5c5f5fbfb3a080b438a3ba30f435db3');
});
it('@negative-control: the former bounded collector truncates the same input', () => {
  const old = spawnSync(process.execPath, ['-e', script], { maxBuffer: 16e6 });
  expect(old.error).toMatchObject({ code: 'ENOBUFS' });
});
it('@negative-control: an unsuccessful diff command cannot become a valid digest', async () => {
  await expect(workingTreeHash('.', () => spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: ['ignore', 'pipe', 'pipe'] })))
    .rejects.toThrow('Cannot hash working tree');
});
