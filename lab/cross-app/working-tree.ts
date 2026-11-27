// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

type DiffProcess = ChildProcessByStdio<null, Readable, Readable>;
const gitDiff = (directory: string): DiffProcess => spawn('git', ['diff', 'HEAD', '--binary'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
/** Hash the complete diff without a fixed output buffer, including a detached scratch merge's large binary diff. */
export function workingTreeHash(directory: string, command: (directory: string) => DiffProcess = gitDiff): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = command(directory), hash = createHash('sha256');
    child.stdout.on('data', (bytes: Buffer) => hash.update(bytes));
    child.stderr.resume();
    child.once('error', () => reject(Error('Cannot hash working tree')));
    child.once('close', status => status === 0 ? resolve(hash.digest('hex')) : reject(Error('Cannot hash working tree')));
  });
}
