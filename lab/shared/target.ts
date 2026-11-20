// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { requireOwnedGameFork, type ImportedGamesTarget } from './upstream/lab/steps/humanity/bootstrap/imported-games.ts';

/** Both permitted targets are owned copies. A loopback proxy alone never proves ownership. */
export function requireScenarioTarget(target: ImportedGamesTarget): 'fork' | 'genesis' {
  const network = target.humanity?.network;
  if (network?.kind !== 'owned' || target.offer?.local !== true || network.session.schemaVersion !== 1 || network.session.ownership !== 'owned') throw Error('Humanity scenarios require an owned local chain');
  const session = network.session;
  const endpoint = target.endpoints?.people;
  if (!endpoint || endpoint !== session.chains.people.ws) throw Error('Humanity scenarios refuse a mismatched endpoint');
  const url = new URL(endpoint);
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw Error('Humanity scenarios refuse a public or credentialed target');
  if (session.mode === 'fork') { requireOwnedGameFork(target); return 'fork'; }
  if (session.mode !== 'genesis' || session.network !== 'previewnet') throw Error('Humanity scenarios refuse this genesis target');
  // v0.3.4; tags are pinned by the environment declaration when that lane is enabled.
  if (session.chains.people.codeHash !== '0x69e7126f098bdf708302e52b892fd76c5d2477627bce47cbfcee7fcd5db17871' ||
    session.chains['asset-hub'].codeHash !== '0xd1ee06e7e13dee315971e5d7c7634390e43afd802b588faefb0cc910a790d031') throw Error('Genesis runtimes differ from individuality-community v0.3.4');
  return 'genesis';
}
