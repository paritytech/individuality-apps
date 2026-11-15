// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { cn } from "@/lib/utils"
import { EYE_ART_OVERHANG, useEyeDiscArt } from "./glass-mark"
import { VideoSlot, type TileVideo } from "./tile-video"

export type TileVerdict = "approve" | "reject"

/** the verdict's wash over the photo on a turned face */
export const REJECT_WASH = 0.16
/** the covered card's wash: its light already says "rejected", so the photo stays a photo */
const COVERED_REJECT_WASH = 0.05
const APPROVE_WASH = 0.16

/**
 * The player's photo, where a face shows a player without a feed: the back
 * face, the front's verdict overlay. Before the first photo is taken it is
 * the face's dark ground.
 */
export function TileStill({ still }: { still?: string }) {
  if (!still) return <div aria-hidden className="absolute inset-0 bg-[#1a1b20]" />
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a data: URL frame; next/image can't optimize it
    <img
      src={still}
      alt=""
      aria-hidden
      draggable={false}
      className="pointer-events-none absolute inset-0 h-full w-full object-cover select-none"
    />
  )
}

/** the verdict's wash over the photo. The marks are drawn by the tile itself. */
function VerdictWash({ verdict, negWash, gradient }: { verdict: TileVerdict; negWash: number; gradient?: string }) {
  return (
    <div aria-hidden className="tile-round absolute inset-0">
      {verdict === "approve" ? (
        <div className="absolute inset-0 bg-[var(--game-approve)]" style={{ opacity: APPROVE_WASH }} />
      ) : gradient ? (
        <div className="tile-lp-wash" style={{ background: gradient }} />
      ) : negWash > 0 ? (
        <div className="absolute inset-0 bg-[var(--attest-neg)]" style={{ opacity: negWash }} />
      ) : null}
    </div>
  )
}

/**
 * The back face. The tile is a coin: every verdict change turns it a whole
 * half-turn, so the back face only holds the verdict it shows. The photo stays
 * up through a reset while the verdict content fades. `showContent` is false
 * while the face is turned away: iOS does not cull descendants with a layer of
 * their own, so only the showing face gets its verdict content.
 *
 * `covered`: the AI card (a rejected tile's glow face) lies over this face. The
 * card faces away until the turn passes edge-on, and a browser paints such a
 * layer only as it comes into view, so for a frame or two it can be blank. The
 * feed, moved here at edge-on, showed through it. Covered, the feed still
 * lives here (one element, still playing) but is not drawn, and the face wears
 * the card's own ground.
 */
