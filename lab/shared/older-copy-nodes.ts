// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { SyncCommandRunner } from '@parity/product-lab/ports/system';

/** Observe only: opening a recovering process registry could stop survivors. */
export function refuseOlderScenarioNodes(parent: string, commands: SyncCommandRunner): void {
  let snapshot;
  try { snapshot = commands.run({ command: 'ps', args: ['-axo', 'pid=,command=', '-ww'], timeoutMs: 5000, maxOutputBytes: 8 * 1024 * 1024 }); }
  catch { throw Error('Cannot inspect older scenario copy processes; fresh start refused'); }
  if (snapshot.code !== 0) throw Error('Cannot inspect older scenario copy processes; fresh start refused');
  const escaped = parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const path = new RegExp(`(?:^|[\\s="'])(${escaped}/run-[^/\\s"']+)(?=/|[\\s"']|$)`);
  const older = snapshot.stdout.split('\n').flatMap(line => {
    const process = /^\s*(\d+)\s+(.+)$/.exec(line), folder = process && path.exec(process[2]!);
    return process && folder ? [{ pid: Number(process[1]), folder: folder[1]! }] : [];
  });
  if (!older.length) return;
  let listeners;
  try { listeners = commands.run({ command: 'lsof', args: ['-nP', '-a', '-p', older.map(process => process.pid).join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'], timeoutMs: 5000, maxOutputBytes: 1024 * 1024 }); }
  catch { listeners = { code: 2, stdout: '', stderr: '' }; }
  const ports = new Map<number, Set<string>>(); let pid: number | undefined;
  for (const line of listeners.stdout.split('\n')) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); ports.set(pid, new Set()); }
    else if (pid !== undefined && line.startsWith('n')) { const port = /:(\d+)$/.exec(line); if (port) ports.get(pid)!.add(port[1]!); }
  }
  const detail = older.map(process => `${process.folder}: PID ${process.pid}, TCP ports ${[...(ports.get(process.pid) ?? [])].join(', ') || (listeners.code > 1 ? 'unavailable' : 'none reported')}`).join('; ');
  throw Error(`Older scenario copies still have running processes: ${detail}. Nothing was stopped; close those runs before starting a fresh copy`);
}
