// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Collapsible category shell and the read-only section renderer the panel
 *  folds its state into. Fold state is per category and persisted, so the
 *  panel reopens the way it was left. */
import type { ReactNode, SyntheticEvent } from "react";

import { useDebugStore } from "./debug-store.ts";
import type { DebugSection } from "./debug-view.ts";

export function DebugCategory({
  name,
  hint,
  forceOpen = false,
  children,
}: {
  name: string;
  hint?: string;
  /** Always unfolded and not collapsible — the full page has room for all. */
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const expanded = useDebugStore((state) => state.expanded[name] === true);
  const setExpanded = useDebugStore((state) => state.setExpanded);
  return (
    <details
      className="debug-category"
      open={forceOpen || expanded}
      data-static={forceOpen || undefined}
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => {
        if (!forceOpen) setExpanded(name, event.currentTarget.open);
      }}
    >
      <summary className="debug-category-title">
        <span>{name}</span>
        {hint == null ? null : <span className="debug-category-hint">{hint}</span>}
      </summary>
      <div className="debug-category-body">{children}</div>
    </details>
  );
}

export function DebugSectionView({ section }: { section: DebugSection }) {
  return (
    <section className="debug-section">
      <h2 className="debug-title">{section.title}</h2>
      <dl className="debug-rows">
        {section.rows.map((row) => (
          <div key={row.label} className="debug-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {section.table != null && (
        <div className="debug-table-wrap">
          <table className="debug-table">
            <thead>
              <tr>
                {section.table.columns.map((column) => (
                  <th key={column} scope="col">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.table.rows.map(([label, ...cells]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {cells.map((cell, index) => (
                    <td key={index} data-label={section.table?.columns[index + 1]}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
