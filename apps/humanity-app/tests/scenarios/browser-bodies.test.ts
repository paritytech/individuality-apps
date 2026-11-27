// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';

function browserSafe(body: string) {
  // Match tsx's keepNames transform, then serialize only the callback into the page.
  // An array leaves the outer callback anonymous; any __name call comes from inside it.
  const compiled = transformSync(`[${body}]`, { loader: 'ts', keepNames: true, target: 'es2022' }).code;
  if (/\b__name\s*\(/.test(compiled)) throw Error('Named inner browser function needs the unavailable __name helper');
}
function files(directory: string, skip: string[] = []): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? skip.includes(entry.name) ? [] : files(join(directory, entry.name), skip) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}
function forwardsOwnRead(call: ts.Node, body: ts.Identifier) {
  let scope: ts.Node | undefined = call.parent;
  while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
  return !!scope && ts.isFunctionDeclaration(scope) && scope.name?.text === 'readWatchedText'
    && scope.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === 'read') && body.text === 'read'
    && !rebindsRead(scope.body);
}
// The forwarded `read` must still be the parameter: no inner declaration, parameter or assignment may rebind it.
function rebindsRead(node: ts.Node | undefined): boolean {
  if (!node) return false;
  const named = (name: ts.Node | undefined) => !!name && ts.isIdentifier(name) && name.text === 'read';
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && named(node.name)) return true;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && named(node.left)) return true;
  return !!ts.forEachChild(node, child => rebindsRead(child) || undefined);
}
it('every scenarios browser-evaluated body is safe under the tsx keepNames transform', () => {
  let checked = 0, forwarded = 0;
  // Every shared helper is audited, so a new one cannot skip the guard; vendored upstream code keeps its own seal.
  for (const file of [...files('lab/scenarios'), ...files('../../lab/shared', ['upstream']), ...['journeys', 'document-marks', 'jollity-time', 'lifecycle', 'media-registration', 'recovery', 'update'].map(file => `../../lab/cross-app/${file}.ts`)]) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const member = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
        const index = ts.isIdentifier(node.expression) && node.expression.text === 'readWatchedText' ? 1 : ['evaluate', 'addInitScript', 'waitForFunction'].includes(member) ? 0 : undefined;
        if (index !== undefined) {
          const body = node.arguments[index];
          // readWatchedText forwards its own `read` parameter; callers in this guard's scope are audited where they call it.
          // Only that exact parameter of that exact function is exempt, and only once.
          if (body && ts.isIdentifier(body) && forwardsOwnRead(node, body)) { forwarded++; ts.forEachChild(node, visit); return; }
          expect(body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body)), `${file}: browser callback must be inline and audited`).toBe(true);
          try { browserSafe(body!.getText(source)); } catch (error) { throw Error(`${file}: ${String(error)}`); }
          checked++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(checked).toBeGreaterThan(8);
  expect(forwarded).toBe(1);
});
it.each(['() => { const sample = () => 1; sample(); }', '() => { function sample() { return 1; } sample(); }'])('rejects a named inner function: %s', body => {
  expect(() => browserSafe(body)).toThrow('Named inner browser function');
});
it('allows the anonymous callback slot used by the mutation watcher', () => {
  expect(() => browserSafe('() => { const sample = [() => 1][0]; sample(); }')).not.toThrow();
});
