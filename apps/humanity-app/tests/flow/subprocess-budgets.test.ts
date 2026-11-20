// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import ts from 'typescript';

const cases = [
  ['session-state.test.ts', 'shares the owned flow between the real config loader and the next custom step', 1],
  ['registration-step.test.ts', 'executes the real three-player registration step against delayed synthetic UI and finalized reads', 1],
  ['post-game.test.ts', 'runs actual results and final credit steps for all actors and preserves the exact wrong-credit mismatch', 1],
  ['static-server.test.ts', 'runs the actual navigation custom step with the real registry and original-error control', 2],
  ['navigation-capture.test.mts', 'installs once per actor after payoff in the actual step-12 group', 1],
] as const;

it.each(cases)('%s gives its tsx subprocesses time to reach their own limits', (file, name, children) => {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let test: ts.CallExpression | undefined;
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'it' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) test = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(test, name).toBeDefined();
  function childCalls(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'execFileSync') calls.push(node);
    ts.forEachChild(node, childCalls);
  }
  childCalls(test!.arguments[1]!);
  expect(calls).toHaveLength(children);
  for (const call of calls) expect(call.arguments[2]!.getText(source)).toContain('timeout: 30_000');
  const timeout = test!.arguments[2];
  expect(timeout, 'subprocess tests must declare an explicit outer timeout').toBeDefined();
  const outerMs = Number(timeout!.getText(source).replaceAll('_', ''));
  expect(outerMs).toBeGreaterThanOrEqual(children * 30_000 + 5_000);
});
