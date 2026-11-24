// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The chest — what you earned this game: every NFT claim credit awarded to
 * you, resolved to its collectable (name, rarity, artwork via the preimage
 * manager in-host / the Bulletin gateway in a browser). The vessel (the chest
 * SCENE, lib/chest-scene) is on screen from the start: it lands and collects
 * the claims as they come, each one flying in, then opens (the screen decides
 * when) and the collectables settle into a floating scatter; tap to pop them.
 * There is no loading ring: a vessel that is still collecting is the wait.
 *
 * What it shows and when is the screen's reducer (lib/chest/chest-screen),
 * run by its host for the page's life (lib/chest/use-chest-screen). This page
 * renders the view and sends what the vessel and the player do; the only
 * state it keeps is the picker's.
 *
 * The chest is the last beat of the game: its Continue ends the payoff and
 * hands the player over to their Humanity card (lib/membership/humanity-target).
 * While the Pocket is up there is no Continue: closing the Pocket's cover does
 * the same, by itself.
 *
 * Identity: the source's player + their last attended game. URL override
 * (development builds only, lib/debug/dev-url.ts):
 * /chest?player=<ss58>&game=<index> reads any account against the chain the
 * source watches (read-only ws mode included).
 */
import { useEffect, useRef, useState } from "react"
import { canChangePick } from "@jollity/collectables"
import { ChestScene, type PieceSpot } from "@/components/chest/chest-scene"
import { Starfield } from "@/components/chest/starfield"
import { NftPicker } from "@/components/collectable/nft-picker"
import { PocketClaim } from "@/components/pocket/pocket-claim"
import { bookTop } from "@/lib/pocket/book"
import { Button } from "@/components/ui/button"
import { MessageScreen } from "@/components/ui/screen"
import { chestRestartCardCopy } from "@/lib/chain-health"
import type { NothingWhy } from "@/lib/chest/chest-screen"
import { useChestScreen } from "@/lib/chest/use-chest-screen"
import { SLOW_PAYOFF_COPY } from "@/lib/slow-payoff"

/** why there is nothing in the chest, in the player's words */
const NOTHING: Record<NothingWhy, string> = {
  "report-missed":
    "Your votes didn't arrive before voting closed, so this game has nothing for your chest. Join the next one to collect.",
  "no-attestations": "Nobody thought you were human enough this game. Play again and convince them.",
  absent: "Nobody thought you were human enough this game. Play again and convince them.",
  pocketed: "Everything you earned this game is already in your Pocket.",
  pruned: "You earned collectables in this game, but it is too old to show them any more. Play a new game to fill your chest.",
  "no-identity": "No player identity here — open Jollity in the Polkadot app to see your collectables.",
  "not-recognised": "Nobody thought you were human enough this game. Play again and convince them.",
}

const WAIT_COPY = {
  slow: SLOW_PAYOFF_COPY,
  voting: { heading: "Nothing yet", body: "Players are still voting. Anything you earn appears here." },
} as const

const NOTE = "max-w-[38ch] text-sm leading-5 text-muted-foreground"

/** air between the lowest piece and the Pocket's book at its highest, px */
const FLOOR_GAP = 12

