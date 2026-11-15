// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Everything inside the debug surface, shared by the summoned sheet and the
 *  full page. `expandedAll` (the page) shows every category unfolded; the
 *  sheet folds them to the persisted state. `actions` share the copy row. */
import type { ReactNode } from "react";

import { DebugControls } from "./DebugControls.tsx";
import { DebugCopyState } from "./DebugCopyState.tsx";
import { DebugDailyDollarRegistry } from "./DebugDailyDollarRegistry.tsx";
import { DebugLiteKeyOwnerProbe } from "./DebugLiteKeyOwnerProbe.tsx";
import { DebugLogs } from "./DebugLogs.tsx";
import { DebugMutations } from "./DebugMutations.tsx";
import { DebugSentry } from "./DebugSentry.tsx";
import { DebugCategory, DebugSectionView } from "./DebugSections.tsx";
import { useDebugStore, withChainDiagnostics } from "./debug-store.ts";
import { buildDebugView, groupDebugSections } from "./debug-view.ts";

export function DebugPanelBody({
  expandedAll = false,
  actions,
}: {
  expandedAll?: boolean;
  actions?: ReactNode;
}) {
  const input = useDebugStore((state) => state.input);
  return (
    <>
      {/* First: the whole-panel snapshot is what you reach for before
          touching any control that would change it. */}
      <DebugCopyState actions={actions} />
      <DebugCategory
        name="simulate"
        hint="card scenarios · daily dollar outcome"
        forceOpen={expandedAll}
      >
        <DebugControls />
      </DebugCategory>
      {input == null ? (
        <p className="debug-empty">No page state published yet.</p>
      ) : (
        <>
          {groupDebugSections(buildDebugView(withChainDiagnostics(input))).map((category) => (
            <DebugCategory
              key={category.name}
              name={category.name}
              hint={category.sections.map((section) => section.title).join(" · ")}
              forceOpen={expandedAll}
            >
              {category.sections.map((section) => (
                <DebugSectionView key={section.title} section={section} />
              ))}
            </DebugCategory>
          ))}
          <DebugLiteKeyOwnerProbe card={input.card} />
          {/* Last: state is what you read before deciding to act on it. */}
          <DebugCategory name="actions" hint="signs real transactions" forceOpen={expandedAll}>
            <DebugMutations input={input} />
          </DebugCategory>
        </>
      )}
      {/* Outside the published-state guard: the worker writes the registry
          from outside the page, so its records are worth reading even when
          this tab never got as far as publishing any state — and the log
          records from a first load that produced none are the ones that
          matter most. */}
      <DebugCategory
        name="daily dollar"
        hint="worker registry · notifications"
        forceOpen={expandedAll}
      >
        <DebugDailyDollarRegistry accountAddress={input?.airdrops?.accountAddress} />
      </DebugCategory>
      <DebugCategory name="sentry" hint="send a test event" forceOpen={expandedAll}>
        <DebugSentry />
      </DebugCategory>
      <DebugCategory name="logs" forceOpen={expandedAll}>
        <DebugLogs />
      </DebugCategory>
    </>
  );
}
