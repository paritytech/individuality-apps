// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A bounded, sanitized record of each guarded page's console, kept in memory and attached only to a failed step.
// Text is sanitized when it is recorded, so no raw console line is ever retained.
import { wordlist as bip39English } from '@scure/bip39/wordlists/english';

export type ConsoleEntry = { at: number; type: string; text: string };
export type ConsolePageEvidence = { actor: string; page: string; recorded: number; dropped: number; entries: ConsoleEntry[] };
export type ConsoleLimits = { pages: number; perPage: number; keepFirst: number; textChars: number; attachBytes: number };

export const consoleLimits: ConsoleLimits = { pages: 16, perPage: 200, keepFirst: 20, textChars: 500, attachBytes: 48_000 };
/** Longer lines are cut before sanitizing, which bounds the regex work; the result is cut again to `textChars`. */
const scanChars = 20_000;

/** A finite class for a URL path, never the path itself: `/`, `/<asset>`, a Sentry envelope or `/<path>`. */
export function pathClass(pathname: string) {
  return /^\/api\/\d+\/envelope\/?$/.test(pathname) ? '/api/<n>/envelope/' :
    pathname === '/' || pathname === '' ? '/' : /\.(?:js|mjs|css|woff2?|png|svg|ico)$/.test(pathname) ? '/<asset>' : '/<path>';
}

const secretLine = /mnemonic|seed[ _-]?phrase|secret[ _-]?(?:key|uri|phrase|seed)|private[ _-]?key|password|passphrase|\bsuri\b/i;
const bip39 = new Set(bip39English);
/** Twelve words is the shortest BIP-39 mnemonic. */
const mnemonicWords = 12;
/** The most non-space, non-letter characters allowed between two words of one mnemonic (`","`, `2.`, `<br>`).
 * Whitespace never counts, so pretty-printed JSON stays one run. */
