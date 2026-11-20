// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { ConsoleHistory, consoleLimits, sanitizeConsoleText } from '../../../../lab/shared/console-history.ts';

const claim = '[humanity] username upgrade failed; code=lite-owner-unavailable';
const words = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk'.split(' ');
const mnemonic = words.join(' ');
const wordRun = '<redacted: word sequence>';

// [what, input, expected output, a part of the input that must not survive]
const removals: [string, string, string, string][] = [
  // URLs keep scheme and host and a path class; never the path, user info, query or fragment.
  ['URL path, user info, query and fragment', 'GET https://user:redact-me@outside.invalid/api/v1?token=redact-me#redact-me failed', 'GET https://outside.invalid/<path>?<query> failed', 'redact-me'],
  ['token in a URL path', 'open https://app.invalid/invite/redact-me-1234567890abcdef', 'open https://app.invalid/<path>', 'redact-me'],
  ['loopback socket path and query', 'socket ws://127.0.0.1:42010/bridge?session=redact-me closed', 'socket ws://127.0.0.1:42010/<path>?<query> closed', 'redact-me'],
  ['asset URL query', 'boom at http://127.0.0.1:1/app.js?v=redact-me', 'boom at http://127.0.0.1:1/<asset>?<query>', 'redact-me'],
  ['percent-encoded path in a URL', 'GET http://127.0.0.1:1/%2FUsers%2Fredact-me%2Fx', 'GET http://127.0.0.1:1/<path>', 'redact-me'],
  ['scheme-less URL', 'GET //cdn.example/x?sig=redact-me', 'GET //cdn.example/<path>?<query>', 'redact-me'],
  ['query on a relative path', 'GET /api/claim?code=redact-me&state=x failed', 'GET /api/claim?<query> failed', 'redact-me'],
  ['file URL in any case', 'loaded FILE:///Users/redact-me/app.js', 'loaded <file url>', 'redact-me'],
  ['URL that does not parse', 'see http://[bad/?t=redact-me', 'see <url>', 'redact-me'],
  // Local paths.
  ['macOS and Linux home paths', 'at /Users/redact-me/app/src/a.ts:1 and /home/redact-me/x and /private/var/folders/redact-me', 'at <local path> and <local path> and <local path>', 'redact-me'],
  ['lowercase and tilde home paths', 'at /users/redact-me/x.js and ~redact-me/app and ~/redact-me', 'at <local path> and <local path> and <local path>', 'redact-me'],
  ['runner and system paths', 'at /srv/redact-me /mnt/redact-me /usr/local/redact-me /etc/redact-me /__w/redact-me /github/workspace/redact-me /Library/redact-me /workspace/redact-me',
    `at ${Array(8).fill('<local path>').join(' ')}`, 'redact-me'],
  ['temp and Homebrew paths', 'cache /tmp/redact-me and /opt/homebrew/Cellar/redact-me', 'cache <local path> and <local path>', 'redact-me'],
  ['Windows paths with either slash', 'at C:\\Users\\redact-me\\app.js and C:/Users/redact-me/app.js', 'at <local path> and <local path>', 'redact-me'],
  ['percent-encoded path outside a URL', 'path %2FUsers%2Fredact-me%2Fx', 'path <local path>', 'redact-me'],
  // Credential values.
  ['token and key assignments', 'auth token=redact-me; apiKey: "redact-me"', 'auth token=<redacted>; apiKey: "<redacted>"', 'redact-me'],
  ['JSON keys', '{"token":"redact-me","accessToken": "redact-me","x":1}', '{"token":"<redacted>","accessToken": "<redacted>","x":1}', 'redact-me'],
  ['single-quoted and spaced values', "token: 'redact-me' secret=\"redact-me too\"", "token: '<redacted>' secret=\"<redacted>\"", 'redact-me'],
  ['Basic authorization', 'authorization: Basic cmVkYWN0LW1l', 'authorization: <redacted>', 'cmVkYWN0LW1l'],
  ['every cookie pair', 'cookie: a=1; sid=redact-me', 'cookie: <redacted>', 'redact-me'],
  ['Set-Cookie', 'Set-Cookie: sid=redact-me; Path=/', 'Set-Cookie: <redacted>', 'redact-me'],
  ['bearer value', 'Authorization Bearer redact-me', 'Authorization Bearer <redacted>', 'redact-me'],
  ['JWT', 'got eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', 'got <redacted: jwt>', 'eyJ'],
  ['key, seed, pin and one-time code values', 'privKey=redact-me sk=redact-me key=redact-me-42 seed=redact-me otp=redact-me pin=redact-me',
    'privKey=<redacted> sk=<redacted> key=<redacted> seed=<redacted> otp=<redacted> pin=<redacted>', 'redact-me'],
  ['a value after a colon that is not one lowercase word', 'secret: Redact-Me-123', 'secret: <redacted>', 'Redact-Me'],
  ['a credential-like value after a bare key or session name', 'storage key: redact-me-42 session="redact-me-but-longer"', 'storage key: <redacted> session="<redacted>"', 'redact-me'],
  ['a quoted value with an escaped quote', '{"token":"redact\\"-me"}', '{"token":"<redacted>"}', '-me'],
  // Hex, base64 and base58 keys and seeds.
  ['32-byte hex seed', `seed 0x${'ab'.repeat(32)} used`, 'seed <hex 66 chars> used', 'abab'],
  ['uppercase hex without 0x', `k ${'AB'.repeat(32)}`, 'k <hex 64 chars>', 'ABAB'],
  ['16-byte hex entropy', `entropy 0x${'ab'.repeat(16)}`, 'entropy <hex 34 chars>', 'abab'],
  ['hex glued to an underscore or letters', `seed_0x${'ab'.repeat(32)} k${'cd'.repeat(32)} got 0x${'ef'.repeat(32)}ms`, 'seed_<hex 66 chars> k<hex 64 chars> got <hex 66 chars>ms', 'abab'],
  ['seed split in two halves', `seed: 0x${'ab'.repeat(16)} ${'ab'.repeat(16)}`, 'seed: <redacted> <hex 32 chars>', 'abab'],
  ['32-byte base64 key', `key ${Buffer.alloc(32, 7).toString('base64')}`, 'key <blob 44 chars>', 'BwcH'],
  ['32-byte base58 key', 'sk 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', 'sk <blob 43 chars>', '4vJ9'],
  ['long encoded blob', `blob ${'Q'.repeat(90)}`, 'blob <blob 90 chars>', 'QQQQ'],
  // Mnemonics: a run of 12 or more BIP-39 words in any case, with any short separator.
  ['mnemonic with spaces', `restored: ${mnemonic}`, `restored: ${wordRun}`, 'curtain'],
  ['capitalized mnemonic', `restored: ${words.map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ')}`, `restored: ${wordRun}`, 'curtain'],
  ['comma-separated mnemonic', `restored: ${words.join(', ')}`, `restored: ${wordRun}`, 'curtain'],
  ['newline-separated mnemonic', `restored:\n${words.join('\n')}`, `restored:\n${wordRun}`, 'curtain'],
  ['tab-separated mnemonic', `restored: ${words.join('\t')}`, `restored: ${wordRun}`, 'curtain'],
  ['double-spaced mnemonic', words.join('  '), wordRun, 'curtain'],
  ['mnemonic as a JSON array', JSON.stringify(words), `["${wordRun}"]`, 'curtain'],
  ['numbered mnemonic', words.map((w, i) => `${i + 1}. ${w}`).join(' '), `1. ${wordRun}`, 'curtain'],
  ['mnemonic in nested pretty-printed JSON', JSON.stringify({ a: { b: { words } } }, null, 4), `{\n    "a": {\n        "b": {\n            "words": [\n                "${wordRun}"\n            ]\n        }\n    }\n}`, 'curtain'],
  ['mnemonic joined by HTML line breaks', words.join('<br>'), wordRun, 'curtain'],
  ['mnemonic in a JSON value', `{"words":"${mnemonic}"}`, `{"words":"${wordRun}"}`, 'curtain'],
  // Other.
  ['email address', 'user redact-me@example.com failed', 'user <email> failed', 'redact-me'],
  ['ANSI and control characters', '\u001b[31mred\u001b[0m\u0007 text', 'red text', '\u001b'],
];

