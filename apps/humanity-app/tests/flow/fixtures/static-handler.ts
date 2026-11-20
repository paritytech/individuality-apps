// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Exercise the real server callback without a listener, app, browser or filesystem writes.
import { resolve, extname, sep } from 'node:path';
export type Answer = { status: number; headers?: Record<string, string>; body?: string | Buffer };
export function staticHandler(source: string, files: Record<string, string | Buffer>) {
  const root = resolve('offline-static-export');
  const content = new Map(Object.entries(files).map(([path, body]) => [resolve(root, path), body]));
  const directories = new Set([root]);
  for (const path of content.keys()) for (let at = path.lastIndexOf(sep); at >= root.length; at = path.lastIndexOf(sep, at - 1)) directories.add(path.slice(0, at));
  let handler: (request: { url: string }, response: unknown) => Promise<void>;
  const createServer = (callback: typeof handler) => { handler = callback; return { listen() {} }; };
  const stat = async (path: string) => {
    if (!content.has(path) && !directories.has(path)) throw new Error('ENOENT');
    return { isDirectory: () => directories.has(path) };
  };
  const readFile = async (path: string) => { if (!content.has(path)) throw new Error('ENOENT'); return content.get(path)!; };
  // The imports and CLI argv are the only substitutions; path selection and response handling are production code.
  const executable = source.replace(/^import .*;\n/gm, '').replace('process.argv.slice(2)', 'argv');
  new Function('createServer', 'readFile', 'stat', 'resolve', 'extname', 'sep', 'argv', executable)(createServer, readFile, stat, resolve, extname, sep, [root, '0']);
  return async (url: string): Promise<Answer> => {
    const answer = {} as Answer;
    const response = { writeHead(status: number, headers?: Record<string, string>) { Object.assign(answer, { status, headers }); return this; },
      end(body?: string | Buffer) { answer.body = body; } };
    await handler!({ url }, response);
    return answer;
  };
}
