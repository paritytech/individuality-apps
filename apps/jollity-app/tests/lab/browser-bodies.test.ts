// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';

function browserSafe(body: string) {
  // Match tsx's keepNames transform, then serialize only the callback into the page.
  // An array leaves the outer callback anonymous; any __name call comes from inside it.
  const compiled = transformSync(`[${body}]`, { loader: 'ts', keepNames: true, target: 'es2022' }).code;
  if (/\b__name\s*\(/.test(compiled)) throw Error('Named inner browser function needs the unavailable __name helper');
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}
it('every Jollity scenario browser-evaluated body is safe under the tsx keepNames transform', () => {
  let checked = 0;
  for (const file of [...files(resolve(import.meta.dirname, '../../lab/scenarios')), resolve(import.meta.dirname, '../../../../lab/shared/post-game.ts')]) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const member = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
        const index = ts.isIdentifier(node.expression) && node.expression.text === 'readWatchedText' ? 1 : ['evaluate', 'addInitScript', 'waitForFunction'].includes(member) ? 0 : undefined;
        if (index !== undefined) {
          const body = node.arguments[index];
          expect(body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body)), `${file}: browser callback must be inline and audited`).toBe(true);
          try { browserSafe(body!.getText(source)); } catch (error) { throw Error(`${file}: ${String(error)}`); }
          checked++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(checked).toBeGreaterThan(0);
});
it.each(['() => { const sample = () => 1; sample(); }', '() => { function sample() { return 1; } sample(); }'])('rejects a named inner function: %s', body => {
  expect(() => browserSafe(body)).toThrow('Named inner browser function');
});
it('allows the anonymous callback slot used by the mutation watcher', () => {
  expect(() => browserSafe('() => { const sample = [() => 1][0]; sample(); }')).not.toThrow();
});
