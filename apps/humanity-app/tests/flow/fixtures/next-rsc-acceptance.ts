// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Execute the installed Next client's actual MIME/status/body gate, without a DOM, decoder or host.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const nextClientFile = require.resolve('next/dist/client/components/router-reducer/fetch-server-response.js');
export function nextAcceptsRsc(type: string, status = 200): boolean {
  const source = readFileSync(nextClientFile, 'utf8');
  const start = source.indexOf('const contentType = res.headers.get(');
  const end = source.indexOf('// We may navigate to a page that requires a different Webpack runtime.', start);
  if (start < 0 || end < 0) throw new Error('Installed Next response gate changed; inspect before updating this control');
  const gate = source.slice(start, end).replace('return doMpaNavigation(responseUrl.toString());', 'return false;');
  if (!gate.includes('return false;')) throw new Error('Installed Next MPA branch not found');
  return new Function('res', 'process', '_approuterheaders', 'url', 'responseUrl', gate + '\nreturn true;')(
    new Response('RSC fixture', { status, headers: { 'content-type': type } }),
    { env: { NODE_ENV: 'production', __NEXT_CONFIG_OUTPUT: 'export' } },
    { RSC_CONTENT_TYPE_HEADER: 'text/x-component', NEXT_URL: 'next-url', NEXT_DID_POSTPONE_HEADER: 'x-nextjs-postponed' },
    new URL('http://flow.invalid/chest'), new URL('http://flow.invalid/chest')) as boolean;
}
