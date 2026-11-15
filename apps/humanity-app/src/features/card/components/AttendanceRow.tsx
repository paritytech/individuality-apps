// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A member's recent games as a row of marks, straight off the runtime's
 *  attendance byte, with the streak the card is on. Nothing here is dated:
 *  the chain keeps no past game dates, so the marks say how many games ago.
 *  Slots from before the person started playing are drawn apart and never
 *  counted as played. */
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { attendanceRow, type AttendanceMark } from "@features/card/domain/attendance-row.ts";

/** The value line: how the streak reads to the person holding the card. */
function streakLabel(streak: number): string {
  if (streak === 0) return "Missed the last game";
  return `${streak} in a row`;
}

function markTitle(mark: AttendanceMark): string {
  if (mark.before) return "before you started playing";
  const when =
    mark.gamesAgo === 0
      ? "last game"
      : mark.gamesAgo === 1
        ? "the game before"
        : `${mark.gamesAgo} games ago`;
  const what = mark.attended ? "played" : "missed";
  return mark.gameIndex == null ? `${what}, ${when}` : `${what}, ${when} (game ${mark.gameIndex})`;
}

export function AttendanceRow({ state }: { state: HumanityCardState }) {
  const row = attendanceRow(state);
  if (row == null) return null;
  const attended = row.marks.filter((mark) => mark.attended).length;
  const span = row.recorded === 1 ? "last game" : `last ${row.recorded} games`;
  const summary =
    row.recorded === 1
      ? attended === 1
        ? "Played the last game"
        : "Missed the last game"
      : `Played ${attended} of the ${span}, ${
          row.streak === 0 ? "missed the last one" : `${row.streak} in a row`
        }`;
  return (
    <section className="card-block attendance-row" aria-label={summary}>
      <div className="attendance-copy">
        <div className="card-label">Attendance</div>
        <div className="card-value">{streakLabel(row.streak)}</div>
      </div>
      <div className="attendance-marks">
        <div className="marks-row" role="img" aria-label={summary}>
          {row.marks.map((mark) => (
            <i
              key={mark.gamesAgo}
              className={[
                "mark",
                mark.before ? "is-before" : mark.attended ? "is-attended" : "is-missed",
                mark.before || mark.counts ? "" : "is-outside",
              ]
                .filter(Boolean)
                .join(" ")}
              title={markTitle(mark)}
            />
          ))}
        </div>
        <div className="block-note">{span}</div>
      </div>
    </section>
  );
}
