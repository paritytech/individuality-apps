// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The one ladder the home tells, with the rung the person stands on
 *  marked, and each rung saying concretely what it is and what it brings.
 *  Each rung carries a swatch in the material it earns, so the story reads
 *  the way the card does. Shown only while there is a rung left to climb
 *  (`journeyStory`). */
import type { CSSProperties } from "react";
import { Icon } from "@shared/components/icons.tsx";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { journeyStory, type JourneyStep } from "@features/card/domain/journey-story.ts";
import { SWATCH_BACKGROUNDS } from "./card-materials.ts";

interface Rung {
  title: string;
  sub: string;
  swatch: CSSProperties;
  /** The candidate swatch carries the stripe's first heat accent. */
  stripe?: string;
}

const RUNGS: readonly Rung[] = [
  {
    title: "Register for the game",
    // The time is on the game block; how the game works is in its chat.
    sub: "Only takes two minutes to win CASH prizes.",
    swatch: { background: SWATCH_BACKGROUNDS.person },
  },
  {
    title: "Play every week",
    sub: "Each game counts toward membership.",
    swatch: { background: SWATCH_BACKGROUNDS.candidate },
    stripe: "#E06716",
  },
  {
    title: "Become a member",
    // Not "marlow instead of marlow.42": the bare name can be taken, and the
    // person chooses any name they like.
    sub: "A name without numbers, and a daily chance to win a dollar.",
    swatch: { background: SWATCH_BACKGROUNDS.member },
  },
];

export interface JourneyStoryProps {
  state: HumanityCardState;
}

export function JourneyStory({ state }: JourneyStoryProps) {
  const story = journeyStory(state);
  if (story == null) return null;
  return (
    <section className="card-block story-block">
      <div className="card-label">How membership works</div>
      <ol className="story" aria-label="Your path to membership">
        {RUNGS.map((rung, index) => {
          const step = index as JourneyStep;
          const done = story.current != null && step < story.current;
          const current = story.current === step;
          const className = [
            "story-row",
            done ? "is-done" : "",
            current ? "is-current" : "",
            !done && !current ? "is-future" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li className={className} key={rung.title} aria-current={current ? "step" : undefined}>
              <i className="mini-card" style={rung.swatch} aria-hidden="true">
                {rung.stripe != null && <b style={{ background: rung.stripe }} />}
                {done && <Icon name="check" size={14} />}
              </i>
              <div className="story-text">
                <div className="story-title">{rung.title}</div>
                <div className="story-sub">{rung.sub}</div>
              </div>
              {current && <span className="route-chip">You&apos;re here</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