export default function ChestPage() {
  const { view, send, reconnecting, closing } = useChestScreen()
  // which opened piece the picker is inspecting, and the rect its hero flies out of
  const [pickerFor, setPickerFor] = useState<{ index: number; rect: DOMRect } | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const ring = useRef<PieceSpot[]>([])
  // the pieces the Pocket has taken out of the scene, and how far its cover has closed
  const [taken, setTaken] = useState<number[]>([])
  // pieces opened in the Pocket's book and given back: open in the scene too
  const [openNow, setOpenNow] = useState<number[]>([])
  const cover = useRef(0)
  const [focused, setFocused] = useState(false)
  // the bubble has popped: the stars drift back in where it was
  const [popped, setPopped] = useState(false)
  // the screen's size, kept in step with it: where the Pocket's book comes to moves when it does (a turned phone, a host's bars)
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const measure = () => setScreen({ width: innerWidth, height: innerHeight })
    measure()
    addEventListener("resize", measure)
    return () => removeEventListener("resize", measure)
  }, [])

  if (view.kind === "restart") {
    const copy = chestRestartCardCopy(reconnecting)
    return (
      <MessageScreen
        rootAttrs={{
          "data-testid": "chest-restart",
          "data-restart-advice": reconnecting ? "reconnecting" : "restart",
        }}
        eyebrow={copy.eyebrow}
        heading={copy.heading}
        body={copy.body}
      />
    )
  }

  const { vessel, notice, action, game } = view
  const nothing = notice !== null && typeof notice === "object" ? notice.nothing : null
  const wait = notice === "slow" || notice === "voting" ? notice : null
  const pieces = vessel?.pieces ?? []
  const picked = pickerFor !== null ? pieces[pickerFor.index] : undefined
  const pocket = vessel !== null && (action === "continue" || closing !== null)
  // with the Pocket up, the pieces float above where its book comes to, held open (lib/pocket/book bookTop)
  const floor = pocket && screen ? bookTop(screen) - FLOOR_GAP : null

  return (
    <div ref={pageRef} className="relative isolate flex min-h-dvh flex-1 flex-col pt-6" data-testid={wait ? `chest-${wait}` : undefined}>
      <div aria-hidden className="chest-backdrop pointer-events-none fixed inset-0 -z-10" />
      <Starfield bubble={!popped} />
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pb-4 text-center">
        {nothing ? (
          <>
            <div className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">
              {nothing !== "no-identity" ? (game !== null ? `Game #${game}` : "All games") : "Game complete"}
            </div>
            <h1 className="text-[28px] leading-9 font-bold">The chest</h1>
            <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">{NOTHING[nothing]}</p>
          </>
        ) : null}

        {vessel ? (
          // the vessel IS the screen: the view passes params, the engine does the rest
          <>
            <ChestScene
              seed={vessel.seed}
              items={pieces.map((item) => ({
                image: item.image,
                rare: item.rarity === "rare",
                tier: item.tier,
                name: item.name,
              }))}
              open={vessel.open}
              canOpen={vessel.canOpen}
              onLanded={() => send({ type: "landed" })}
              onCollected={(count) => send({ type: "collected", count })}
              onOpened={() => {
                setPopped(true)
                send({ type: "vessel-opened" })
              }}
              onInspect={(index, rect) => setPickerFor({ index, rect })}
              onPieces={(spots) => {
                ring.current = spots
              }}
              taken={taken}
              openNow={openNow}
              cover={cover}
              floor={floor}
              onFocus={setFocused}
              inspected={pickerFor?.index ?? null}
              className="-mx-6 min-h-[320px] w-[calc(100%+3rem)] flex-1"
            />
            {/* the hologram — an overlay on this screen, not a route: it opens
                over the opened piece you tapped and flies back into it on close */}
            <NftPicker
              origin={pickerFor?.rect ?? null}
              item={
                picked
                  ? {
                      name: picked.name,
                      image: picked.image,
                      rare: picked.rarity === "rare",
                      choices: (canChangePick(picked) ? picked.choices : picked.choices.slice(0, 1)).map((choice) => ({
                        collectionId: choice.collectionId,
                        label: choice.collection,
                        name: choice.name,
                        src: choice.image,
                      })),
                    }
                  : null
              }
              onClose={() => setPickerFor(null)}
              onPick={(offer) => {
                if (pickerFor !== null) send({ type: "pick", index: pickerFor.index, collectionId: offer.collectionId })
                setPickerFor(null)
              }}
            />
          </>
        ) : null}

        {wait ? (
          <div className="flex flex-col items-center gap-1">
            <h2 className="text-lg leading-6 font-bold">{WAIT_COPY[wait].heading}</h2>
            <p className={NOTE}>{WAIT_COPY[wait].body}</p>
          </div>
        ) : notice === "partial" ? (
          <p className={NOTE}>Some of your collectables could not be shown right now. They are still yours, so check again later.</p>
        ) : null}
      </main>

      <footer
        className={
          "flex justify-center px-4 pt-3 pb-6 transition-opacity duration-500 " +
          // laid out from the start so the reveal never reflows under it
          (action && !pocket ? "opacity-100" : "pointer-events-none opacity-0")
        }
      >
        {pocket ? (
          <div className="h-14" />
        ) : (
          <Button size="lg" className="w-full max-w-sm" onClick={() => send({ type: "cta" })}>
            Continue
          </Button>
        )}
      </footer>

      {pocket ? (
        <PocketClaim
          surface={pageRef}
          pieces={pieces.map((item) => ({ image: item.image, rare: item.rarity === "rare", tier: item.tier }))}
          ring={ring}
          onTake={(index) => setTaken((was) => (was.includes(index) ? was : [...was, index]))}
          onReturn={(index, opened) => {
            setTaken((was) => was.filter((i) => i !== index))
            if (opened) setOpenNow((was) => (was.includes(index) ? was : [...was, index]))
          }}
          onCover={(closed) => {
            cover.current = closed
          }}
          hidden={(focused || pickerFor !== null) && closing === null}
          claimed={closing !== null}
          refusals={closing?.refusals ?? 0}
          onClaim={() => send({ type: "cta" })}
          onDone={() => send({ type: "album-done" })}
        />
      ) : null}
    </div>
  )
}
