// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The last-day sheet: the time and the stakes, the game or a way past,
 *  and nothing that traps. A modal <dialog>, so focus and the inert home
 *  behind it come from the browser. */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CautionSheet } from "@features/card/components/CautionSheet.tsx";

beforeAll(() => {
  // jsdom has no modal dialogs; model the open flag the browser would set.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    // A detached dialog hands focus back nowhere, so note where it was.
    closedWhileConnected.push(this.isConnected);
    this.removeAttribute("open");
  };
});

const closedWhileConnected: boolean[] = [];

afterEach(() => {
  cleanup();
  closedWhileConnected.length = 0;
});

describe("CautionSheet", () => {
  it("opens as a labelled modal with the time and the stakes, and offers to register", () => {
    const onGo = vi.fn();
    const onLater = vi.fn();
    const view = render(<CautionSheet time="18:00" action="registration-open" onGo={onGo} onLater={onLater} />);
    const dialog = view.getByRole("dialog", { name: "Today at 18:00" });
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(view.getByRole("heading", { name: "Today at 18:00" }));
    expect(dialog.getAttribute("aria-describedby")).toBe(view.getByText("Last game to keep your membership.").id);
    fireEvent.click(view.getByRole("button", { name: "Register" }));
    expect(onGo).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Not this week" }));
    expect(onLater).toHaveBeenCalledTimes(1);
  });

  it("tells a member who already registered, and still opens the game", () => {
    const onGo = vi.fn();
    const view = render(<CautionSheet time="18:00" action="confirmed" onGo={onGo} onLater={vi.fn()} />);
    expect(view.queryByRole("button", { name: "Register" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Registered, open the game" }));
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  it("offers to play once registration has closed on a registered seat", () => {
    const view = render(<CautionSheet time="18:00" action="play-now" onGo={vi.fn()} onLater={vi.fn()} />);
    expect(view.getByRole("button", { name: "Play now" })).toBeTruthy();
    expect(view.getByText("Today at 18:00")).toBeTruthy();
  });

  it("puts itself away from the scrim and from Escape, but not from a tap on the sheet", () => {
    const onLater = vi.fn();
    const view = render(<CautionSheet time="18:00" action="registration-open" onGo={vi.fn()} onLater={onLater} />);
    const dialog = view.getByRole("dialog");
    fireEvent.click(view.getByText("Last game to keep your membership."));
    expect(onLater).not.toHaveBeenCalled();
    fireEvent.click(dialog);
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onLater).toHaveBeenCalledTimes(2);
  });

  it("closes the dialog while it is still in the page, so focus can go back", () => {
    const view = render(<CautionSheet time="18:00" action="registration-open" onGo={vi.fn()} onLater={vi.fn()} />);
    const dialog = view.getByRole("dialog");
    view.unmount();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(closedWhileConnected).toEqual([true]);
  });

  it("says when registration closes, and only while it is open", () => {
    const open = render(
      <CautionSheet time="18:00" action="registration-open" closesIn="2 hrs" onGo={vi.fn()} onLater={vi.fn()} />,
    );
    expect(open.getByText("Registration closes in 2 hrs")).toBeTruthy();
    open.unmount();
    const registered = render(
      <CautionSheet time="18:00" action="confirmed" closesIn="2 hrs" onGo={vi.fn()} onLater={vi.fn()} />,
    );
    expect(registered.queryByText(/Registration closes/)).toBeNull();
  });

  it("still shows the sheet in a webview without modal dialogs", () => {
    const showModal = HTMLDialogElement.prototype.showModal;
    // @ts-expect-error modelling an older webview
    delete HTMLDialogElement.prototype.showModal;
    try {
      const view = render(<CautionSheet time="18:00" action="registration-open" onGo={vi.fn()} onLater={vi.fn()} />);
      expect(view.getByRole("dialog").hasAttribute("open")).toBe(true);
    } finally {
      HTMLDialogElement.prototype.showModal = showModal;
    }
  });
});
