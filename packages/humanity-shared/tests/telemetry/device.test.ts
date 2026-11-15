// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The device contract: every event carries Jollity's `device.*` tag names and
 * Sentry's `os` / `browser` contexts, read from the user agent at once and
 * refined by Android client hints when they land.
 */
import { getCurrentScope } from "@sentry/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseUserAgent, setDeviceContext } from "@humanity/shared/telemetry/device.ts";

const PIXEL =
  "Mozilla/5.0 (Linux; Android 16; Pixel 7a Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36";
const REDUCED_ANDROID =
  "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function stubNavigator(overrides: Record<string, unknown>): void {
  vi.stubGlobal("navigator", { maxTouchPoints: 0, hardwareConcurrency: 8, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
  const scope = getCurrentScope();
  const { tags, contexts } = scope.getScopeData();
  for (const key of Object.keys(tags)) scope.setTag(key, undefined);
  for (const key of Object.keys(contexts)) scope.setContext(key, null);
});

describe("parseUserAgent", () => {
  it("reads the Android model and WebView engine", () => {
    expect(parseUserAgent(PIXEL)).toEqual({
      os: "android",
      osVersion: "16",
      engine: "chromium-webview",
      engineVersion: "141.0.7390.122",
      model: "Pixel 7a",
    });
  });

  it("drops the reduced user agent's placeholder model", () => {
    expect(parseUserAgent(REDUCED_ANDROID).model).toBeNull();
  });

  it("reads an iPhone, and an iPad posing as a Mac", () => {
    expect(parseUserAgent(IPHONE)).toMatchObject({ os: "ios", osVersion: "18.6.2", engine: "webkit", model: "iPhone" });
    const desktopIpad =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
    expect(parseUserAgent(desktopIpad, 5)).toMatchObject({ os: "ios", osVersion: "18.6", model: "iPad" });
    expect(parseUserAgent(desktopIpad, 0)).toMatchObject({ os: "macos", osVersion: "10.15.7", model: null });
  });
});

describe("setDeviceContext", () => {
  it("tags an iPhone synchronously, with Sentry's os and browser contexts", () => {
    stubNavigator({ userAgent: IPHONE });
    setDeviceContext();
    const data = getCurrentScope().getScopeData();
    expect(data.tags).toEqual({
      "device.os": "ios",
      "device.os_version": "18.6",
      "device.model": "iPhone",
      "device.engine": "webkit",
      "device.cores": "8",
    });
    expect(data.contexts.os).toEqual({ name: "iOS", version: "18.6.2" });
    expect(data.contexts.browser).toMatchObject({ name: "WebKit" });
    // No device context on iOS: "iPhone" is not a model.
    expect(data.contexts.device).toBeUndefined();
  });

  it("tags Android from the user agent, then refines it from client hints", async () => {
    const listeners: Array<() => void> = [];
    const connection = {
      type: "cellular",
      effectiveType: "3g",
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    };
    stubNavigator({
      userAgent: REDUCED_ANDROID,
      deviceMemory: 4,
      connection,
      userAgentData: {
        getHighEntropyValues: () =>
          Promise.resolve({
            model: "motorola edge 30 pro",
            platformVersion: "14.0.0",
            fullVersionList: [{ brand: "Android WebView", version: "141.0.7390.122" }],
          }),
      },
    });
    setDeviceContext();
    const scope = getCurrentScope();
    expect(scope.getScopeData().tags).toEqual({
      "device.os": "android",
      "device.os_version": "10",
      "device.engine": "chromium-webview",
      "device.engine_version": "141",
      "device.cores": "8",
      "device.memory": "4",
      "net.type": "cellular",
      "net.effective": "3g",
    });

    await vi.waitFor(() => expect(scope.getScopeData().tags["device.model"]).toBe("motorola edge 30 pro"));
    expect(scope.getScopeData().tags["device.os_version"]).toBe("14");
    expect(scope.getScopeData().contexts.device).toMatchObject({ model: "motorola edge 30 pro", memory: 4 });

    connection.effectiveType = "4g";
    connection.type = "wifi";
    for (const listener of listeners) listener();
    expect(scope.getScopeData().tags).toMatchObject({ "net.type": "wifi", "net.effective": "4g" });
  });

  it("never throws without a navigator", () => {
    vi.stubGlobal("navigator", undefined);
    expect(() => setDeviceContext()).not.toThrow();
  });
});
