// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Onboards one of the lab's people on a LIVE network, once, and keeps her phrase where the lab reads it.
//
//   node --import tsx lab/previewnet-poc/onboard.mts [previewnet|paseo-next-v2] [Person]
//
// Alone it is Ada on Previewnet. The locked truAPI CLI host makes the keys and registers a lite username through the
// network's identity backend, whose attester pays: this sends no PAS. What it leaves on the network stays there. The
// phrase goes to `.env` next to the lab's config (git-ignored, owner-only) under <PREVIEWNET_POC|PASEO_PLAY>_<PERSON>_MNEMONIC
// and is never printed; her username goes beside it. A second run for the same person refuses: a name on a live network
// cannot be taken back.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSystem } from '@parity/product-lab/composition';
import { truapiCliProvisioner } from '@parity/product-lab/host-truapi-cli';
import { ProcessEnvironmentVariables } from '@parity/product-lab/system-node';
import { entropyToMnemonic } from '@polkadot-labs/hdkd-helpers';
import { hostSelection } from '../../apps/humanity-app/lab/opening/session.ts';

// The network and the person come from the command line: `onboard.mts` alone is Ada on Previewnet, and
// `onboard.mts paseo-next-v2 Ada` is Ada on Paseo Next V2, whose names start PASEO_PLAY_.
const network = process.argv[2] ?? 'previewnet', person = (process.argv[3] ?? 'Ada').toUpperCase();
if (network !== 'previewnet' && network !== 'paseo-next-v2') throw Error(`Unknown network ${network}`);
const prefix = network === 'previewnet' ? 'PREVIEWNET_POC' : 'PASEO_PLAY';
export const SECRET = `${prefix}_${person}_MNEMONIC`;
const here = fileURLToPath(new URL('.', import.meta.url));
const envFile = join(here, '.env');

if (process.env[SECRET] || (existsSync(envFile) && new RegExp(`^${SECRET}=`, 'm').test(readFileSync(envFile, 'utf8'))))
  throw Error(`${SECRET} is already set: this person exists, and this script makes her only once`);

const system = new NodeSystem(new ProcessEnvironmentVariables());
const dataRoot = join(here, '.product-lab', network === 'previewnet' ? 'live-people' : `live-people-${network}`); mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const provisioner = truapiCliProvisioner({ host: hostSelection, network: { preset: network }, dataRoot, usernamePrefix: 'plabpoc',
  system: { processes: system.processes, commands: system.commands }, log: line => console.log(line) });
const identity = await provisioner.provision({ actor: { id: person.toLowerCase(), name: person[0] + person.slice(1).toLowerCase() } });
// The username is public (it is on chain); the lab shows it on Ada's card and cannot learn it from the phrase alone.
appendFileSync(envFile, `${SECRET}="${entropyToMnemonic(identity.entropy)}"\n${prefix}_${person}_USERNAME=${identity.liteUsername}\n`, { mode: 0o600 }); chmodSync(envFile, 0o600);
console.log(`Onboarded ${identity.liteUsername} (${identity.evidence.identityAddress}) on live ${network} in ${(identity.evidence.provisionMs / 1000).toFixed(1)} s; her phrase is in ${envFile}`);
