// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { browserAvailable } from '../../../apps/humanity-app/tests/chromium.ts';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { PlaywrightBrowserLauncher } from '@parity/product-lab/browser-playwright';
import { ScenarioNetwork } from '../../shared/network.ts';

type FixtureWindow = Window & { __rtc: RTCPeerConnection; __source?: MediaStream; __video: HTMLVideoElement };
// Independent pages and contexts, like the media players; no ICE service or external peer.
it.skipIf(!browserAvailable(chromium.executablePath()))('decodes native peer video between isolated contexts with the network guard; denied mDNS is the negative control', async () => {
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>local peer fixture</title>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture port missing');
  const outcomes = [];
  try {
    for (const sameHostMedia of [false, true]) {
      const launcher = new PlaywrightBrowserLauncher();
      const network = new ScenarioNetwork(join(process.cwd(), '.product-lab/rtc-control', String(sameHostMedia)));
      network.beginTag(['@C4']); network.forActor('ada-1');
      network.launchArguments.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');
      if (sameHostMedia) network.launchArguments.push('--disable-features=WebRtcHideLocalIpsWithMdns');
      const browser = await network.launch(launcher);
      try {
        const sender = await browser.newPage(), receiver = await browser.newPage();
        for (const page of [sender, receiver]) {
          await page.goto(`http://127.0.0.1:${address.port}/`);
          await page.evaluate(() => {
            const w = window as unknown as FixtureWindow, pc = w.__rtc = new RTCPeerConnection({ iceServers: [] });
            const video = w.__video = document.createElement('video'); video.autoplay = true; video.muted = true; document.body.append(video);
            pc.ontrack = event => { video.srcObject = event.streams[0]!; void video.play(); };
          }, undefined);
        }
        const offer = await sender.evaluate(async () => {
          const w = window as unknown as FixtureWindow, pc = w.__rtc;
          const source = w.__source = await navigator.mediaDevices.getUserMedia({ video: true });
          source.getTracks().forEach(track => pc.addTrack(track, source));
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 1000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } }); });
          return pc.localDescription!.toJSON();
        }, undefined);
        const answer = await receiver.evaluate(async offer => {
          const pc = (window as unknown as FixtureWindow).__rtc; await pc.setRemoteDescription(offer);
          await pc.setLocalDescription(await pc.createAnswer());
          await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 1000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } }); });
          return pc.localDescription!.toJSON();
        }, offer);
        await sender.evaluate(async answer => (window as unknown as FixtureWindow).__rtc.setRemoteDescription(answer), answer);
        const media = await receiver.evaluate(async () => {
          const pc = (window as unknown as FixtureWindow).__rtc, deadline = performance.now() + 5000;
          let frames = 0;
          while (performance.now() < deadline && !frames) {
            const stats = await pc.getStats(); stats.forEach(row => { if (row.type === 'inbound-rtp' && row.kind === 'video') frames += Number(row.framesDecoded ?? 0); });
            if (!frames) await new Promise(resolve => setTimeout(resolve, 100));
          }
          return { frames, state: pc.connectionState, ice: pc.iceConnectionState };
        }, undefined);
        const outsideHttpBlocked = await receiver.evaluate(() => fetch('https://outside.invalid/media-probe').then(() => false, () => true), undefined);
        expect(outsideHttpBlocked).toBe(true);
        expect((await network.snapshot()).outsideHostsAllowed).toEqual([]);
        outcomes.push({ sameHostMedia, ...media, outsideHttpBlocked });
      } finally { await browser.close(); }
    }
    if (process.env.HUMANITY_CROSS_APP_RTC_REPORT) writeFileSync(process.env.HUMANITY_CROSS_APP_RTC_REPORT, JSON.stringify(outcomes, null, 2) + '\n');
    expect(outcomes[0]!.frames, 'negative control: resolver denies randomized .local candidates').toBe(0);
    expect(outcomes[1]!.frames, 'same-host media must decode real video across contexts').toBeGreaterThan(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