export function RotationVerdictFill({
  verdict,
  video,
  videoHere,
  still,
  resetting,
  showContent,
  depth,
  frosted,
  covered = false,
}: {
  verdict: TileVerdict
  /** the tile's one feed (tile-video), or null for a player without one */
  video: TileVideo | null
  /** the feed sits in this face: the coin shows its back */
  videoHere: boolean
  still?: string
  resetting: boolean
  showContent: boolean
  /** the back face sits on the far side of the slab */
  depth: number
  /** the vote screen's rejected card: the photo frosted and shaded, no violet wash */
  frosted?: boolean
  /** the AI card covers this face: the feed is kept but not drawn (see above) */
  covered?: boolean
}) {
  return (
    <div
      aria-hidden
      className="tile-one-sided tile-3d absolute inset-0"
      style={{ zIndex: 5, transform: `translateZ(${-depth}px) rotateY(180deg)` }}
    >
      <div className={covered ? "tile-round tile-covered-ground absolute inset-0" : "tile-round absolute inset-0"}>
        {video ? <VideoSlot video={video} active={videoHere} hidden={covered} /> : covered ? null : <TileStill still={still} />}
      </div>
      {showContent && !covered ? (
        <div className={resetting ? "tile-fade is-out absolute inset-0" : "tile-fade absolute inset-0"}>
          {frosted ? (
            <div className="tile-round absolute inset-0">
              {still ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL frame; next/image can't optimize it
                <img
                  src={still}
                  alt=""
                  draggable={false}
                  className="tile-frost-photo pointer-events-none absolute inset-0 h-full w-full object-cover select-none"
                />
              ) : null}
              <div className="tile-frost-shade" />
            </div>
          ) : (
            <VerdictWash verdict={verdict} negWash={COVERED_REJECT_WASH} />
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The same verdict content on the FRONT face, for a coin that lands on its
 * front again (0°, 360°…). It lives inside the front face, whose backface is
 * hidden, so it goes away with it at every odd half-turn. Over a live feed
 * it draws no photo: the face's own `<video>` shows through the wash.
 */
export function FrontVerdictOverlay({
  verdict,
  live,
  still,
  resetting,
  showContent,
  rejectGradient,
}: {
  verdict: TileVerdict
  live: boolean
  still?: string
  resetting: boolean
  showContent: boolean
  /** low power mode: a rejected face wears this gradient in place of the violet wash */
  rejectGradient?: string
}) {
  return (
    <div aria-hidden className="absolute inset-0" style={{ zIndex: 5 }}>
      {live ? null : (
        <div className="tile-round absolute inset-0">
          <TileStill still={still} />
        </div>
      )}
      {showContent ? (
        <div className={cn("tile-fade absolute inset-0", resetting && "is-out")}>
          <VerdictWash verdict={verdict} negWash={REJECT_WASH} gradient={rejectGradient} />
        </div>
      ) : null}
    </div>
  )
}

function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 12 C 4.5 6.5 8 4 12 4 C 16 4 19.5 6.5 22 12 C 19.5 17.5 16 20 12 20 C 8 20 4.5 17.5 2 12 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  )
}
function UndoIcon() {
  return (
    <svg width="17.06" height="7.5" viewBox="0 0 17.0583 7.5" fill="none" aria-hidden>
      <path
        d="M8.75 0.833333C6.54167 0.833333 4.54167 1.65833 3 3L0 0V7.5H7.5L4.48333 4.48333C5.64167 3.51667 7.11667 2.91667 8.75 2.91667C11.7 2.91667 14.2083 4.84167 15.0833 7.5L17.0583 6.85C15.9 3.35833 12.625 0.833333 8.75 0.833333Z"
        fill="currentColor"
      />
    </svg>
  )
}
function EyeOffIcon() {
  return (
    <svg width="29.33" height="25.53" viewBox="0 0 29.3333 25.5333" fill="none" aria-hidden>
      <path
        d="M14.6667 4.73333C19.72 4.73333 24.2267 7.57333 26.4267 12.0667C25.64 13.6933 24.5333 15.0933 23.2133 16.2267L25.0933 18.1067C26.9467 16.4667 28.4133 14.4133 29.3333 12.0667C27.0267 6.21333 21.3333 2.06667 14.6667 2.06667C12.9733 2.06667 11.3467 2.33333 9.81333 2.82667L12.0133 5.02667C12.88 4.85333 13.76 4.73333 14.6667 4.73333ZM13.24 6.25333L16 9.01333C16.76 9.34667 17.3733 9.96 17.7067 10.72L20.4667 13.48C20.5733 13.0267 20.6533 12.5467 20.6533 12.0533C20.6667 8.74667 17.9733 6.06667 14.6667 6.06667C14.1733 6.06667 13.7067 6.13333 13.24 6.25333ZM1.34667 1.89333L4.92 5.46667C2.74667 7.17333 1.02667 9.44 0 12.0667C2.30667 17.92 8 22.0667 14.6667 22.0667C16.6933 22.0667 18.64 21.68 20.4267 20.9733L24.9867 25.5333L26.8667 23.6533L3.22667 0L1.34667 1.89333ZM11.3467 11.8933L14.8267 15.3733C14.7733 15.3867 14.72 15.4 14.6667 15.4C12.8267 15.4 11.3333 13.9067 11.3333 12.0667C11.3333 12 11.3467 11.96 11.3467 11.8933ZM6.81333 7.36L9.14667 9.69333C8.84 10.4267 8.66667 11.2267 8.66667 12.0667C8.66667 15.3733 11.36 18.0667 14.6667 18.0667C15.5067 18.0667 16.3067 17.8933 17.0267 17.5867L18.3333 18.8933C17.16 19.2133 15.9333 19.4 14.6667 19.4C9.61333 19.4 5.10667 16.56 2.90667 12.0667C3.84 10.16 5.2 8.58667 6.81333 7.36Z"
        fill="currentColor"
        fillOpacity={0.48}
      />
    </svg>
  )
}

/**
 * The eye chip: the pending tile's one corner affordance, a glass disc 8px in
 * from the top-right corner: the baked disc (useEyeDiscArt), the eye over it. It
 * stops its own pointer events, so the tile's gesture never starts under it.
 */
export function EyeChip({ onPress }: { onPress: () => void }) {
  const disc = useEyeDiscArt()
  return (
    <button
      type="button"
      aria-label="Ban this player"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onPress()
      }}
      className="absolute top-2 right-2 z-[3] grid size-9 place-items-center rounded-full p-2 text-white/[0.92]"
    >
      {disc ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bg-no-repeat"
          style={{ inset: `${-EYE_ART_OVERHANG * 100}%`, backgroundImage: `url(${disc})`, backgroundSize: "100% 100%" }}
        />
      ) : null}
      <span className="relative grid">
        <EyeIcon />
      </span>
    </button>
  )
}

/**
 * The banned face. It REPLACES the tile: a flat surface square with the
 * eye-off mark, the word, and the undo chip that clears the ban.
 */
export function BannedFace({ onUndo, blur }: { onUndo?: () => void; blur: boolean }) {
  return (
    <div
      className="tile-round absolute inset-0 bg-[var(--game-banned)]"
    >
      {onUndo ? (
        <button
          type="button"
          aria-label="Un-ban this player"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onUndo()
          }}
          className={cn(
            "absolute top-3 right-3 grid size-8 place-items-center rounded-full p-1.5 text-white",
            blur ? "bg-white/8 backdrop-blur-[5px]" : "bg-black/40",
          )}
        >
          <UndoIcon />
        </button>
      ) : null}
      <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-white">
        <EyeOffIcon />
        <span
          className="text-[18px] leading-[22px] font-semibold whitespace-nowrap text-[var(--game-banned-fg)]"
        >
          Banned
        </span>
      </div>
    </div>
  )
}

