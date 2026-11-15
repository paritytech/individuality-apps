# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""The payoff, from the report through the prize draw and the chest to the hand-off, as the app does it today.

Run it from the repository root:

    python3 docs/assets/journey-player-process.py > docs/assets/journey-player-process.svg

Every step is current behaviour. When the report lands the game session
replaces the page with the draw (lib/game-session.ts `finishReport`), or with
the chest when the waiting room's read proved that no draw was scheduled
(lib/draw/draw-schedule.ts). Each end screen runs on a reducer: the draw on
lib/draw/draw-screen.ts, the chest on lib/chest/chest-screen.ts, and the order
of the two on lib/payoff-machine.ts. The draw is read in
packages/jollity-game-chain/src/chain/airdrop.ts through the SDK's
`readAirdropDraw`, at one best block. A won prize is claimed by itself, with
nothing on screen (lib/draw/auto-claim.ts over @individuality/prize). The chest
is read in packages/jollity-collectables/src/chest.ts through
`@parity/product-sdk-nfts`, fed by lib/chest/chest-feed.ts, and the picks are
kept under `jollity.chest` (lib/chest-picks.ts). App paths are under
apps/jollity-app/.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from journey import Journey  # noqa: E402
from sequence import FILL_OURS  # noqa: E402

d = Journey(
    [
        ("user", "User"),
        ("app", "App", "app.dim2.paseo", FILL_OURS),
        ("host", "Host API"),
    ]
)
d.spread(1180)

for read in ("getClaims", "getClaimableCollections", "getCollectionItems", "previewClaim", "getVerifiedArtwork"):
    d.package(read, "@parity/product-sdk-nfts")
d.package("readAirdropDraw", "@parity/product-sdk-individuality")
d.package("gameAirdropEventId", "@parity/product-sdk-individuality")
d.package("claimPrizeTx", "@parity/product-sdk-individuality")
for read in ("api.query.", "api.constants."):
    d.package(read, "polkadot-api")
d.package("finishReport", "lib/game-session.ts")
d.package("loadDraw", "lib/draw/draw-load.ts")
d.package("claimEligibility", "@individuality/prize")
d.package("checkWheel", "lib/draw/wheel/rule.ts")
d.package("startStage", "lib/draw/wheel/stage-runner.ts")
d.package("startAutoClaim", "lib/draw/auto-claim.ts")
d.package("claimWhenPayable", "@individuality/prize")
d.package("postGameHref", "lib/draw/draw-screen-deps.ts")
d.package("items.get", "packages/jollity-collectables/src/chest.ts")
d.package("manifestPicture", "packages/jollity-collectables/src/manifest.ts")
d.package("URL.createObjectURL", "lib/collectable-art.ts")
d.package("jollity.chest", "getHostLocalStorage(), lib/chest-picks.ts")
d.package("stash.picks", "lib/host/stash-picks.ts")
d.package("withPicks", "@jollity/collectables")
d.package("watchChest", "lib/game-source.ts, lib/chest/chest-feed.ts")
d.package("onShelfTap", "components/chest/chest-scene.tsx")
d.package("navigateTo", "lib/membership/humanity-target.ts, lib/host/navigate.ts")

d.selfcall("app", "finishReport(gameIndex): the report landed")
with d.frag("alt", "[ the waiting room's read proved no draw was scheduled ]") as f:
    d.selfcall("app", "router.replace(`/chest?game=${gameIndex}`)")
    f.divider("[ else ]")
    d.selfcall("app", "router.replace(`/prize-draw?game=${gameIndex}`)")

d.section("THE PRIZE DRAW")
d.selfcall("app", "loadDraw(source, gameIndex): a read every 3 s, at most 60")
with d.frag("loop", '[ draw.phase === "waiting" ]'):
    d.sees("app", "user", ["Prize draw", "Drawing the winners…"])
    d.call("app", "host", "api.constants.Game.airdrop_event_id_base()")
    d.ret("host", "app", "base")
    with d.frag("loop", "[ airdropIndex < 4 ]"):
        d.selfcall("app", "gameAirdropEventId({ base, gameIndex, airdropIndex })")
        d.call("app", "host", 'readAirdropDraw(chain, { eventId, at: "best" })')
        d.ret("host", "app", "{ event: { prize, effectiveWinners, ... } | null, entropy, at }")
        d.call("app", "host", "api.query.Airdrop.Registrations.getEntries(eventId, { at }), Airdrop.Winners.getEntries(eventId, { at })")
        d.ret("host", "app", "the tickets and their holders, the winners")
        with d.frag("opt", "[ event !== null ]"):
            d.call("app", "host", "api.query.Assets.Metadata.getValue(event.prize.assetId, { at })")
            d.ret("host", "app", "{ symbol, decimals }")
    d.call("app", "host", "api.query.Score.Participants.getValue(player)")
    d.ret("host", "app", "{ recognition, reached_personhood, last_attended_game }")
    d.selfcall("app", "claimEligibility(participant, gameIndex)")
    d.selfcall("app", 'draws.find((d) => d.phase !== "over") ?? draws[0]')
d.selfcall("app", "preloadChest(): the chest's claims are read while the wheel plays")

