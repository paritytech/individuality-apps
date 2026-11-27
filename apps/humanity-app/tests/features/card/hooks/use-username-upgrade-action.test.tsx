// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A claim that was sent but never landed comes back to the form: named, so
 *  the screen can say so, and offered again in place of the bare name. */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failed: vi.fn(),
}));

vi.mock("@features/card/hooks/use-username-upgrade-marker.ts", () => ({
  useFailedUsernameUpgrade: mocks.failed,
}));
vi.mock("@features/card/hooks/use-pending-username-upgrade.ts", () => ({
  usePendingUsernameUpgrade: () => false,
}));
vi.mock("@features/card/hooks/use-lite-username-upgrade.ts", () => ({
  useLiteUsernameUpgrade: () => ({ isPending: false, error: null, submit: vi.fn() }),
}));

import { useUsernameUpgradeAction } from "@features/card/hooks/use-username-upgrade-action.ts";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const card = {
  kind: "card",
  usernameUpgradeSupported: true,
  accountAddress: ACCOUNT,
  primaryUsername: "marlow.42",
  state: { kind: "member", activeWeeks: 3, lastAttendedGame: 42, attendanceHistory: 0xff, window: 8 },
  snapshot: { isUpgradedIdentity: false, participant: { recognition: "NotRecognized" } },
} as unknown as Parameters<typeof useUsernameUpgradeAction>[0];

beforeEach(() => {
  mocks.failed.mockReset();
});

describe("useUsernameUpgradeAction", () => {
  it("offers the bare name when no claim has failed", () => {
    mocks.failed.mockReturnValue(null);
    const { result } = renderHook(() => useUsernameUpgradeAction(card));
    expect(mocks.failed).toHaveBeenCalledWith(ACCOUNT);
    expect(result.current.action?.failedUsername).toBeUndefined();
    expect(result.current.action?.suggestedUsername).toBe("marlow");
  });

  it("names the failed claim and offers it again", () => {
    mocks.failed.mockReturnValue({ address: ACCOUNT, fullUsername: "marlowjones" });
    const { result } = renderHook(() => useUsernameUpgradeAction(card));
    expect(result.current.action?.failedUsername).toBe("marlowjones");
    expect(result.current.action?.suggestedUsername).toBe("marlowjones");
  });
});
