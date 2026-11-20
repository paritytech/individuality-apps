// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { setTimeout as delay } from 'node:timers/promises';
/** An actual animated canvas reaches Chromium's compositor before the guarded page closes. */
export async function paintVideoFrames(page: BrowserPage) {
  await page.evaluate(() => new Promise<void>(resolve => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; document.body.append(canvas);
    const context = canvas.getContext('2d'); if (!context) throw Error('No frame drawing context');
    const start = performance.now(); let frames = 0;
    const frame = () => { context.fillStyle = `hsl(${Math.floor(performance.now()) % 360} 80% 50%)`; context.fillRect(0, 0, 320, 180);
      frames++;
      if (frames >= 3 && performance.now() - start >= 300) requestAnimationFrame(() => resolve()); else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }), undefined);
}
/** Closing the browser flushes the encoder asynchronously on some runners. Empty output is still a failure. */
export async function waitForVideo<T extends { bytes: number }>(read: () => T[], timeoutMs = 5_000): Promise<T[]> {
  const end = Date.now() + timeoutMs;
  do { const files = read(); if (files.length && files.every(file => file.bytes > 0)) return files; await delay(25); } while (Date.now() < end);
  throw Error('Video recorder did not produce a non-empty file before the deadline');
}