function expectRemoved(sanitize: (text: string) => string, input: string, output: string, secret: string) {
  const value = sanitize(input);
  expect(value).toBe(output);
  expect(value.toLowerCase()).not.toContain(secret.toLowerCase());
}

it.each(removals)('removes %s', (_name, input, output, secret) => expectRemoved(sanitizeConsoleText, input, output, secret));

it.each([
  ['the app\'s own failure line', claim],
  ['the failure line as the app logs it', '20:37:55.700 [ERR] humanity·card·username-upgrade: username upgrade failed; code="lite-owner-unavailable"'],
  ['an English error sentence of more than twelve words', 'error the host refused the request because the user has not yet signed the claim and the chain is not ready'],
  ['a colon followed by one lowercase word', 'invalid signature: expected 64 bytes'],
  ['a session message', 'session expired: please sign in again'],
  ['a missing value', 'token: missing'],
  ['a quoted word that is not a value', 'TypeError: Cannot read properties of undefined (reading \'session\')'],
  ['an SS58 address', 'owner 5FnimFV7hCmXsPmJVsnNXaTYPYz8cra65To4PkJYRhiBo7nP differs'],
  ['a large decimal number', 'balance 340282366920938463463374607431768211455 planck'],
  ['an IP address and a package version', 'from 192.168.1.20 with @parity/product-lab@0.3.0'],
  ['eleven BIP-39 words, fewer than a mnemonic', words.slice(0, 11).join(' ')],
  ['a ring list id after list-key', 'stage list-key: "peopl.paseo" holds 2 ring-VRF key(s)'],
  ['a storage key name', 'storage key: Game.Game'],
  ['a key name in JSON', '{"key":"Game","value":null}'],
  ['a session index', 'session=12 ring=3'],
  ['an SS58 public key', 'public_key=5FnimFV7hCmXsPmJVsnNXaTYPYz8cra65To4PkJYRhiBo7nP'],
  ['a relative API path that contains a path root name', 'GET /api/users/5FnimF failed'],
])('keeps %s word for word', (_name, line) => expect(sanitizeConsoleText(line)).toBe(line));

