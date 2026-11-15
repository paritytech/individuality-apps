# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Registering from the chat, as the worker does it today.

Run it from the repository root:

    python3 docs/assets/journey-register-chat.py > docs/assets/journey-register-chat.svg

Every step is current behaviour. The worker boots the room, keeps one game
card up to date from its 15 s poll, and signs the player up from the card's
Register button with the engine the app signs up with: the same product
account (`dim2`'s account 1), the same seat route and the same sign-up call,
which carries one host-signed ticket per prize draw, since no call enters a
draw afterwards. The game reminder and the notices the poll books are drawn
in journey-notifications.svg. The code: apps/jollity-worker/src/index.ts
(main, tick, the card handler, the reminder gate), src/signup.ts (the
sign-up), src/card/ (the faces and their copy) and src/host.ts (every host
call), over packages/individuality-sign-up and the product SDK.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from journey import Journey  # noqa: E402
from sequence import FILL_OURS  # noqa: E402

d = Journey(
    [
        ("user", "User"),
        ("worker", "Worker", "worker.dim2.paseo", FILL_OURS),
        ("host", "Host API"),
        ("storage", "Host Storage"),
    ]
)
d.spread(1180)

d.package("host.chat.", "getChatManager()")
d.package("host.renderer.", "getChatManager().onCustomMessageRenderingRequest")
d.package("host.permissions.", "requestDevicePermission")
d.package("host.navigate", "navigateTo")
d.package("host.entropy", "deriveEntropy")
d.package("host.accounts.signer", "getProductAccountSigner")
d.package("readJSON(host", "getHostLocalStorage()")
d.package("writeJSON(host", "getHostLocalStorage()")
d.package("readCurrentGame", "@parity/product-sdk-individuality")
d.package("readPrizeStatus", "@parity/product-sdk-individuality")
d.package("readPersonhoodState", "@parity/product-sdk-individuality")
d.package("holdsLiteKey", "@parity/product-sdk-individuality")
d.package("readGameSeat", "@parity/product-sdk-individuality")
d.package("registerForGame", "@parity/product-sdk-individuality, via @individuality/sign-up")
d.package("createRingVRFProof", "getAccountsProvider()")
d.package("signVrf", "getAccountsProvider()")
d.package("createSubmitAndWatch", "the SDK's stock signer: truApi.signing.createTransaction")

# boot
d.section("BOOT")
d.call("worker", "storage", 'writeJSON(host, "jollity.wg.workerHeartbeat", { at, release })', note="now, then every 30 s")
d.call("worker", "host", 'host.chat.registerBot("weekly-game-bot", "Weekly Game", BOT_ICON)')
d.ret("host", "worker", '"New" | "Exists" (iOS and Android refuse it; only counted)')
d.call("worker", "host", 'host.chat.registerRoom("jollity", "Polkadot", ROOM_ICON)')
d.ret("host", "worker", '"New" | "Exists"')
with d.frag("opt", "[ registerRoom answered ]"):
    d.call("worker", "storage", 'readJSON(host, "jollity.wg.docked")')
    d.ret("storage", "worker", "gamePlayTime | null")
    d.call("worker", "host", 'host.chat.setRoomFooter("jollity", { card: "jollity.gamecard" } | "Empty")')
    d.call("worker", "storage", 'readJSON(host, "jollity.wg.intro.v3")')
    d.ret("storage", "worker", "rules posted so far | null")
    with d.frag("loop", "[ each of the eight rules not posted yet, 2 s apart ]"):
        d.call("worker", "host", 'host.chat.postMessage("jollity", "jollity.intro", encPayload({ image }), rule.text)')
        d.call("worker", "storage", 'writeJSON(host, "jollity.wg.intro.v3", index + 1)')
    d.call("worker", "host", 'host.permissions.requestDevice("Notifications")')
d.call("worker", "host", "host.renderer.onRender((req, send, onAction) => ...)")

# the poll
d.section("THE POLL")
with d.frag("loop", "[ every 15 s ]"):
    d.call("worker", "host", 'readCurrentGame(chain, { players: [{ tag: "Account", accountAddress }] })')
    d.ret("host", "worker", "Running { game, registration, upcoming } | BetweenGames")
    with d.frag("opt", "[ registration open, with draws scheduled ]"):
        d.call("worker", "host", "readPrizeStatus(chain, { game: { index, airdropsScheduled } })")
        d.ret("host", "worker", "drawOpen: every draw past Upcoming")
    with d.frag("opt", "[ membership unknown, or every fourth poll ]"):
        d.call("worker", "host", "readPersonhoodState(chain, { account })")
        d.ret("host", "worker", "standing")
    d.call("worker", "storage", 'readJSON(host, "jollity.wg.announced")')
    d.ret("storage", "worker", "the last play times carded: number[]")
    d.call("worker", "host", 'host.chat.setRoomFooter("jollity", { card: { messageType: "jollity.gamecard", payload } })')
    d.ret("host", "worker", '"set" | "unsupported" | "unknown-room" | "failed"')
    with d.frag("opt", "[ the footer cannot hold the card, and this game has none yet ]"):
        d.call("worker", "storage", 'writeJSON(host, "jollity.wg.announced", [..., gamePlayTime])')
        d.call("worker", "host", 'host.chat.postMessage("jollity", "jollity.gamecard", encPayload({ gamePlayTime }), GAME_CARD_ALT)')
    d.selfcall("worker", "the game reminder, then the notices: journey-notifications.svg")
    d.call("worker", "storage", 'writeJSON(host, "jollity.wg.games", [{ index, gamePlayTime, endsAt, registered, ... }])')

# the card
d.section("THE CARD")
d.ret("host", "worker", 'req: { messageId, messageType: "jollity.gamecard", payload }')
d.selfcall("worker", "decPayload(req.payload): { gamePlayTime }")
with d.frag("loop", "[ every 3 s ]"):
    d.call("worker", "storage", 'readJSON(host, "jollity.wg.games"), "jollity.wg.recap:<t>", "jollity.seen:<index>"')
    d.call("worker", "storage", 'readJSON(host, "jollity.camera.v1:dim2.paseo"); Humanity\'s "jollity.registration"')
with d.frag("loop", "[ every 1 s ]"):
    d.call("worker", "host", "send(gameCardNode(gameSlot(...), ui, now, { hostPill, docked, slide }))")
with d.frag("alt", "[ registration not open yet, or its draws not open yet ]") as f:
    d.sees("host", "user", ["Next game", "Opening soon"])
    f.divider("[ open, not registered ]")
    d.sees("host", "user", ["Next game", "Register | Slide to register"])
    f.divider("[ registered, more than 5 min to the start ]")
    d.sees("host", "user", ["Registered · Next game"])
    f.divider("[ registered, the last 5 min; the host's pill counts when it is up ]")
    d.sees("host", "user", ["Game starting soon | 4:10 left to join | Game starts in 42"])
    f.divider("[ registered, from a minute before the start ]")
    d.sees("host", "user", ["Game in Progress", "Start playing"])
    f.divider("[ not registered, registration closed ]")
    d.sees("host", "user", ["Next game", "Registration closed"])

# Register
d.section("REGISTER")
d.call("user", "host", "Taps Register", mono=False)
d.ret("host", "worker", '{ actionId: "jollity.register" }')
d.call("worker", "host", 'host.permissions.requestDevice("Camera")')
d.ret("host", "worker", "boolean")
d.call("worker", "storage", 'writeJSON(host, "jollity.camera.v1:dim2.paseo", "on" | "off")')
with d.frag("opt", "[ no sign-up under way, none sent for this game ]"):
    d.call("worker", "host", 'send(gameCardNode(..., { busy: "reminders" }))', note="a progress ring per step")
    d.call("worker", "storage",
           'writeJSON(host, "jollity.registration", { gameIndex, phase: "registering", surface: "chat", at, attempt })')
    d.selfcall("worker", "reminder gate: keepReminder(retryNow), as journey-notifications.svg draws it")
    with d.frag("opt", "[ the host holds no reminder for the game: the sign-up stops ]"):
        d.sees("host", "user", ["Enable notifications to register. | Update to new version to register."])
    with d.frag("opt", "[ the name link is not in place: the sign-up stops ]"):
        d.sees("host", "user", ["Your username isn't registered. Open your membership card to set it up."])
    d.call("worker", "host", 'host.accounts.signer("dim2.paseo", 1)')
    d.ret("host", "worker", "signer")
    d.call("worker", "host", 'host.entropy("jollity:comm-id")')
    d.ret("host", "worker", "Uint8Array | null")
    with d.frag("opt", "[ no signer, no entropy or no chain ]"):
        d.call("worker", "host", "host.navigate(SPA_URL)", note="the app takes the sign-up over")
    d.call("worker", "storage", 'readJSON(host, "individuality.communication-key")')
    d.ret("storage", "worker", "the key kept for this game | null")
    with d.frag("opt", "[ none for this game ]"):
        d.selfcall("worker", "communicationKeyFrom(entropy, gameIndex): a P-256 key")
        d.call("worker", "storage", 'writeJSON(host, "individuality.communication-key", { version, gameIndex, publicKey, secret, at })')
    d.call("worker", "host", "holdsLiteKey(chain, capabilities): listRingVrfKeys of the person")
    d.ret("host", "worker", "boolean")
    d.call("worker", "host", "readGameSeat(chain, { account }): Timestamp.Now, sign-up requirement, deposit, balance, fee")
    d.ret("host", "worker", '{ path: "free" | "returning" | "deposit" | "unfunded", ready, registered }')
    with d.frag("alt", "[ seat.registered ]") as f:
        d.selfcall("worker", 'the app signed this account up already: "sent"')
        f.divider("[ free, not bound yet, a lite person ]")
        d.call("worker", "host", "createRingVRFProof(lite key, score context)")
        d.ret("host", "worker", "{ proof, alias }")
        d.call("worker", "host", "PeopleLite.set_alias_account, submitted raw")
        d.ret("host", "worker", "in a best block")
        f.divider('[ "unfunded" ]')
        d.call("worker", "host", "host.navigate(SPA_URL)", note="the app says how much is missing")
    d.call("worker", "host", "registerForGame: Airdrop.Events of every draw of the game")
    d.ret("host", "worker", "the draws and their status")
    with d.frag("alt", '[ every draw "Registering" ]') as g:
        with d.frag("loop", "[ one ticket per draw ]"):
            d.call("worker", "host", "signVrf(account, pop:airdrop transcript) | createRingVRFProof (a recognized person)")
            d.ret("host", "worker", "{ preOutput, proof }")
        g.divider("[ a draw not open yet: wait in 2 s steps; closed, refused or waited out ]")
        d.selfcall("worker", "airdrops = []: the sign-up still goes, without the ticket")
    with d.frag("alt", '[ path == "free" ]') as f:
        d.selfcall("worker", "Game.sign_up_with_account_lite_invite(identifier_key, airdrops)")
        f.divider('[ "returning" (ScoreAsParticipant) or "deposit" ]')
        d.selfcall("worker", "Game.sign_up_with_account(identifier_key, airdrops)")
    d.call("worker", "host", "tx.createSubmitAndWatch(signer)")
    d.ret("host", "worker", '{ type: "broadcasted" }')
    d.call("worker", "storage", 'writeJSON(host, "jollity.registration", { ..., phase: "sent" })')
    d.sees("host", "user", ["Registered · Next game"])
    d.ret("host", "worker", '{ type: "finalized", ok }', note="watched for REGISTRATION_WATCH_MS (120 s)")
    with d.frag("alt", "[ ok, AlreadyRegistered, or the chain holds the player after all ]") as f:
        d.call("worker", "storage", 'writeJSON(host, "jollity.registration", { ..., phase: "registered" })')
        f.divider("[ NoRegistration, NoGame or GameOngoing ]")
        d.sees("host", "user", ["You just missed this one. Stay tuned for the next game."])
        f.divider("[ else ]")
        d.sees("host", "user", ["Couldn't sign you up."])

d.call("user", "host", "Taps Start playing", mono=False)
d.ret("host", "worker", '{ actionId: "jollity.open" }')
d.call("worker", "host", "host.navigate(SPA_URL)", note="SPA_URL = the deploy's bare DotNS name")
d.ret("host", "worker", "boolean")
with d.frag("opt", "[ the host did not open it ]"):
    d.sees("host", "user", ["The Polkadot app couldn't open Jollity. Update it to the latest version."])

print(d.svg())
