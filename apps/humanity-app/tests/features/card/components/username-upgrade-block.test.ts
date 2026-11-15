// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The name form: the bare name is offered, any valid free name can be
 *  claimed, the chain's answer sits under the field, the permanence is
 *  stated once above the button, and every submitted state keeps the form
 *  inert without surfacing chain mechanics. Assertions avoid apostrophes,
 *  which server rendering escapes. */
import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  UsernameUpgradeBlock,
  availabilityLine,
  type UsernameUpgradeBlockProps,
} from "@features/card/components/UsernameUpgradeBlock.tsx";

const free = { status: "available", name: "humanity" } as const;

function render(props: Partial<UsernameUpgradeBlockProps> = {}): string {
  return renderToStaticMarkup(
    createElement(UsernameUpgradeBlock, {
      pending: false,
      unknown: false,
      confirmed: false,
      onSubmit: () => undefined,
      ...props,
    }),
  );
}

describe("UsernameUpgradeBlock", () => {
  it("prefills the editable field with the bare name and claims it by name", () => {
    const html = render({
      suggestedUsername: "humanity",
      availability: { status: "available", name: "humanity" },
    });
    expect(html).toContain('value="humanity"');
    expect(html).toContain('<button type="submit" class="cta-pill">');
    expect(html).toContain("Claim humanity");
    expect(html).toContain("humanity is available");
    expect(html).not.toContain("readonly");
  });

  it("holds the button until the chain says the name is free", () => {
    expect(render({ suggestedUsername: "humanity", availability: { status: "checking", name: "humanity" } })).toContain(
      '<button type="submit" class="cta-pill" disabled="">',
    );
    const taken = render({ suggestedUsername: "humanity", availability: { status: "taken", name: "humanity" } });
    expect(taken).toContain('<button type="submit" class="cta-pill" disabled="">');
    expect(taken).toContain("humanity is taken");
  });

  it("requires editing a suggested name shorter than the runtime minimum", () => {
    const html = render({ suggestedUsername: "alice", availability: { status: "invalid" } });
    expect(html).toContain('value="alice"');
    expect(html).toContain('<button type="submit" class="cta-pill" disabled="">');
    expect(html).toContain("At least 6 letters.");
    expect(html).not.toContain("Claim alice");
  });

  it("submits through a real form with a labelled, described field", () => {
    const html = render({ suggestedUsername: "humanity" });
    expect(html).toContain("<form");
    expect(html).toContain('type="submit"');
    const fieldId = /<input id="([^"]+)"/.exec(html)?.[1];
    expect(fieldId).toBeTruthy();
    expect(html).toContain(`aria-describedby="${fieldId}-hint"`);
    expect(html).toContain("6 to 32 letters, a to z.");
  });

  it("states once that the link between the two names is public and permanent", () => {
    const text = render({ suggestedUsername: "humanity", currentUsername: "humanity.42" }).replace(/<[^>]+>/g, " ");
    expect(text).toContain("Anyone can see humanity.42 and your new name belong together");
    expect(text).toContain("change it later");
    expect(text.match(/change it later|permanent/gi)).toHaveLength(1);
  });

  it.each([
    ["pending", { pending: true }, "Claiming"],
    ["unknown", { unknown: true }, "Waiting for confirmation"],
  ] as const)("keeps a %s submission inert and says so on the button", (_state, action, label) => {
    const html = render({ suggestedUsername: "humanity", ...action });
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toContain('<button type="submit" class="cta-pill" disabled="">');
    expect(html).toContain(label);
    expect(html).not.toContain('role="alert"');
  });

  it("asks for a second tap before it sends anything", () => {
    const html = render({ suggestedUsername: "humanity", availability: free });
    expect(html).toContain("Claim humanity");
    expect(html).not.toContain("Confirm humanity");
    expect(html).toContain("change it later");
  });

  it("keeps no sales copy and no chain words", () => {
    const text = render({ suggestedUsername: "humanity", currentUsername: "humanity.42" }).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/personhood|devicehood|\blite\b|full person|real one|chain/i);
  });

  it("keeps the button locked while the answer on screen is for another name", () => {
    const html = render({ suggestedUsername: "bobbyy", availability: { status: "available", name: "alicex" } });
    expect(html).toContain('<button type="submit" class="cta-pill" disabled="">');
  });
});

describe("availabilityLine", () => {
  it("reads the chain's answer back in plain words", () => {
    expect(availabilityLine(undefined, "")).toMatchObject({ tone: "quiet" });
    expect(availabilityLine({ status: "checking", name: "marlowe" }, "marlowe")).toMatchObject({ text: "Checking availability" });
    expect(availabilityLine({ status: "available", name: "marlowe" }, "marlowe")).toMatchObject({ text: "marlowe is available", tone: "ok" });
    expect(availabilityLine({ status: "taken", name: "marlowe" }, "marlowe")).toMatchObject({ tone: "warn" });
    const retry = () => undefined;
    expect(availabilityLine({ status: "error", name: "marlowe", retry }, "marlowe")).toMatchObject({ tone: "warn", retry });
    expect(availabilityLine({ status: "invalid" }, "marl")).toMatchObject({ text: "At least 6 letters." });
  });
});