it('keeps every word of a framework warning and drops only its link path', () => {
  const warning = 'Cannot update a component (`%s`) while rendering a different component (`%s`). To locate the bad setState() call inside `%s`, follow the stack trace as described in https://react.dev/link/setstate-in-render PrizePage';
  expect(sanitizeConsoleText(warning)).toBe(warning.replace('https://react.dev/link/setstate-in-render', 'https://react.dev/<path>'));
});

it('replaces any line that names a mnemonic, seed phrase, secret key or password', () => {
  for (const line of [`mnemonic: ${mnemonic}`, 'Seed phrase stored', 'secretKey=abc', 'private key loaded', 'password reset', 'suri //Alice', 'mnemo\u001b[0mnic stored'])
    expect(sanitizeConsoleText(line)).toBe('<redacted: secret-like line>');
});

it('drops the partial last token of a line cut at the scan bound, so no part of a secret shows', () => {
  const line = `https://x.invalid/${'a'.repeat(19_950)} 0x${'ab'.repeat(40)}`;
  expect(sanitizeConsoleText(line)).toBe('https://x.invalid/<path> … [+82 chars not scanned]');
});

it('sanitizes a 20,000-character line in linear time, whatever it holds', () => {
  for (const line of [`0x${'ab'.repeat(9_999)}`, 'a'.repeat(20_000), 'a.'.repeat(10_000), 'eyJ-'.repeat(5_000), 'a@a.'.repeat(5_000)]) {
    sanitizeConsoleText(line);
    const started = performance.now(); sanitizeConsoleText(line);
    expect(performance.now() - started, line.slice(0, 8)).toBeLessThan(50);
  }
});

