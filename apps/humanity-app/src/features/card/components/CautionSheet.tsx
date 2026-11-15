// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The sheet on the last day of a grace window: the game is today, and it
 *  is the one that keeps the membership. It lays over the home, says the
 *  time and the stakes in a line each, and offers the game or a way past.
 *  It never traps: the scrim, Escape and the second button all put it away.
 *
 *  A modal `<dialog>` supplies the semantics: focus moves in on open, the
 *  home behind goes inert, and focus returns when it closes. Focus lands on
 *  the title rather than the first button, so a screen reader starts with
 *  the time and a sheet that opened on its own draws no focus ring. The
 *  scrim is the dialog's backdrop, so a click that lands on the dialog itself
 *  landed there. The rise and the scrim's fade are CSS, with a reduced-motion
 *  path.
 *
 *  Registration closes before the game starts, so while it is still open the
 *  sheet says when; "Today at 18:00" alone would read as time to spare. */
import { useId, useLayoutEffect, useRef, type MouseEvent } from "react";

import { Icon } from "@shared/components/icons.tsx";
import type { CautionAction } from "@features/card/domain/caution-deadline.ts";

export interface CautionSheetProps {
  /** The game's clock time today, e.g. "18:00". */
  time: string;
  /** What the person can still do about today's game, in the weekly
   *  block's terms: register, keep the registration they have, or play. */
  action: CautionAction;
  /** Time left to register, e.g. "2 hrs", while registration is open. */
  closesIn?: string | null;
  onGo: () => void;
  onLater: () => void;
}

export function CautionSheet({ time, action, closesIn = null, onGo, onLater }: CautionSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const subId = useId();

  // A layout effect, so the cleanup's `close()` runs while the dialog is
  // still in the document: that is what hands focus back to where it was.
  // A plain effect's cleanup runs after React has detached it, and a
  // detached dialog returns focus nowhere.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element == null) return;
    // A webview without modal dialogs still gets the sheet, just not modal.
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    title.current?.focus({ preventScroll: true });
    return () => {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
    };
  }, []);

  const onScrim = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onLater();
  };

  return (
    <dialog
      ref={dialog}
      className="caution-sheet"
      aria-labelledby={titleId}
      aria-describedby={subId}
      onCancel={(event) => {
        // Escape: put it away through state rather than letting the browser
        // close a dialog React still renders.
        event.preventDefault();
        onLater();
      }}
      onClick={onScrim}
    >
      <div className="sheet">
        <div className="sheet-handle" aria-hidden="true" />
        <span className="sheet-icon" aria-hidden="true">
          <Icon name="alarm" size={30} />
        </span>
        <h2 className="sheet-title" id={titleId} ref={title} tabIndex={-1}>
          Today at {time}
        </h2>
        <p className="sheet-sub" id={subId}>
          Last game to keep your membership.
        </p>
        {action === "registration-open" && closesIn != null && (
          <p className="sheet-note">Registration closes in {closesIn}</p>
        )}
        {action === "confirmed" ? (
          <button
            type="button"
            className="cta-confirmed"
            onClick={onGo}
            aria-label="Registered, open the game"
          >
            <Icon name="check" size={17} />
            Registered
          </button>
        ) : (
          <button type="button" className="cta-pill" onClick={onGo}>
            {action === "play-now" ? "Play now" : "Register"}
          </button>
        )}
        <button type="button" className="cta-ghost" onClick={onLater}>
          Not this week
        </button>
      </div>
    </dialog>
  );
}
