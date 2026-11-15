// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The scratch link (`open=scratch`) opens the scratch once the ticket is
 *  known, only when there is one to scratch, and never twice. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useOpenScratchFromLink,
  type OpenScratchFromLinkOptions,
} from "@features/prize/hooks/use-open-scratch-from-link.ts";
import { __resetOpenScratchIntentForTests } from "@shared/navigation/open-scratch-intent.ts";

let waiting: boolean | null = null;
function Probe(props: OpenScratchFromLinkOptions) {
  waiting = useOpenScratchFromLink(props);
  return null;
}

function load(search: string) {
  window.history.replaceState(null, "", `/${search}#/`);
  __resetOpenScratchIntentForTests();
}

function options(overrides: Partial<OpenScratchFromLinkOptions> = {}): OpenScratchFromLinkOptions {
  return { enabled: true, ready: true, available: true, openDaily: vi.fn(), ...overrides };
}

afterEach(() => {
  cleanup();
  waiting = null;
});

describe("useOpenScratchFromLink", () => {
  it("opens the scratch when loaded from the scratch link with a ticket to scratch", () => {
    load("?card=humanity&open=scratch");
    const props = options();
    render(<Probe {...props} />);
    expect(props.openDaily).toHaveBeenCalledTimes(1);
    // Still holding the home it opened from, so nothing else races the navigation.
    expect(waiting).toBe(true);
  });

  it("takes the request out of the address and keeps the route", () => {
    load("?card=humanity&open=scratch");
    render(<Probe {...options()} />);
    expect(window.location.search).toBe("?card=humanity");
    expect(window.location.hash).toBe("#/");
  });

  it("stays on the home when there is nothing to scratch", () => {
    load("?card=humanity&open=scratch");
    const props = options({ available: false });
    render(<Probe {...props} />);
    expect(props.openDaily).not.toHaveBeenCalled();
    expect(waiting).toBe(false);
  });

  it("does nothing on a plain card link", () => {
    load("?card=humanity");
    const props = options();
    render(<Probe {...props} />);
    expect(props.openDaily).not.toHaveBeenCalled();
    expect(waiting).toBe(false);
  });

  it("waits for the ticket to be read, then opens once", () => {
    load("?card=humanity&open=scratch");
    const props = options({ ready: false });
    const { rerender } = render(<Probe {...props} />);
    expect(props.openDaily).not.toHaveBeenCalled();
    expect(waiting).toBe(true);
    rerender(<Probe {...props} ready />);
    rerender(<Probe {...props} ready />);
    expect(props.openDaily).toHaveBeenCalledTimes(1);
  });

  it("does not open again on a later mount of the home", () => {
    load("?card=humanity&open=scratch");
    const first = options();
    render(<Probe {...first} />);
    cleanup();
    const second = options();
    render(<Probe {...second} />);
    expect(second.openDaily).not.toHaveBeenCalled();
  });
});
