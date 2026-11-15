// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
// This suite mounts a React hook, so it needs a DOM; the project default is
// `environment: "node"` (see vite.config.ts). Do not remove.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type DomainError =
  | { tag: "NotPresented" | "UserMoving" }
  | { tag: "Unknown"; value: { reason: string } };
type FaceError =
  | { tag: "Domain"; value: { tag: "V1"; value: DomainError } }
  | { tag: "Denied" | "Unsupported" };

/** The two members of a neverthrow `Result` the controller reads. */
const ok = () => ({ isOk: () => true as const, error: undefined });
const err = (error: FaceError) => ({ isOk: () => false as const, error });
const domain = (tag: "NotPresented" | "UserMoving"): FaceError => ({
  tag: "Domain",
  value: { tag: "V1", value: { tag } },
});

/** A host answer the test settles by hand, to order it against releases. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  setFaceShown: vi.fn(),
  getTruApi: vi.fn(),
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getTruApi: mocks.getTruApi,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

import {
  FACE_RETRY_MS,
  __resetCardFaceForTests,
  holdCardFaceHidden,
  useCardFaceHidden,
} from "@shared/hooks/card-face.ts";

/** Lets pending host calls and the release tick settle. */
const settle = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const calls = () => mocks.setFaceShown.mock.calls.map(([request]) => request.shown);

