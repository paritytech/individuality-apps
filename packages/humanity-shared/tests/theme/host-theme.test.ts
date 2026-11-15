// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThemeMode } from "@humanity/shared/chain/host-api.ts";
import { followHostTheme, resolveHostThemeId } from "@humanity/shared/theme/host-theme.ts";

const { getThemeProvider } = vi.hoisted(() => ({ getThemeProvider: vi.fn() }));
vi.mock("@humanity/shared/chain/host-api.ts", () => ({ getThemeProvider }));

const custom = (value: string, variant: ThemeMode["variant"] = "Light"): ThemeMode => ({
  name: { tag: "Custom", value },
  variant,
});

describe("resolveHostThemeId", () => {
  it("maps each iOS theme id to its palette", () => {
    for (const id of ["berlinNight", "berlinDay", "lisbon", "malta", "tokyo"]) {
      expect(resolveHostThemeId(custom(id))).toBe(id);
    }
  });

  it("matches names case-insensitively", () => {
    expect(resolveHostThemeId(custom("Tokyo"))).toBe("tokyo");
    expect(resolveHostThemeId(custom("BERLINDAY"))).toBe("berlinDay");
  });

  it("falls back to Berlin in the reported variant for Default and unknown names", () => {
    expect(resolveHostThemeId({ name: { tag: "Default" }, variant: "Dark" })).toBe("berlinNight");
    expect(resolveHostThemeId({ name: { tag: "Default" }, variant: "Light" })).toBe("berlinDay");
    expect(resolveHostThemeId(custom("kyoto", "Dark"))).toBe("berlinNight");
    expect(resolveHostThemeId(custom("constructor", "Light"))).toBe("berlinDay");
  });
});

describe("followHostTheme", () => {
  beforeEach(() => getThemeProvider.mockReset());

  it("sets data-theme on every host push", async () => {
    let push: (theme: ThemeMode) => void = () => {};
    getThemeProvider.mockResolvedValue({
      subscribeTheme: (cb: (theme: ThemeMode) => void) => {
        push = cb;
        return { unsubscribe: () => {}, onInterrupt: () => {} };
      },
    });
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;

    await followHostTheme(root);
    push(custom("malta"));
    expect(root.dataset["theme"]).toBe("malta");
    push({ name: { tag: "Default" }, variant: "Dark" });
    expect(root.dataset["theme"]).toBe("berlinNight");
  });

  it("leaves the root untouched outside a host", async () => {
    getThemeProvider.mockResolvedValue(null);
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;

    await followHostTheme(root);
    expect(root.dataset["theme"]).toBeUndefined();
  });
});
