// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { cardQrPayload, qrInkFor } from "@features/card/domain/card-qr.ts";
import {
  BASIC_VARS,
  BLACK_BASE_VARS,
  CAUTION_VARS,
  DARK_SILVER_BASE_VARS,
  SILVER_BASE_VARS,
  SUSPENDED_VARS,
  WHITE_PLASTIC_VARS,
} from "@features/card/components/card-materials.ts";

describe("cardQrPayload", () => {
  it("is the bare owner account, the one both scanners turn into a chat", () => {
    expect(cardQrPayload({ ownerAccount: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5" })).toBe(
      "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    );
    expect(cardQrPayload({ ownerAccount: "  5Alice " })).toBe("5Alice");
  });

  it("draws no code for an unregistered name", () => {
    expect(cardQrPayload({ ownerAccount: null })).toBeNull();
    expect(cardQrPayload({ ownerAccount: "" })).toBeNull();
  });
});

describe("qrInkFor", () => {
  it("prints dark on every material but the black ones", () => {
    expect(qrInkFor("#DCDEE0", "#AEA6A5")).toBe("#101114");
    expect(qrInkFor("#CACFD6", "#A8AFBA")).toBe("#101114");
    expect(qrInkFor("#83878E", "#5C6067")).toBe("#101114");
    expect(qrInkFor("#17181C", "#0C0D10")).toBe("#F4F4F5");
  });

  it("keeps every material's code at 3:1 or better against both ends of its gradient", () => {
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [16, 8, 0].map((shift) => {
        const x = ((n >> shift) & 255) / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const vars of [
      BASIC_VARS, WHITE_PLASTIC_VARS, SILVER_BASE_VARS, DARK_SILVER_BASE_VARS, BLACK_BASE_VARS, CAUTION_VARS, SUSPENDED_VARS,
    ]) {
      const b1 = String(vars["--c-b1" as keyof typeof vars]);
      const b2 = String(vars["--c-b2" as keyof typeof vars]);
      const ink = qrInkFor(b1, b2);
      expect(Math.min(contrast(ink, b1), contrast(ink, b2)), `${b1}/${b2}`).toBeGreaterThanOrEqual(2.95);
    }
  });

  it("treats an unknown colour as mid grey", () => {
    expect(qrInkFor("silver", "not a colour")).toBe("#101114");
  });
});