const mnemonicGap = 8;
// Every rule that can start inside a long run of word characters has a left anchor, so it starts only at the run's
// first character and stays linear on a 20,000-character line.
const url = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi;
const schemelessUrl = /(?<![\w:/])\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?(?:[/?#][^\s'"`<>()]*)?/gi;
const headerLine = /\b((?:proxy-)?authorization|set-cookie|cookie)(["'`]?\s*[:=]\s*)\S[^\n]*/gi;
const email = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;
const bearer = /\bBearer\s+[^\s,;"']+/gi;
const jwt = /(?<![\w-])eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]+/g;
const assignmentKey = String.raw`(?:access|refresh|id|auth|api|session|csrf|xsrf)?[_-]?token|auth|api[_-]?key|access[_-]?key|` +
  String.raw`priv(?:ate)?[_-]?key|client[_-]?secret|secret|(?<![_-])session(?:[_-]?id)?|sid|jwt|dsn|sig|signature|entropy|seed|sk|(?<![_-])key|otp|pin`;
const assignment = new RegExp(String.raw`(?<![A-Za-z0-9])(${assignmentKey})(["'\`]?\s*([:=])\s*)` +
  String.raw`("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|\`(?:[^\`\\\n]|\\.)*\`?|[^\s,;"'\`})\]]+)`, 'gi');
const query = /\?[A-Za-z_][\w.%[\]-]*=[^\s'"`<>()]*/g;
const pathRoots = 'Users|home|private|tmp|var|opt|root|Volumes|nix|run|srv|mnt|usr|etc|Library|System|Applications|workspace|github|__w|runner|builds';
const localPath = new RegExp(String.raw`(?<![\w.-])(?:\b[A-Za-z]:[\\/]|\/(?:${pathRoots})\/|%2F(?:${pathRoots})%2F|~(?:[A-Za-z_][\w.-]*)?\/)[^\s'"\`<>()]*`, 'gi');
const longHex = /(?<![0-9a-f])(?:0x)?[0-9a-f]{32,}(?![0-9a-f])/gi;
const encoded = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])/g;
const ss58Like = /^[1-9A-HJ-NP-Za-km-z]{46,50}$/;
// eslint-disable-next-line no-control-regex
const control = /\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

function safeUrl(value: string, schemeless = false) {
  try {
    const parsed = new URL(schemeless ? `https:${value}` : value);
    if (parsed.protocol === 'file:') return '<file url>';
    const rest = parsed.search || parsed.hash ? '?<query>' : '';
    return `${schemeless ? '' : parsed.protocol}//${parsed.host}${pathClass(parsed.pathname)}${rest}`;
  } catch { return '<url>'; }
}

/** Replaces each run of at least twelve English BIP-39 words, in any case, with at most eight characters other than
 * letters and whitespace between two words (commas, quotes, brackets, numbering, `<br>`). One word outside the list
 * ends a run. */
function redactMnemonics(text: string) {
  const spans: [number, number][] = [];
  let start = -1, end = -1, count = 0;
  const close = () => { if (count >= mnemonicWords) spans.push([start, end]); count = 0; };
  // An HTML-like tag (`<br>`, `</li>`) is part of a gap, not a word.
  for (const word of text.matchAll(/<\/?[A-Za-z][^<>\n]{0,40}>|[A-Za-z]+/g)) {
    if (word[0].startsWith('<')) continue;
    const at = word.index;
    if (count && text.slice(end, at).replace(/\s+/g, '').length > mnemonicGap) close();
    if (bip39.has(word[0].toLowerCase())) { if (!count) start = at; count++; end = at + word[0].length; }
    else close();
  }
  close();
  let value = text;
  for (const [from, to] of spans.reverse()) value = `${value.slice(0, from)}<redacted: word sequence>${value.slice(to)}`;
  return value;
}

function redactAssignment(all: string, key: string, separator: string, kind: string, value: string) {
  const quote = /^["'`]/.test(value) ? value[0]! : '';
  // `invalid signature: expected 64 bytes` and `token: missing` are messages, not values: after a colon, one bare
  // lowercase word is kept. Any `=` value, any quoted value and anything else after a colon is removed.
  if (!quote && kind === ':' && /^[a-z]{1,16}$/.test(value)) return all;
  // A bare `key` or `session` name is common evidence (`storage key: Game.Game`, `session=12`): its value goes only
  // when it looks like a credential, 8 or more characters with a letter and a digit, or 16 or more characters.
  const inner = quote ? value.slice(1, value.endsWith(quote) && value.length > 1 ? -1 : undefined) : value;
  if (/^(?:key|session)$/i.test(key) && !(inner.length >= 16 || (inner.length >= 8 && /\d/.test(inner) && /[a-z]/i.test(inner)))) return all;
  return `${key}${separator}${quote}<redacted>${quote && value.length > 1 && value.endsWith(quote) ? quote : ''}`;
}

/** Keeps the message's words and codes. Drops mnemonics, URL paths, user info, queries and fragments, local paths,
 * email addresses, credential values, long hex and key-sized encoded values, and any line that names a mnemonic, seed
 * or password. The README's "Failure evidence" section lists each rule. */
export function sanitizeConsoleText(text: string, max = consoleLimits.textChars): string {
  // A line cut at the scan bound loses its last, partial token, which no rule could recognize whole.
  const scanned = text.length > scanChars ? text.slice(0, scanChars).replace(/\S*$/, '') : text;
  const cut = text.length - scanned.length;
  const clean = scanned.replace(control, '');
  if (secretLine.test(clean)) return '<redacted: secret-like line>';
  const sanitized = redactMnemonics(clean)
    .replace(url, value => safeUrl(value))
    .replace(schemelessUrl, value => safeUrl(value, true))
    .replace(headerLine, (_all, key: string, separator: string) => `${key}${separator}<redacted>`)
    .replace(email, '<email>')
    .replace(bearer, 'Bearer <redacted>')
    .replace(jwt, '<redacted: jwt>')
    .replace(assignment, redactAssignment)
    .replace(query, '?<query>')
    .replace(localPath, '<local path>')
    .replace(longHex, hex => /^\d+$/.test(hex) ? hex : `<hex ${hex.length} chars>`)
    .replace(encoded, blob => blob.length < 80 && (ss58Like.test(blob) || !/[a-z]/.test(blob) || !/[A-Z]/.test(blob)) ? blob : `<blob ${blob.length} chars>`);
  const value = cut ? `${sanitized}… [+${cut} chars not scanned]` : sanitized;
  return value.length > max ? `${value.slice(0, max)}… [+${value.length - max} chars]` : value;
}

type PageLog = { actor: string; page: string; recorded: number; dropped: number; entries: ConsoleEntry[] };

export class ConsoleHistory {
  private logs = new Map<string, PageLog>();
  constructor(private readonly limits: ConsoleLimits = consoleLimits, private readonly clock = () => Date.now()) {}
  /** Records one console message or uncaught page error. Never throws: a console listener must not disturb the page. */
  record(actor: string, page: string, type: string, text: unknown) {
    try {
      const key = `${actor}\u0000${page}`;
      let log = this.logs.get(key);
      if (!log) {
        log = { actor, page, recorded: 0, dropped: 0, entries: [] };
        this.logs.set(key, log);
        if (this.logs.size > this.limits.pages) this.logs.delete(this.logs.keys().next().value!);
      }
      log.recorded++;
      log.entries.push({ at: this.clock(), type: String(type).slice(0, 16), text: sanitizeConsoleText(String(text), this.limits.textChars) });
      // Keep the first lines (start-up) and the most recent ones; drop from the middle.
      if (log.entries.length > this.limits.perPage) { log.entries.splice(this.limits.keepFirst, 1); log.dropped++; }
    } catch { /* Best effort: losing a console line never fails the page or the step. */ }
  }
  /** One actor's pages, wrapped by `wrap`, dropping the oldest lines of the largest page until the whole wrapped
   * JSON is at most `attachBytes`. Returns the JSON text to attach. */
  attachment(wrap: (pages: ConsolePageEvidence[]) => object, actor?: string): { json: string; pages: ConsolePageEvidence[] } {
    const pages = [...this.logs.values()].filter(log => actor === undefined || log.actor === actor)
      .map(log => ({ actor: log.actor, page: log.page, recorded: log.recorded, dropped: log.dropped, entries: [...log.entries] }));
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1;
    let total = bytes(wrap(pages.map(page => ({ ...page, entries: [] })))) + pages.reduce((sum, page) => sum + page.entries.reduce((n, entry) => n + bytes(entry), 0), 0);
    // Eight bytes per page cover the growth of its `dropped` count.
    while (total + 8 * pages.length > this.limits.attachBytes) {
      const largest = pages.reduce((a, b) => b.entries.length > a.entries.length ? b : a, pages[0]!);
      if (!largest?.entries.length) break;
      total -= bytes(largest.entries.shift()); largest.dropped++;
    }
    return { json: JSON.stringify(wrap(pages)), pages };
  }
  /** One actor's pages within `attachBytes` on their own. */
  evidence(actor?: string): ConsolePageEvidence[] { return this.attachment(pages => pages, actor).pages; }
  clear() { this.logs.clear(); }
}