it('cuts a long line to the character bound and says how much was cut', () => {
  const text = sanitizeConsoleText('x '.repeat(400), 100);
  expect(text).toMatch(/^(x ){50}… \[\+700 chars\]$/);
});

it('keeps the first and the newest lines per page within the page and line bounds', () => {
  let now = 0;
  const history = new ConsoleHistory({ ...consoleLimits, perPage: 10, keepFirst: 3 }, () => ++now);
  for (let n = 1; n <= 25; n++) history.record('ada-1', 'page-1', 'log', `line ${n}`);
  const [page] = history.evidence();
  expect(page).toMatchObject({ actor: 'ada-1', page: 'page-1', recorded: 25, dropped: 15 });
  expect(page!.entries.map(entry => entry.text)).toEqual(['line 1', 'line 2', 'line 3', ...Array.from({ length: 7 }, (_, i) => `line ${19 + i}`)]);
  expect(page!.entries[0]).toEqual({ at: 1, type: 'log', text: 'line 1' });
});

it('keeps at most the page bound, dropping the oldest page', () => {
  const history = new ConsoleHistory({ ...consoleLimits, pages: 2 });
  for (const page of ['page-1', 'page-2', 'page-3']) history.record('ada-1', page, 'log', page);
  expect(history.evidence().map(page => page.page)).toEqual(['page-2', 'page-3']);
});

it('keeps the pages under their byte bound by dropping the oldest lines, and clears', () => {
  const history = new ConsoleHistory({ ...consoleLimits, attachBytes: 4_000 });
  for (let n = 0; n < 150; n++) { history.record('ada-1', 'page-1', 'error', `${n} ${'y'.repeat(90)}`); history.record('ada-1', 'page-2', 'log', `${n}`); }
  const pages = history.evidence();
  expect(Buffer.byteLength(JSON.stringify(pages))).toBeLessThanOrEqual(4_000);
  expect(pages[0]!.entries.at(-1)!.text).toMatch(/^149 /);
  expect(pages[0]!.dropped).toBeGreaterThan(100);
  history.clear(); expect(history.evidence()).toEqual([]);
});

it('keeps the whole attachment, wrapper included, under the byte bound', () => {
  for (const line of [(n: number) => `${n} ${'word '.repeat(80)}`, () => '\u2603'.repeat(500)]) {
    const history = new ConsoleHistory();
    for (let n = 0; n < 2_000; n++) history.record('ada-1', `context-1/page-${n % 3}`, 'error', line(n));
    const { json, pages } = history.attachment(lines => ({ productLab: 'humanity-failure-console', step: 'z'.repeat(500), limits: consoleLimits, pages: lines }));
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(consoleLimits.attachBytes);
    expect(Buffer.byteLength(json)).toBeGreaterThan(consoleLimits.attachBytes - 2_000);
    expect(pages.every(page => page.dropped > 0)).toBe(true);
    expect(JSON.parse(json).pages).toEqual(pages);
  }
});

it('never throws from a console listener, even for a value that cannot become text', () => {
  const history = new ConsoleHistory();
  expect(() => history.record('ada-1', 'page-1', 'log', { toString() { throw Error('no text'); } })).not.toThrow();
  expect(history.evidence()).toEqual([{ actor: 'ada-1', page: 'page-1', recorded: 1, dropped: 0, entries: [] }]);
});

// Negative control: a sanitizer that returns its input fails every removal case above, so none passes by accident.
it.each(removals)('@negative-control: an identity sanitizer fails "removes %s"', (_name, input, output, secret) => {
  expect(() => expectRemoved(text => text, input, output, secret)).toThrow();
});
