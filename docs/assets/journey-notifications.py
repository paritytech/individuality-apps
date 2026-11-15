# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""The game reminder and the notices the chat books, as the worker does it today.

Run it from the repository root:

    python3 docs/assets/journey-notifications.py > docs/assets/journey-notifications.svg

Every step is current behaviour. The worker asks the host for its one game
reminder (the host's game service, through `@individuality/sign-up`), and books
its own notices through the notification manager. Both run on the worker's
15 s poll, one after the other in one queued task. The code:
apps/jollity-worker/src/chain.ts (readGame, the clock offset) and
apps/jollity-worker/src/index.ts (keepReminder, cancelHostReminder,
remindersFor, bookReminders). The app asks for the same reminder when it
signs a player up itself (apps/jollity-app/lib/host/game-reminder.ts), under
the same record, `jollity.wg.host-reminder`, so every ask for one game sends
the same start.
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

d.package("host.permissions.", "requestDevicePermission")
d.package("host.notifications.", "getNotificationManager()")
d.package("host.game.", "@individuality/sign-up, truApi.game")
d.package("readJSON(host", "getHostLocalStorage()")
d.package("writeJSON(host", "getHostLocalStorage()")
d.package("readCurrentGame", "@parity/product-sdk-individuality")
d.package("Timestamp.Now", "polkadot-api")
d.package("remindersFor", "apps/jollity-worker/src/index.ts")

d.call("worker", "host", 'host.permissions.requestDevice("Notifications")',
       note="once at boot, after registerRoom and the rules; a 30 s wait")
d.ret("host", "worker", "boolean | undefined")

with d.frag("loop", "[ every poll, POLL_MS = 15 s ]"):
    d.call("worker", "host", 'readCurrentGame(chain, { players: [{ tag: "Account", accountAddress }] })')
    d.ret("host", "worker", "Running { game, registration, upcoming } | BetweenGames")
    d.call("worker", "host", 'api.query.Timestamp.Now.getValue({ at: "best" })')
    d.ret("host", "worker", "Now")
    d.call("worker", "storage", 'writeJSON(host, "jollity.wg.clockOffset", Now - Date.now())')
    d.selfcall("worker", "no Now: the stored offset; no offset at all: no read, nothing booked this poll")

    d.call("worker", "storage", 'readJSON(host, "jollity.wg.host-reminder")')
    d.ret("storage", "worker", "stored: { gamePlayTime, startsAt, outcome, at, retryAt?, outSeen? } | null")
    with d.frag("alt", "[ running.registered === null ]") as f:
        d.selfcall("worker", "the sign-up is unread: ask nothing, cancel nothing")
        f.divider("[ registeredStart(read): registered for a game still to play ]")
        with d.frag("opt", '[ stored is not "held" for this game, and no retry wait holds it back ]'):
            d.call("worker", "storage",
                   'writeJSON(host, "jollity.wg.host-reminder", { gamePlayTime, startsAt, outcome: "asking", at })')
            d.call("worker", "host", "host.game.remindNextGame(stored.startsAt ?? joinAtMs(gamePlayTime))",
                   note="joinAtMs = (gamePlayTime - 60) * 1000: the join, a minute before kickoff")
            d.selfcall("host", "holds it: alarm, pill, calendar")
            d.ret("host", "worker", '"held" | "starts-in-past" | "unsupported" | "denied" | "failed"')
            with d.frag("opt", "[ no answer within CALL_DEADLINE_MS (45 s) ]"):
                d.selfcall("worker", 'outcome = "failed"; a "held" that comes later runs recordLateHold')
            d.call("worker", "storage", 'writeJSON(host, "jollity.wg.host-reminder", { gamePlayTime, startsAt, outcome, at })',
                   note="only while its own claim is still the latest record")
            with d.frag("opt", '[ outcome !== "held" && stored.outcome === "held" ]'):
                d.call("worker", "host", "host.game.cancelNextGame()")
        f.divider("[ else: out on two reads in a row, no game, or the game called off ]")
        with d.frag("opt", '[ stored may be held ("held" | "asking" | "failed"), or the game is called off ]'):
            d.call("worker", "host", "host.game.cancelNextGame()")
            d.ret("host", "worker", '"dropped" | "unsupported" | "failed" | ...')
            d.call("worker", "storage",
                   'writeJSON(host, "jollity.wg.host-reminder", { gamePlayTime, outcome: "dropped" | "held", at, retryAt? })')

    d.call("worker", "storage", 'readJSON(host, "jollity.wg.games")')
    d.ret("storage", "worker", "[{ index, gamePlayTime, endsAt, ... }] (the previous game's end)")
    d.selfcall("worker", "due = remindersFor(read, hostReminds, previousGameEndsAt, now)")
    with d.frag("alt", "[ registered && hostReminds ]") as f:
        d.selfcall("worker", "reminders = []: the host's alarm stands in for them")
        f.divider("[ registered ]")
        d.selfcall("worker", "reminders = [start-5m, start-1m, start-20s]")
        f.divider('[ running.phase === "registration" ]')
        d.selfcall("worker", "reminders = [opens, close-1h, close-10m]")
    d.selfcall("worker", "...and [opens, close-1h, close-10m] for every upcoming game")
    d.call("worker", "storage", 'readJSON(host, "jollity.wg.notifs")')
    d.ret("storage", "worker", "booked: { gamePlayTime, registered, hostReminds, ids, moments, stale, complete, retryAt? } | null")
    with d.frag("opt", "[ booked does not match due, or it is incomplete and its retry is due ]"):
        d.call("worker", "storage", 'writeJSON(host, "jollity.wg.notifs", { ...claim, complete: false })')
        with d.frag("loop", "[ for (const old of toCancel) ]"):
            d.call("worker", "host", "host.notifications.cancel(old.id)")
        with d.frag("loop", "[ for (const reminder of pending) ]"):
            d.call("worker", "storage", 'writeJSON(host, "jollity.wg.notifs", { ..., moments: { [moment]: { pushing: true } } })')
            d.call("worker", "host",
                   'host.notifications.push({ text, scheduledAt: reminder.at, deeplink: spaPage(REMINDER_PATH) + "&moment=..." })')
            d.ret("host", "worker", "id")
            with d.frag("opt", "[ push threw, not a CallDeadlineError and not a permission refusal ]"):
                d.call("worker", "host", "host.notifications.push({ text, scheduledAt: reminder.at })")
                d.ret("host", "worker", "id")
        d.call("worker", "storage",
               'writeJSON(host, "jollity.wg.notifs", { gamePlayTime, registered, hostReminds, ids, moments, stale, complete })')

d.sees("host", "user", ["Game starts in an hour. Register now, prizes and collectibles await!"])
d.sees("host", "user", ["Join the November game. The game starts in 5 min! Join for free to win amazing prizes!"])

print(d.svg())