beforeEach(() => {
  vi.useFakeTimers();
  __resetCardFaceForTests();
  mocks.setFaceShown.mockReset().mockResolvedValue(ok());
  mocks.getTruApi.mockReset().mockResolvedValue({ expandedCard: { setFaceShown: mocks.setFaceShown } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCardFaceHidden", () => {
  it("hides the face on open and brings it back on unmount", async () => {
    const { unmount } = renderHook(() => useCardFaceHidden(true));
    await settle();
    expect(calls()).toEqual([false]);

    unmount();
    await settle();
    expect(calls()).toEqual([false, true]);
  });

  it("brings the face back when it turns inactive", async () => {
    const { rerender } = renderHook(({ active }) => useCardFaceHidden(active), {
      initialProps: { active: true },
    });
    await settle();
    rerender({ active: false });
    await settle();
    expect(calls()).toEqual([false, true]);
  });

  it("sends nothing more on a re-render with active unchanged", async () => {
    const { rerender } = renderHook(({ active }) => useCardFaceHidden(active), {
      initialProps: { active: true },
    });
    await settle();
    rerender({ active: true });
    rerender({ active: true });
    await settle(FACE_RETRY_MS * 2);
    expect(calls()).toEqual([false]);
  });

  it("asks nothing while inactive", async () => {
    const { unmount } = renderHook(() => useCardFaceHidden(false));
    await settle();
    unmount();
    await settle();
    expect(mocks.setFaceShown).not.toHaveBeenCalled();
  });

  it("keeps the face hidden while any surface still holds it", async () => {
    const first = renderHook(() => useCardFaceHidden(true));
    const second = renderHook(() => useCardFaceHidden(true));
    await settle();
    expect(calls()).toEqual([false]);

    first.unmount();
    await settle();
    expect(calls()).toEqual([false]);

    second.unmount();
    await settle();
    expect(calls()).toEqual([false, true]);
  });

  it("hands the hold from one surface to the next without the face coming back", async () => {
    const outgoing = renderHook(() => useCardFaceHidden(true));
    await settle();
    // A route change: the old surface unmounts and the new one mounts in the
    // same tick.
    outgoing.unmount();
    const incoming = renderHook(() => useCardFaceHidden(true));
    await settle();
    expect(calls()).toEqual([false]);

    incoming.unmount();
    await settle();
    expect(calls()).toEqual([false, true]);
  });

  it("releases a hold only once, however often its release is called", async () => {
    const a = holdCardFaceHidden();
    const b = holdCardFaceHidden();
    a();
    a();
    await settle();
    expect(calls()).toEqual([false]);
    b();
    await settle();
    expect(calls()).toEqual([false, true]);
  });

  it.each([
    ["NotPresented", err(domain("NotPresented"))],
    ["Denied", err({ tag: "Denied" })],
    ["Unsupported", err({ tag: "Unsupported" })],
    [
      "Unknown",
      err({ tag: "Domain", value: { tag: "V1", value: { tag: "Unknown", value: { reason: "x" } } } }),
    ],
  ])("treats %s as a quiet no-op, with no retry", async (_name, result) => {
    mocks.setFaceShown.mockResolvedValue(result);
    const { unmount } = renderHook(() => useCardFaceHidden(true));
    await settle(FACE_RETRY_MS * 4);
    expect(calls()).toEqual([false]);
    unmount();
    await settle();
    expect(calls()).toEqual([false, true]);
  });

  it("does nothing without a host API, and does not throw", async () => {
    mocks.getTruApi.mockResolvedValue(null);
    const { unmount } = renderHook(() => useCardFaceHidden(true));
    await settle();
    unmount();
    await settle();
    expect(mocks.setFaceShown).not.toHaveBeenCalled();
  });

  it("swallows a rejected host call", async () => {
    mocks.setFaceShown.mockRejectedValue(new Error("transport closed"));
    const { unmount } = renderHook(() => useCardFaceHidden(true));
    await settle();
    unmount();
    await settle();
    expect(calls()).toEqual([false, true]);
  });

  it("retries once after UserMoving, and only once", async () => {
    mocks.setFaceShown.mockResolvedValue(err(domain("UserMoving")));
    renderHook(() => useCardFaceHidden(true));
    await settle();
    expect(calls()).toEqual([false]);

    await settle(FACE_RETRY_MS);
    expect(calls()).toEqual([false, false]);

    await settle(FACE_RETRY_MS * 4);
    expect(calls()).toEqual([false, false]);
  });

  it("drops a pending retry when the surface closes first", async () => {
    mocks.setFaceShown.mockResolvedValueOnce(err(domain("UserMoving")));
    const { unmount } = renderHook(() => useCardFaceHidden(true));
    await settle();
    unmount();
    await settle(FACE_RETRY_MS * 2);
    expect(calls()).toEqual([false, true]);
  });

  it("does not re-hide when a hide answers UserMoving after the surface released", async () => {
    const hide = deferred<ReturnType<typeof err>>();
    mocks.setFaceShown.mockReturnValueOnce(hide.promise);
    const { unmount } = renderHook(() => useCardFaceHidden(true));
    await settle();
    unmount();
    await settle();
    expect(calls()).toEqual([false, true]);

    hide.resolve(err(domain("UserMoving")));
    await settle(FACE_RETRY_MS * 4);
    expect(calls()).toEqual([false, true]);
  });

  it("retries only the latest hide when two in-flight hides both answer UserMoving", async () => {
    const first = deferred<ReturnType<typeof err>>();
    const second = deferred<ReturnType<typeof err>>();
    mocks.setFaceShown
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok())
      .mockReturnValueOnce(second.promise);

    // A hide, its release (the face is asked back), and a new hold, all before
    // the host has answered either hide.
    const a = renderHook(() => useCardFaceHidden(true));
    await settle();
    a.unmount();
    await settle();
    const b = renderHook(() => useCardFaceHidden(true));
    await settle();
    expect(calls()).toEqual([false, true, false]);

    first.resolve(err(domain("UserMoving")));
    second.resolve(err(domain("UserMoving")));
    await settle(FACE_RETRY_MS);
    // One retry, for the hide that is still current.
    expect(calls()).toEqual([false, true, false, false]);

    // The user drags the face back; nothing hides it again.
    await settle(FACE_RETRY_MS * 4);
    expect(calls()).toEqual([false, true, false, false]);
    b.unmount();
  });
});