with d.frag("alt", "[ checkWheel({ tickets, target, winners, mine, winningTickets, won }).ok ]") as f:
    with d.frag("opt", "[ !draw.userTicket ]"):
        d.sees("app", "user", ["Someone's about to win", "Draws are for members. Keep playing to join."])
    d.selfcall("app", "startStage(host, draw): mountWheel(host, draw, { held, onEnded, onDone })")
    d.selfcall("app", "the wheel turns and stops on the winning tickets: onEnded, then onDone")
    f.divider("[ the wheel cannot tell this draw: its words ]")
    with d.frag("alt", "[ !draw.userTicket ]") as words:
        d.sees("app", "user", ["You weren't in this draw", "Your sign-up didn't enter this game's prize draw."])
        words.divider("[ draw.won ]")
        d.sees("app", "user", ["You won", "$10 CASH is yours."])
        words.divider("[ else ]")
        d.sees("app", "user", ["Not this time", "3 tickets won $10 CASH."])
    f.divider("[ the draw reads as none ]")
    d.selfcall("app", "no ceremony: on to the chest")

with d.frag("opt", "[ draw.won ]"):
    d.selfcall("app", "startAutoClaim(source, draw): no button, nothing on screen")
    d.call("app", "host", "api.query.Game.Players.watchValue(player), Game.Game: until the attendance is applied")
    d.ret("host", "app", "applied (early, or at the settle)")
    d.selfcall("app", "claimWhenPayable: read the draw again, claim only what the chain would pay")
    with d.frag("opt", "[ the chain would pay ]"):
        d.call("app", "host", "claimPrizeTx(chain, { gameIndex, airdropIndex, beneficiary })",
               note=".createSubmitAndWatch(withScoreParticipant(signer)), re-read before each send")
        d.ret("host", "app", "{ ok }")
    d.selfcall("app", "every outcome goes to the debug log; a claim left undone is the chat's")

d.call("user", "app", "Taps Continue (or 60 s pass)", mono=False)
d.selfcall("app", 'router.replace(postGameHref("/chest"))')

d.section("THE CHEST")
with d.frag("par", "[ the chest feed: the first read ]") as f:
    d.call("app", "host", 'getClaims(chain, { claimant: { tag: "Account", address }, individualityAt: "best" })')
    d.ret("host", "app", "{ claims: [{ hash, gameIndex, state, proof }, ...], at: { assetHub } }")
    d.call("app", "host", "getClaimableCollections(chain, { at, fromId? }), filtered to getApprovedCollections(network)")
    d.ret("host", "app", "{ collections: [{ id, name, ... }], nextId }")
    d.call("app", "host", "getCollectionItems(chain, id, { at, attributes: true })")
    d.ret("host", "app", '{ tag: "Found", collection: { items }, nextId }')
    with d.frag("loop", "[ per claim ]"):
        d.call("app", "host", "previewClaim(chain, { credit: claim.hash, collections, at })")
        d.ret("host", "app", "{ previews: [{ collection, outcome: { item, rarity } }, ...] }")
        with d.frag("loop", "[ per preview ]"):
            d.selfcall("app", "items.get(`${collection}:${item}`); name = titleCase(archetype)")
            d.call("app", "host", "getVerifiedArtwork({ hex, text: manifest }, { source })")
            d.ret("host", "app", "{ tag: Verified, bytes }")
            d.selfcall("app", "manifestPicture(manifest): the thumbnail, else the base image")
            d.call("app", "host", "getVerifiedArtwork({ text: picture.cid }, { source })")
            d.ret("host", "app", "{ tag: Verified, bytes }")
            d.selfcall("app", 'URL.createObjectURL(new Blob([image], { type: mime }))')
        d.selfcall("app", "shown = the default collection the claim's hash picks")
    f.divider("[ the picks ]")
    d.call("app", "host", 'readJSON("jollity.chest")')
    d.ret("host", "app", "{ [hash]: { collectionId } }")
    d.call("app", "host", 'truApi.localStorage.read({ product: "stash.paseo", key: "stash.picks" })')
    d.ret("host", "app", "Stash's picks")
d.selfcall("app", "withPicks(claims.slice(0, 10), picks, stash): Stash's picks win")
with d.frag("opt", "[ the game is still settling ]"):
    d.call("app", "host", "watchChest: the claims that land, then one read after the settle")
    d.ret("host", "app", "the new claims")

d.selfcall("app", "the vessel collects the claims as they fly in, then opens")

with d.frag("loop", "[ per collectable tapped ]"):
    d.call("user", "app", "Taps a collectable", mono=False)
    d.selfcall("app", "onShelfTap(index, rect)")
    d.call("user", "app", "Turns the coin to another collection", mono=False)
    with d.frag("opt", "[ picked, and Stash has not picked it ]"):
        d.selfcall("app", 'send({ type: "pick", index, collectionId }): save-pick')
        d.call("app", "host", 'writeJSON("jollity.chest", chestValue(known))')

d.call("user", "app", "Taps Continue", mono=False)
d.selfcall("app", 'send({ type: "cta" }): the Pocket album opens')
d.sees("app", "user", ["Claim all"])
d.call("user", "app", "Swipes down, or taps Claim all", mono=False)
d.sees("app", "user", ["Added to your Pocket", "Continue"])
d.call("user", "app", "Taps Continue", mono=False)
d.call("app", "host", 'navigateTo("polkadotapp://pocket/open?product=peopl.paseo&card=humanity")',
       note="on a desktop host: https://peopl.paseo")

print(d.svg())
