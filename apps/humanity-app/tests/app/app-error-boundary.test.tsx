// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearLastCard: vi.fn(),
  queryClear: vi.fn(),
  removeClient: vi.fn(() => Promise.resolve()),
}));

vi.mock("@shared/chain/query-client.ts", () => ({
  queryClient: { clear: mocks.queryClear },
}));
vi.mock("@shared/chain/query-persistence.ts", () => ({
  queryPersister: { removeClient: mocks.removeClient },
}));
vi.mock("@features/card/storage/last-card-store.ts", () => ({
  clearLastCard: mocks.clearLastCard,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ error: vi.fn(), warning: vi.fn() }),
}));

import { AppErrorBoundary } from "@app/AppErrorBoundary.tsx";

/** Throws while the flag is up. React replays a render that threw before it
 *  reaches a boundary, so the flag is lowered by the boundary's clearing step
 *  and not by the component itself: the replay must still fail. */
const stale = { present: true };

function Throws() {
  if (stale.present) throw new Error("state this build cannot render");
  return <p>the card</p>;
}

/** Clearing the caches is what removes the stale state in the app, so here
 *  it is what lets the children render. */
function clearingRemovesTheStaleState() {
  mocks.clearLastCard.mockImplementationOnce(() => {
    stale.present = false;
  });
}

beforeEach(() => {
  stale.present = true;
  // React reports every caught render error on the console; the tests assert
  // on the recovery, not the noise.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.clearLastCard.mockReset();
  mocks.queryClear.mockReset();
  mocks.removeClient.mockReset();
  mocks.removeClient.mockImplementation(() => Promise.resolve());
});

describe("AppErrorBoundary", () => {
  it("clears the browser state once and renders again", async () => {
    clearingRemovesTheStaleState();
    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(mocks.clearLastCard).toHaveBeenCalledTimes(1);
    expect(mocks.queryClear).toHaveBeenCalledTimes(1);
    expect(mocks.removeClient).toHaveBeenCalledTimes(1);
  });

  it("recovers under StrictMode's double render as well", async () => {
    clearingRemovesTheStaleState();
    render(
      <StrictMode>
        <AppErrorBoundary>
          <Throws />
        </AppErrorBoundary>
      </StrictMode>,
    );

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(mocks.clearLastCard).toHaveBeenCalledTimes(1);
  });

  it("still renders again when one clearing step throws", async () => {
    mocks.queryClear.mockImplementation(() => {
      throw new Error("store refused");
    });
    mocks.removeClient.mockImplementation(() => {
      stale.present = false;
      return Promise.resolve();
    });
    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(mocks.removeClient).toHaveBeenCalledTimes(1);
  });

  it("offers a reload when the second render fails too", async () => {
    render(
      <AppErrorBoundary>
        <Throws />
      </AppErrorBoundary>,
    );

    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByText("the card")).toBeNull();
    expect(mocks.clearLastCard).toHaveBeenCalledTimes(1);
  });
});
