---
name: dim2-sentry
description: Query DIM2 (jollity-next) telemetry in Sentry and write the per-game report. Use when someone asks what happened in a game, wants to see Sentry data for a player, game, device or release, needs to set up a Sentry API token, or wants to update the DIM2 Game Reports page.
---

# DIM2 telemetry in Sentry

Every phone that plays DIM2 sends journeys, failures and metrics to Sentry.
This skill shows how to read them and how to turn a game into a report.
Everything here is read-only against Sentry.

**Claude: before the first query in a session, run sentry.py whoami.** If it
fails, stop and walk the person through One-time setup below: whether they have
a Sentry account in the paritytech org, then the token, then whoami again. Do
not run queries until it says "Token works".

## One-time setup

You need a personal Sentry token. Queries use it, nothing else does.

1. Make sure you have a Sentry account in the **paritytech** org. If not, ask a Parity Sentry admin to add you.
2. Open https://de.sentry.io/settings/account/api/auth-tokens/ (**de.sentry.io**: our org is in the EU region) and create a token.
3. Tick only these scopes: **org:read**, **project:read**, **event:read**. Queries need nothing more. Add nothing that writes.
4. Store it.
   - macOS: run **security add-generic-password -a "$USER" -s sentry-api-token -w**. It asks for the token, so it stays out of your shell history.
   - Other systems: **export SENTRY_AUTH_TOKEN=...** in your shell profile.
5. Check it: **python3 .claude/skills/dim2-sentry/scripts/sentry.py whoami**. It should say "Token works".

**Claude: never print the token, never paste it into chat, never put it in a file or a command line.** The scripts read it themselves.

## Write a game report

Anyone can say "write the report for game N". One command generates and lints every factual sentence; Claude only replaces the marked judgment slot.

**Use the report/store flow** (Telemetry store below). It waits until the full
report window has closed, creates a report-ready store without the additional
ingest cooldown, runs the report immediately, then resumes the
deferred raw transaction details into the same store. A report failure still
finishes raw retention, and rerunning the command resumes an existing
report-ready store rather than starting the collection again.

## Telemetry store: dump a game

Use the pinned store environment for the normal report flow:

    .claude/skills/dim2-sentry/.venv/bin/python \
      .claude/skills/dim2-sentry/scripts/store_dump.py <game> --report

The flow reads the chain first and refuses to use a fallback window when the
game has not settled. Once settlement exists, it waits through the 10-minute
payoff window plus a 30-second ingestion margin. It then bypasses only the
additional 15-minute ingest cooldown, enforces the production-paseo telemetry
guard, then writes the five report datasets, bulk
full error payloads, game-log attachments, chain, frozen name inputs and
manifest atomically under **docs-internal/telemetry-store**. A passing manifest
with **report_ready: true** starts the stored report before raw completion.
Transaction payloads are retention evidence and remain explicitly pending
rather than blocking the report. After report generation the flow resumes those
payloads and records **raw_complete: true** plus the completion time.
It never writes the shared **telemetry-store/usernames.json**. Use **--refresh** only to replace an
existing folder; a shrink is refused unless **--allow-shrink** is explicit.
Use **--with-test-project** only for games whose bots carried the test DSN,
and **--force-early** only when deliberately accepting incomplete ingestion.
The printed checks must all say **True** before treating the dump as report-ready.
An early or fallback-window store is never reused by **--report** and cannot be
packed; rerun **--report --refresh** after the real window closes.

For an interrupted/manual flow, either rerun **--report** or resume only the raw
details with the command below. Raw completion skips transaction payloads
already present and atomically updates the payload table and manifest. Do not
publish the archive until the manifest says **raw_complete: true**.

    .claude/skills/dim2-sentry/.venv/bin/python \
      .claude/skills/dim2-sentry/scripts/store_dump.py <game> --complete-raw

**Then publish it, every game (Ionut, 22 Oct 2026).** The report session owns this step:
the encrypted shared copy in the analytics share only grows when it runs.

    analytics/publish.sh                # after the first dump of a game
    analytics/publish.sh --refresh <N>  # after store_dump.py <N> --refresh

It packs every game in the master copy (the local store on Ionut's Mac) that has no
archive yet, commits the archives in one commit and pushes it straight to main from a
throwaway worktree; that commit triggers no workflow. The password comes from the
Keychain entry **dim2-telemetry-store**. (The archive repo's analytics/ scripts were
not ported; until they land here, run that step from the archive checkout.) Say in
the report's hand-off that the game was published, or why not.

1. **Run it** from the repo root: **python3 .claude/skills/dim2-sentry/scripts/game-report.py <N>** (needs the Sentry token, and `npm ci` once for the chain reader). It takes a few minutes. It reads the chain (the registered accounts, groups, votes, attestations, scores, draw winners; needs the archive RPC, no setup) and takes the Sentry window from it: from when registration opened (the block where the game was scheduled, less 2 minutes) to settlement plus 10 minutes. Untagged Sentry rows from before registration opened (the game before) are dropped. **--pad-before MIN** overrides the start. It then pulls Sentry, downloads every game log into docs-internal/game-logs/game-<N>/, builds the link picture, and writes the report document. It prints only where the files are:
   - **docs-internal/game-reports/g<N>/report.json**, the full local evidence report (shape in references/game-report.md), with a generated **summary**, **issues**, and **coverageNote**;
   - **report-publish.json** beside it, the trimmed main document the page reads;
   - **report-links.json** beside it, the trimmed companion link-evidence document;
   - **sentry-pull.json**, **chain.json** and **links.json** beside it, the raw inputs;
   - the game logs (the files that were not in the folder before are new, add a row for each to docs-internal/game-logs/README.md).
   Options: **--out FILE**, **--logs-dir DIR**, **--ws URL** (another chain node, else PEOPLE_WS), **--pad-before MIN** (override), **--release-label VERSION** (the human release shown in the generated headline), **--no-chain** (the window then comes from Sentry's first and last game.index event), and **--chain-json FILE** (a frozen chain input). **--chain-json must point outside the output directory**: the run rewrites its generated inputs there, so an input inside it is rejected to prevent self-overwrite. A chain failure fails the run. Re-running is safe; it overwrites its own outputs.
2. **Read the report document in full**, not a summary of it. **facts[]** is a starting checklist (late confirm-screen overrides, accounts that reported with no telemetry, reporters who were backgrounded, phone clocks more than 30 s off, other builds, "lost membership" shown to candidates, default votes, ties). It is not the limit of what to look at. Go into sentry-pull.json, chain.json and the game logs wherever a fact needs checking, and look at the players, failures, steps and video the facts do not mention. Replace only the marked **Claude review (judgment only)** slot. Do not hand-edit generated numbers or data sentences: fix the generator or its inputs and rerun it. Link matching GitHub issues in judgment/action text: search with **gh issue list --search "<words>" --state all**, and say so when none matches. Leave a username or host build null when unknown and say so in an issue. Do not guess. The script's "other builds" and "joined" are definitions, read them before quoting a number.
   **The TL;DR (summary) has bold sections, never one paragraph.** The worked example is game 254 in references/game-report.md; the script writes it in that shape. Rules (Ionut's corrections, 5 and 16 Oct 2026):
   - One headline line: game, network, kickoff in local time (CEST in summer, CET from 25 Oct 2026), release. Then, per section, a blank line, the section name in bold on its own line (**Players**, **Telemetry**, **Video**, **Links**, **Performance adaptations**, **Claude review (judgment only)**) and plain bullets below it, never nested. The page renders the bold lines as headings.
   - Times in local time only, labelled CEST or CET as the date says (the script picks it). Never print UTC in the summary or anywhere a person reads (only the kickoff field stays ISO UTC).
   - Avoid acronyms; define any metric you quote in plain words (for example "Video round-trip time between the two phones"). STUN, TURN and Direct are fine as terms.
   - Use "%", never "points".
   - Players opens with who telemetry came from: "We picked up telemetry from 29 players during the game window; 8 had only the DIM2 chat running and didn't register or use the app, so the counts below follow the 21 who did." Then the waterfall from 29 ("29 players → 21 used the app or signed up → 18 registered → 14 joined → 14 finished"), then where they dropped out, counts only.
   - Packet loss is one figure per pair: "typical pair X %, worst pair Y % (at its worst moments)" (lossP50, lossP95). Never put two figures on the worst pair.
   - A query that failed after its retries is a gap the summary names under Telemetry ("- Gap: the <query> query failed for N players; their numbers are missing.") and the page shows in red; never publish a partial pull as complete.
   - Two different bandwidth numbers, never mixed: the browser's own encoder limit (rtc.quality_limited_s, "lowered the video of 13 senders") and our upload ladder (the app's five steps, "7 of 14 senders stepped down"). Each line says which it is. The browser line gives totals; names belong on the page.
   - Frame rate and picture height compare the same links over the same stretch: sent and received are joined on rtc.pair, directions one phone measured only partly (a reload or a late open) are kept and counted, and every count names its unit once ("104 link samples" per phone per peer per round, "104 link directions both phones reported", the same 104 link samples for hardware or software coding).
   - Counts must add up (registered = web + native); say who is not counted and why.
   - No mechanics or code details in the TL;DR; those go in issues[].
   - The coverage bullet gives the overall % and the web-only % when non-web players took part, and points to the coverage box. The breakdown itself lives in **coverageNote**. Never name players in the breakdown.
   - Cover every group (web, native, the player who failed to register, links, signalling); where there is no data write "n/a".
   - **coverageNote is written by the script** (game-report.py, from the chain, the link picture and Sentry), shown under the page's video coverage box. Do not rewrite it by hand, except to correct a wrong cause. Check its causes against the game logs and Sentry before you trust it: for example a player whose page was replaced mid-round (a new session, a rejoin) must read "Page reloaded mid-round", not "Late open". The structured version is in **coverage** (field **pct**, percent of the coverage metric).
3. **Render and look before showing Ionut or publishing.** Run **python3 .claude/skills/dim2-sentry/scripts/local_report_preview.py docs-internal/game-reports/g<N>**. It serves the real page at **http://127.0.0.1:8765/** through a read-only database stub containing **report-publish.json** and **report-links.json**; add **#links-<N>** for the dedicated screenshot view. Inspect the report and that view in a browser: names, counts, judgment, matrix values/tooltips, widths, truncation and overflow. A JSON test or screenshot alone is not enough.
4. **Publish in dependency order.** First republish **page/game-reports.html** as the DIM2 Game Reports page source. Only after that succeeds, use one ArtifactData **batch set** in collection **games** for **report-publish.json** as doc_id **g<N>** and **report-links.json** as doc_id **g<N>-links**, with the versions read immediately beforehand. Never publish the full local **report.json** or **links.json**. Never replace an older reviewed game with a fresh placeholder judgment: preserve its reviewed judgment or complete a new review first. **Writing needs edit access to the artifact**: ask its owner, ionut@parity.io, to share it with edit rights; without that, give the person both publish JSON files and their paths.
5. **If there is a team document for the game** (a game-day doc, a status thread), add one status line: the game, how many registered, reported and attested, and the top issues, with the artifact link.
6. **Say what changed**: the game, the players found, the issues raised.

The pull, the link picture and the manual steps below still work on their own. The one command calls them.

## Before publishing a report

Before publishing a game report, check each item below against the rendered page, and paste this list into the advisor review request ("check these specifically").

1. **Player counts must agree across the page.** g254 summary said "18 registered" while the Players section header said "Players (29)". The Players table lists every account with telemetry in the report window (registration opens to 10 min after settlement; 29 in g254), not only registered players (18). Either the summary names both numbers and what each counts, or the table is labelled so the difference is obvious. (Ionut, 15 Oct.)

2. **Stage labels must state the real window.** g254's funnel said "any telemetry (7 days before kickoff)" while the pull covers registration-opens−2 min to settlement+10 min. Ionut's rule: a report counts only telemetry from when the game was scheduled (registration opens) until it finished, which he approved as settlement + 10 minutes (the payoff screens open after settlement). Every count says that window. (15 Oct.)

3. **Numbers shown in two places must come from queries that agree.** A combined Sentry query (several fields at once) silently dropped rows: notification permission read 12 asked / 6 granted against 22 / 8 from per-message queries. Count each funnel step with its own query, and reconcile any two counts of the same thing before publishing. (15 Oct.)

4. **No cut-off text, and a cause must come before the step it explains.** g254 showed russeltest.02's drop reason cut mid-word ("timed out afte") and blamed Polkadot app timeouts that happened at 14:01-14:03, after registration closed at 13:52:30. Read every reason in full on the rendered page, and check its timestamp is before the stage's deadline (registration close for "registered", kickoff for "joined"). (15 Oct.)

5. **The summary (TL;DR) has every main section, in order:** the game line (number, network, kickoff CEST, release), Players, Telemetry, Video, Links, then anything game-specific (e.g. isolated joins). Links is: how pairs connected (STUN / TURN / Direct counts), video round-trip time typical and worst pair, packets lost typical pair and worst pair (its worst moments), the lowest frame rate and picture height on one link with what its sender sent, frozen video, and the bandwidth total. g254 was published without Links. (15 Oct.)

**How the advisor uses this list:** before every report review, print this section into the conversation and ask the advisor to check each numbered item explicitly.

After review and the local browser inspection, republish the page source first. Then batch-set both generated documents in the **DIM2 Game Reports** artifact at https://claude.ai/artifact/2hn8dX9fD7rxnp6GmXv3rF with collection **games**: **report-publish.json** as **g<N>** and **report-links.json** as **g<N>-links**. Read both existing documents immediately beforehand and pass their versions when replacing them. Republish from the linted JSON; never patch the live artifact by hand or overwrite reviewed judgment with a placeholder.

## The codec map

Which sender and receiver devices get video over which codec, and how well, from the live data:

    python3 .claude/skills/dim2-sentry/scripts/codec-map.py [--days 7 | --start ISO --end ISO] [--include-bots] [--by-host] [--min-links 3] [--json FILE]

One row per sender context x receiver context x codec (a context is OS + version + browser engine + engine major; iOS is WebKit and its version is the OS's; --by-host adds the host app). Per row: links (one viewer's side of one link in one round), the % that got video, the median time to first frame (first offer to first decoded frame), the p95 inbound freeze per link-round, and the top failure reasons. Bots are left out unless --include-bots. **--print-queries** prints the exact Sentry queries. It reads the per-link **rtc.link** row on new builds and the round metrics plus the funnel on older ones, so it works across releases; links with funnel points and no round summary are counted (outcome no-summary unless first_frame was stamped). Each row also shows what the sender's device says of encoding that codec and the receiver's of decoding it (**tx enc**, **rx dec**: hw, sw, no, unsupported, ? when the build did not probe), and **h264 sw/vp8 hw**: links that ran H.264 on a receiver that decodes it in software while it has VP8 in hardware. A second table lists each device context and model's answers per codec (h264 = constrained baseline 42e01f, h264_high = 640c1f, vp8, vp9, av1). The answers come from the **rtc.cap.<codec>.<encode|decode>** tags: once a session the app asks navigator.mediaCapabilities (type webrtc, 360x360, 300 kbit/s, 24 fps) and tags every event and metric point (full answers in the **media_caps** context). Below the matrix it lists mid-call implementation and codec changes (**rtc.impl_change**, and the older **rtc.decoder_change** steps). Tests: **python3 -m unittest test_codec_map** in scripts/.

## Chat coverage by platform

The chat worker (sdk **jollity.chat-worker**, tag **surface:chat**) sends no OS data, so chat-coverage.py joins its events to the same user's app events by **user.id** and borrows the app's device tags (os, host app and version). It prints a per-platform table (app users, chat users, coverage, chat events per chat user) and a per-user table where a user with app events and no chat events is flagged **NO CHAT**: that is how you see a platform that sends nothing. Chat counts cover events and spans over the window; the device context is looked up over **--context-days** (default 30), since the worker polls without the app being opened. A chat user with no app row there is "chat only (no app use)" (a player who only uses the chat), a user whose host.app is "Headless Signing Host" (truapi-host: bots and the desk dev-host) counts as a bot, a user on two OSes as mixed. Bots (user.ids with a test.tag app row; the worker sets none) are left out unless **--include-bots**; times are local. Tests: python3 -m unittest test_chat_coverage (in the scripts folder).

    python3 .claude/skills/dim2-sentry/scripts/chat-coverage.py [--days 7 | --start ISO --end ISO] [--context-days 30] [--include-bots] [--json FILE]

## Where the data is

- Org **paritytech**, project **jollity-next**, project id **4512177451237456**, API base **https://de.sentry.io/api/0**.
- Test traffic (next dev, the desk harness, the e2e bots whose build carried NEXT_PUBLIC_SENTRY_DSN_TEST) is in project **dim2-testing**, id **4512256244777040**. Every script reads the project named by **DIM2_SENTRY_PROJECT** (default jollity-next; a comma list names several); sentry.py and game-report.py also take **--project** (the archive's scripts/e2e-live/sentry-logs.py was not ported). **dim2-testing also reads jollity-next** (bundles built before the test DSN, and games with both phones and bots, span both): one query over both ids, rows deduped on the event id. jollity-next alone reads jollity-next alone.
- Three datasets:
  - **spans**: journeys are root spans, so query **is_transaction:true**. Their steps are child spans. **span.duration** is the only numeric field on spans.
  - **errors**: failure events, plus the **game-log** info events. A game-log event carries the player's debug log as a JSON attachment.
  - **tracemetrics**: the rtc.* and ui.* metrics. This is where p50 and p95 work.
- Dashboards (read them in the Sentry UI): **5046285** Health, **5046342** Failure Breakdown, **5046343** Per-Game Drill-down. Editing dashboards is out of scope for this skill. A dashboard PUT has no undo.

## Tags you filter on

- **game.index**: the game number. Set from sign-up onward. Journeys before sign-up do not carry it, so pull a player's earlier journeys by user.id in the game's time window.
- **user.id**: the account address. **user.username**: the player's name, sent from v0.1.17 on. A player who stops before the results card used to send none; the app now asks the host at open. game-report.py looks each still-nameless account up over the 30 days of Sentry before the window ends and adds the hits to the mapping; chat-only accounts stay nameless, since the chat worker never sends a username (a fact says how many). Names still missing are filled from the shared local **docs-internal/telemetry-store/usernames.json**; game-report.py adds every name it learns, and **scripts/seed-usernames.py** rebuilds it from the archived logs. The tracked **data/usernames.json** is a read-only bootstrap seed. The shared mapping is packed encrypted by the analytics publish step (not ported from the archive yet). A row's **usernameSource** says where its name came from: sentry, log or mapping.
- **session.id**: one app open.
- **environment**: the host name the app is served from (dim2.paseo, dim2next.paseo, dim2-pr<N>-sandbox00 ...). A name we can't recognise is never filed as the baked product: environment **local** (env.source **local**) when it's served over plain http or file, otherwise environment **unknown** (env.source **host-unknown**).
- **release**: jollity-next@<source hash>.
- **device.*** and **host.***: device.os, device.os_version, device.engine (chromium, chromium-webview, webkit), device.engine_version (Chromium major; none on iOS, where the OS version is the engine's), device.model, host.app, host.app_version. device.engine and device.engine_version are on metric points from the codec-map build on. Android hosts send no version today. **device.model is ours** (from the client hints or the user agent, and the app also sends it as the device context). Sentry's own **device** and **device.family** tags, and contexts.device when the app did not send one, come from its server-side user-agent parser and are not reliable (it cut a Motorola's model to "rola edge 30 pro Build/...; wv"). Filter and group by device.model.
- **lowpower.reason**: next to lowpower, why the mode is on: probe-weak, probe-weak-confirmed, probe-no-verdict (the probe saw no frames, or the page hid during 3 samples), debug-menu, url, manual; none when off. Older builds send none. The device probe v3 also sends the median as ui.probe_frame_median_ms, and a steady 30 fps cap (confirmed by a steady second sample) clears the check with probe.rule steady-cap. Watch the Android rows: a weak phone that tops out at 30 fps and holds steady twice would be cleared.
- **lowpower** and **probe**: every metric point and event carries both. lowpower is on or off: the mode when the app sent it. probe is done (the device probe finished on this page load) or none (?lowpower=1, or before the verdict). Probe v5 builds hold every player on a probe screen until the verdict, a late join too. Older builds send neither.
- **test.tag**: e2e-<tool> on scripted runs. Leave those out of real-player analysis (add **!has:test.tag**). The game report does it per player: a player with any e2e- test.tag is a **bot** (`bot` on the player row, a "bots" fact), kept in the funnel, join, votes and report filing but left out of the smoothness, device, host and video numbers; bots run as environment local and the pull never filters on environment. **Step spans carry no test.tag** (only a journey's root span does), so `!has:test.tag` keeps bots in a query of steps such as game.rtc.path: across games, leave them out with `!environment:local` (for one game, keep filtering by game.index). Found 10 Nov 2026: a first count of TCP-relay paths was mostly the e2e bots.

## Journeys and steps

A journey is a root span with op **journey.<name>**. A step is a child span with op **<journey>.<step>**. Source: **JOURNEYS** in apps/jollity-app/lib/telemetry/journeys.ts. Re-read it if this table looks stale. The join and game journeys share one trace per game.

| Journey | Steps | Outcomes (journey.outcome) |
|---|---|---|
| app-open | host.connect, host.identity, chain.genesis, permissions.check | ready, gate, no-source |
| permissions | camera, network, network.turn-receipt, webrtc, statements | granted, refused |
| person | key.find, proof, bind.broadcast | bound, already-bound, failed |
| game-signup | route, tx.build, tx.broadcast, tx.landed | landed, failed, not-eligible, unbound, retrying, closed |
| join | camera.acquire, chain.read, statements.first_page, turn.proof, turn.issue, mesh.open, peer.first, peer.all, rtc.peer, app.hidden | full, partial, isolated |
| game | round.1, round.2 (one per round), report.submit, report.landed, rtc.stall, rtc.reconnect, rtc.path, camera.recover, app.hidden | completed, abandoned, isolated |
| payoff | attestations.ready, draw.show, chest.show, app.hidden | shown, stalled |
| name-link | lookup, funds, sign, store, note, verify | linked, already-linked, unfunded, not-signed, failed, skipped |

Useful attributes on them (all text): **journey.sad** and **journey.sad_reason** (something went wrong, maybe recovered), **journey.expected** ("true" when the player's own "no"), **signup.route**, **signup.stage**, **signup.retry_reason**, **person.stage**, **permissions.step**, **permissions.reason**, **rtc.path**, **rtc.outcome**, **rtc.pair**, **turn.received**, **turn.stage**, **turn.status** (on the join or game journey), **rtc.last_stage** and **rtc.role** (on a join's rtc.peer step), **rtc.local_type**, **rtc.remote_type**, **rtc.protocol**, **rtc.relay_protocol**, **rtc.relay_protocol_source** (stats, url or unsupported), **rtc.turn_host** (a local relay's TURN host), **rtc.network** (on the game's rtc.path step), **rtc.unsupported** (on a round step: what the browser's stats could not measure), **camera.state**, **camera.reason**, **draw.entered**, **payoff.stage**, **name_link.surface** (app, chat), **name_link.stage** (the step a link reached; setup before the first), **name_link.why** (a skipped link's: no-host, no-username, no-chain), **name_link.store** (existing, none), **name_link.allowance** (not-needed, allocated, not-allocated; the host's own words in name_link.allowance_answer), **name_link.paid_in** (pgas, native, none). The **signup.error_surfaced** counter records how often the player saw recovery guidance; group it by **signup.retry_reason**.

Builds before PR #1283 used **network.turn-issue** and **turn.issued**. Queries spanning builds from both sides of that change must include both the old names and **network.turn-receipt** / **turn.received**.

**The name link is the social draw's other half (#456).** In the background, before Register (the app from its first seat read, the chat worker from its poll), the player's username is linked to the jollity account holding their draw tickets; until it is, the wheel shows those tickets nameless. No sign-up goes without it: Register waits ("Getting your seat ready…"; on the game-signup journey **signup.retry_reason** name-pending in the app; **signup.name** linked or not-linked and **signup.name_wait_ms** in the chat, where a tap that waits two minutes ends blocked with a notice to try again), and any link that did not end linked goes again on the ladder, at once while a tap waits. **name_link.trigger** says what asked: background or register (a waiting tap). One journey.name-link per link: on the app a step per stage, so the **sign** step's span.duration is how long the root's signature took; the chat worker sends it as a transaction without child spans, with that time as **name_link.sign_ms**. Group by journey.outcome, name_link.surface and name_link.trigger.

Journey and step timestamps are stamped from the wall clock (Date.now()), not the SDK's performance clock, so they hold on a phone whose page was frozen (game 166, #221, spans up to 17 minutes early). Earlier journeys, from before this fix may still be early; error events and game-log lines were always right. Each journey root also carries (text), at its start and again at its end: **chain.time.start/end** (chain clock in seconds, when the game source is up), **chain.block.start/end** (the best block number the source has seen; absent on the backend engine or before the first block), **wall.time.start/end** (Date.now() in ms) and **clock.span_drift_ms** (start) / **clock.span_drift_ms.end** (the SDK's span clock minus the wall clock; a large negative number means the SDK's own spans, such as pageload and http, run early). Together they place a journey on the chain whatever the span clock says. Journeys with a drift beyond 5 s send one **clock-drift** failure per session, which shows how often the span clock freezes per host.

### Failure kinds

Failure events (errors dataset, tag **failure.kind**, grouped by kind and reason). Source: FAILURE_KINDS in apps/jollity-app/lib/telemetry/failures.ts.

- **camera-unavailable**, **permission-refused**: the player or device said no (some reasons are "expected").
- **host-call-failed**: a call into the host app failed.
- **person-bind-failed**, **signup-failed**: the identity or sign-up path broke.
- **mesh-isolated**, **peer-failed**: video links did not form.
- **turn-unavailable**: relay credentials could not be had for a mesh open (reason proof, issue or config; context status and the server's text). Not expected. The round played on STUN only.
- **report-failed**: the game report did not land.
- **attestations-late**, **art-failed**, **draw-unplayable**: payoff problems.
- **name-link-failed**: a username link stopped short; the sign-up stands, the tickets stay nameless. Reason **not-signed** (expected: the player declined the root's signature, or the host could not ask), **unfunded** (no PGAS or native coin for the DotNS deposit, the allowance included), or, for a link that failed, the stage it stopped in (setup, lookup, funds, sign, store, note, verify). Context has **stage** and **error** (the link's last warning). Sent by both surfaces.
- **render-crash**: the UI crashed.
- **clock-drift**: the phone's span clock is more than 5 s off the wall clock (context drift_ms, journey). Once per session.
- **previous-session-end** is an informational diagnostic sent once on every app open, not a separate failure event. Tag **previous.end** is one of **clean-close**, **killed-background**, **crash-or-kill-foreground**, **host-reload**, **own-reload**, or **unknown**. It carries the synchronous pagehide/freeze/visibility evidence plus numeric **gap_ms**, **visibility_changes**, **game_index**, **turn**, **live_video**, and **heap_mb** in **previous.session** context. Interrupted roots remain in **open_journeys** and **open_journey_steps**. An in-game background/foreground kill or a mid-round host reload keeps **failure.kind=unclean-exit** on this same event for dashboard continuity; host reload uses **failure.reason=host-reload** so it remains distinguishable. The app-open journey carries the classification as **previous.exit**.

Expected failures go out as warnings with journey.expected "true". Dashboards leave them out of the failure rate.

### Metrics (tracemetrics)

Source: apps/jollity-app/lib/telemetry/metrics.ts header, apps/jollity-app/lib/telemetry/smoothness.ts, apps/jollity-app/lib/journeys/rtc-quality.ts. **Each name has one fixed unit. A query with another unit returns nothing.**

| Metric | Unit | Tags |
|---|---|---|
| rtc.rtt_ms | millisecond | stat p50 or p95, round, rtc.peer, rtc.path |
| rtc.jitter_ms | millisecond | stat p50 or p95, round, rtc.peer, rtc.path |
| rtc.loss_pct | percent | stat p50 or p95, round, rtc.peer, rtc.path |
| rtc.freeze_ms | millisecond | stat total, round, rtc.peer, rtc.path |
| rtc.in_fps, rtc.out_fps, rtc.in_height, rtc.out_height, rtc.out_kbps | none | stat p50, round, rtc.peer, rtc.path |
| rtc.quality_limited (counter) | none | reason, round, rtc.peer, rtc.path |
| rtc.quality_limited_s | second | reason, stat total, round, rtc.peer, rtc.path |
| rtc.peer_paused (counter, value in seconds) | none | round, rtc.peer, rtc.path |
| every rtc.* round point above (attributes, text) | | rtc.codec (negotiated: H264, VP8; the sent stream's, else the received one's), rtc.codec_fmtp (profile-level-id and packetization-mode), unsupported where the stats lack a codecId or a codec report |
| every rtc.* round point above, newer builds | | rtc.codec_in / rtc.codec_in_fmtp (what this viewer decoded), rtc.codec_out / rtc.codec_out_fmtp (what it sent), rtc.encoder_kind / rtc.decoder_kind (hardware, software, unsupported) |
| rtc.link (counter, one per link per round) | none | THE LINK ROW: every round attribute plus rtc.outcome (video, connected-no-video, connected-unmeasured, not-connected, standby: a next-round link held back on purpose, not a loss), rtc.last_stage (furthest funnel stage, or carried when round 2 kept round 1's room), rtc.seen (#603), rtc.rtx, rtc.red, rtc.ulpfec, rtc.flexfec (negotiated, off the SDP), rtc.rebuilds (0, 1, 2, 3+), rtc.role |
| rtc.link.ttff_ms | millisecond | the same attributes; first offer to first decoded frame, when this round's room stamped both |
| rtc.link.freeze_ms | millisecond | the same attributes; inbound freeze over the round, 0 included |
| rtc.link.path_ms | millisecond | the same attributes, one point per path the link spent connected time on in the round: that **rtc.path** and, on a relay, its **rtc.relay_protocol** (tcp, tls, udp, remote). The exposure: link-time on a TCP relay is what rtc.link.failed counts are rated against (#944). From the nm-relay-telemetry release on; every round attribute also carries the link's last rtc.relay_protocol when it relayed |
| rtc.impl_change (counter) | none | rtc.direction (in, out), rtc.impl_from, rtc.impl (families: FFmpeg, not "FFmpeg (fallback from ...)"), rtc.impl_kind_from, rtc.impl_kind, rtc.codec_from, rtc.codec, rtc.codec_fmtp, round, rtc.peer, rtc.pair |
| rtc.path_changes (counter, only rounds with a change) | none | round, rtc.peer, rtc.path, rtc.pair |
| rtc.funnel_ms | millisecond | stage (offer, answer, ice_checking, connected, first_frame), rtc.role (initiator, answerer), round, rtc.peer, rtc.pair, rtc.standby (true only on a next-round standby link) |
| rtc.turn_ttl_left_s | second | turn.received (true, cached), round |
| rtc.coverage_s | second | round, rtc.peer, rtc.path, rtc.pair |
| rtc.coverage_pct | percent | round, rtc.peer, rtc.path, rtc.pair |
| rtc.video_ms | millisecond | round, rtc.peer, rtc.pair — decoded video in one reload-safe slice |
| rtc.present_ms | millisecond | round, rtc.peer, rtc.pair — visible live-page time in that slice |
| ui.frame_ms | millisecond | scene, stat p50 or p95 |
| ui.slow_frame_pct | percent | scene |
| ui.moment_frame_ms | millisecond | moment (intro, play, turned, warn, ending, gap), stat avg or max — game.round only |
| ui.long_task_ms | millisecond | scene, stat p95 or max |
| ui.long_tasks (counter) | none | scene |
| ui.js_heap_mb | none | (Chromium only) |
| ui.probe_frame_ms | millisecond | stat p95, probe.version, probe.rule, probe.samples, probe.borderline_from_ms, probe.weak_from_ms, probe.stage (countdown or late) and probe.attempts (samples ended on a hidden page) from v5 (v1 builds: probe.threshold_ms) — one point per device, the deciding sample |
| ui.probe_frame_median_ms | millisecond | same attributes — the median of that sample (v3 builds) |
| ui.probe_frames | none | same attributes — the frame count of that sample |
| ui.probe_sample_ms, ui.probe_sample_frames | millisecond, none | same attributes plus probe.sample — one point per probe sample (v2 builds) |
| draw.name_lookup (counter) | none | name.outcome (named, no-store, no-note, not-for-account, no-username, no-holder, no-dotns, read-failed), name.ticket (winner, other) — one chain read of a wheel ticket's name: the winners are read as the wheel lands, any other ticket when tapped, each once per page (#456) |
| draw.name_lookup_ms | millisecond | the same attributes; that read's time. A failed read (read-failed, no-dotns) also carries name.error (no-chain, timeout, not-pinned, chain-lost, disconnected, decode, other) |
| draw.name_shown (counter) | none | name.via (winner, tap), name.shown (name, fallback, none) — what a name bubble ended up showing. A winner counts once, its first showing (none for a winner the wheel had no name for); a tap counts each time a tapped ticket's bubble settles. A bubble a later tap replaced before its name came is not counted |
| draw.name_wait_ms | millisecond | the same attributes; from the bubble's pop to its name (the 380 ms pop included), for name and fallback |
| draw.ticket_tap (counter) | none | name.ticket (winner, other) — a tap that picked a ticket once the draw was over. Its first read is a draw.name_lookup with name.ticket other or winner; a second tap on the same ticket is a tap with no read (the page caches the name) |

Every per-link rtc.* point (all of the above except rtc.turn_ttl_left_s, which is per mesh open) also carries **rtc.pair** (see Rules). Every point also carries the scope tags (game.index, user.id, session.id, release ...).

### Logs records (logs)

Typed rows in the **logs** dataset: query them by **message**, e.g. `message:"rtc.link.failed"`. Text attributes read as plain fields. Numbers and booleans are typed, so read them as `tags[<name>,number]` or `tags[<name>,boolean]`; plain `-f rtc.heal.cohort.size` comes back empty. The time is the time the row was sent, so a cohort's row lands about 30 s after its failures (its recovery wait).

| message | when | attributes |
|---|---|---|
| rtc.link.failed | each established link that fails, once per outage (#944) | rtc.link.failed.kind (**torn-down**: ICE `disconnected` and `failed` within 1 s, the transport closed under the link, as a TURN socket reset; **timed-out**: ICE went quiet first and consent ran out), .quiet_ms (disconnected to failed), .up_ms (since this connection connected), .path (direct, relay, unknown), .relay_protocol, .relay_protocol_source (stats or url), .turn_host (on a relay), .page_hidden, .since_net_change_ms (absent with no change this mesh), plus the link's rtc.pair, rtc.peer and round |
| rtc.heal.cohort | two or more established links failing within 250 ms, sent once every member recovered or after 30 s | rtc.heal.cohort.size, .window_ms, .relay_protocol and .turn_endpoint_host (shared, mixed or unknown), .fail_kind (torn-down, timed-out, mixed, unknown), .quiet_ms.N and .recovery_ms.N per member in failure order (absent when unknown or unrecovered), .unrecovered, .page_hidden and .since_net_change_ms (at the first failure). No peer identity |
| rtc.heal_episode | one row per heal episode, from a link's drop to healthy or given up | rtc.heal_ladder, rtc.heal_steps, rtc.heal_steps_dropped, rtc.heal_episode_healed, rtc.heal_end, rtc.heal_episode_ms, plus the link's attributes |
| rtc.away_period | one row per stretch a peer was away | rtc.away_reason, rtc.away_return, rtc.away_last_attempt, rtc.away_attempts, rtc.away_offerer, rtc.away_offerer_role, rtc.away_ms, plus the link's attributes |

For the torn-down relay rate, divide `rtc.link.failed` rows with kind torn-down and relay_protocol tcp by the `rtc.link.path_ms` sum for relay tcp. Before the nm-relay-telemetry release an iPhone's relay protocol reads **unsupported** (on rtc.path) or **unknown** (on a cohort).

## Rules that bite

Each of these was learned the hard way.

- **Filter a game by game.index, never by environment.** Game 159's localhost web client was filed under dim2.paseo and got missed.
- **Span attributes are strings.** A numeric comparison on them fails. Use span.duration or tracemetrics for numbers.
- **rtc.peer is the viewer's own slot number.** Peer 2 on one phone is not peer 2 on another. To put both ends of one link side by side, use **rtc.pair** = `g<game>:r<round>:<accountA>~<accountB>` (round 1-based, accounts sorted): it is on every per-link rtc.* metric point and on the join's rtc.peer step and the game's rtc.reconnect and game.peer.away steps (not rtc.stall, which is about the whole mesh). The join's links carry the round the mesh opened for (normally r1).
- **The funnel shows where a pair stopped.** rtc.funnel_ms has one point per stage a link reached (offer, answer, ice_checking, connected, first_frame), in ms from the mesh opening, from each end. Count pairs per stage with count(value) by stage. offer and answer mean "this side sent or received it", so an answerer reaches all five stages too; rtc.role says which end. first_frame is seen by the 3 s stats loop, so it is up to 3 s late. A pair that never connects has no connected point; its join rtc.peer step carries **rtc.last_stage** (the furthest stage, or none) and **rtc.role**.
- **A decoder or codec change is a step through the game (#556).** When a link's decoderImplementation or its negotiated codec changes mid-game (Android falling back to FFmpeg, a codec switch), the game journey gets an **rtc.decoder_change** step (peer id, pair, rtc.decoder_from, rtc.decoder, rtc.codec_from, rtc.codec, rtc.codec_fmtp). The first reading of a link is no change. iPhones hide the decoder name, so read their codec off **rtc.codec** and **rtc.codec_fmtp** (a High profile 640c1f where Constrained Baseline 42e01f was negotiated is the WebKit bug).
- **The selected path is a step through the game.** Every time a link's selected candidate pair is first set or changes while the game runs, the game journey gets an **rtc.path** step (peer id, pair, rtc.path direct, stun or relay, local and remote candidate type, protocol udp or tcp, relay protocol udp, tcp or tls on a relay, where it was read (**rtc.relay_protocol_source**: stats, or url on an iPhone, whose WebKit reports no relayProtocol but does report the TURN url), the TURN host (**rtc.turn_host**), network type), and the game log gets `[jollity-rtc] path <peer> <local>/<remote> <protocol>` (also during the join, where the pair is on the join's rtc.peer step as rtc.path). A path is its candidate types and protocols, so a rebuild onto the same route is no change. Fields the browser does not report say **unsupported** (the relay protocol when neither the browser nor the TURN url says it, and the network type off Chrome); **remote** means only the far end relays. **rtc.path_changes** counts changes per peer per round; time on each path, per relay protocol, is **rtc.link.path_ms**.
- **Every round without a relay names why.** On each mesh open the join journey (the game journey for later rounds) gets **turn.received** (true, false or cached), **turn.stage** and **turn.status** ("none" when absent, e.g. after a success or when no HTTP status exists). A failure stage is proof (the host gave no personhood proof), issue (the issuer refused, timed out or answered badly) or config (no issuer for the network), and it sends one **turn-unavailable** failure (reason = the stage; context has the status and the server's own text, masked words defused: "credential" reads "cr*dential", capped at 120 characters; not expected). The text is read after the mesh already has its STUN-only list, so the failure arrives a moment after the open. Good credentials send **rtc.turn_ttl_left_s**. Retry and caching are unchanged (#225).
- **Coverage is decoded video, not "connected", and comes from live metrics.** At the first 3 s stats poll after ten seconds, at a round/page tail, and before a hide, each viewer records rtc.video_ms and rtc.present_ms per pair. Sentry's own metric cadence flushes those points; pagehide retains the existing final client flush. The report sums every page session against the chain round window, so a reload loses only its unsent tail. A missing expected pair is loss when that viewer sent coverage telemetry elsewhere in the game; only a viewer with no coverage telemetry anywhere is unavailable. One available direction is used and disclosed; two use the lower; neither available is n/a. Round-edge sums more than one poll above the chain duration are clipped and disclosed. rtc.coverage_s / rtc.coverage_pct are the legacy end-of-round comparison and stay only until two live games agree side by side. Logs diagnose causes and draw the timeline; they no longer supply the coverage number.
- **A build without telemetry sends nothing.** dim2.paseo had none before v0.1.17 went live at 17:45 CEST on 1 Oct 2026, so a missing journey can mean an old build.
- **The API needs every sort field also in field.** sentry.py adds it for you.
- **Give times to people in Central European time**, spelled out: CEST (UTC+2) in summer, CET (UTC+1) in winter. Sentry returns UTC, so convert.

## Running queries

All commands run from the repo root. The shape:

    python3 .claude/skills/dim2-sentry/scripts/sentry.py query <dataset> "<query>" -f <field> [-f ...] \
      [--period 24h | --start 2026-10-01T15:45:00 --end 2026-10-01T16:15:00] [--sort=-timestamp] [--limit 100] [--json]

- **-f** is one column. Add aggregates like count(), p95(span.duration), p95(value).
- The query is Discover syntax: **key:value** terms joined by spaces (AND), **!key:value** to exclude, **has:key**, wildcards like title:*camera*.
- Times are UTC. Use --period for "the last N hours or days", or --start and --end.
- Add --json for raw rows. Use **event <id>** for one event and **attachment <id> --out log.json** for a game log.

Ready-to-run examples (set S=.claude/skills/dim2-sentry/scripts/sentry.py):

    # all journeys of game 160
    python3 $S query spans "is_transaction:true game.index:160" -f timestamp -f user.username -f span.op -f journey.outcome -f span.duration --sort timestamp --period 7d

    # one player's timeline, by username (or use user.id:<address>)
    python3 $S query spans "is_transaction:true user.username:theender.02" -f timestamp -f span.op -f journey.outcome -f game.index -f span.duration --sort timestamp --period 7d

    # failures in the last 24 h, grouped by title
    python3 $S query errors "!has:test.tag level:[error,warning]" -f title -f "count()" -f "count_unique(user.id)" --sort="-count()" --period 24h

    # sign-up outcomes by host version
    python3 $S query spans "is_transaction:true span.op:journey.game-signup" -f host.app -f host.app_version -f journey.outcome -f "count()" --period 7d

    # p95 frame time by scene for a release (tracemetrics; the unit must match)
    python3 $S query tracemetrics "metric.name:ui.frame_ms stat:p95 release:jollity-next@<hash>" -f scene -f "p95(value)" -f "count(value)" --period 7d

    # average frame time by moment of the round for one game
    python3 $S query tracemetrics "metric.name:ui.moment_frame_ms stat:avg game.index:<N> !test.tag:e2e-*" -f moment -f device.model -f "p50(value)" -f "p95(value)" -f "count(value)" --period 7d

    # device probe p95 by device model and probe version
    python3 $S query tracemetrics "metric.name:ui.probe_frame_ms stat:p95 !test.tag:e2e-*" -f device.model -f probe.version -f lowpower -f "p50(value)" -f "max(value)" -f "count(value)" --period 7d

    # video round-trip p95 by path
    python3 $S query tracemetrics "metric.name:rtc.rtt_ms stat:p95" -f rtc.path -f "p95(value)" -f "count(value)" --period 7d

If a tracemetrics aggregate comes back empty, check the unit (see the metrics table) and try the same query with plain fields and --limit 20.

## Link picture

Turns a game's player logs (docs-internal/game-logs/game-<N>/*.json) into who could see whom. Needs no Sentry token.

    python3 .claude/skills/dim2-sentry/scripts/game-links.py docs-internal/game-logs/game-166 --out links.json

It prints a short summary (the partial and dead pairs per round) and writes the JSON: **players**, **rounds**, **matrix** (one entry per pair per round, with the group it played in), **timeline** (one row per viewer to peer link, as state segments) and **events** (restarts, app hidden or shown, rejoins, m-line errors, session starts).

- **Coverage** of viewer to peer is the share of the round during which the link was connected AND a track had arrived. A pair takes the lower of the two directions when both players have a log (seenBy **both**), else the one that exists (**a** or **b**; a is the account that sorts first). With no log on either side it is **unknown**, coverage null.
- **State:** live is 0.9 or more, partial is 0.5 to 0.9, dead is under 0.5, unknown is no data for a pair where both players joined, **never-joined** is a neutral non-coverage state when either registered player had no telemetry from or about them during the game and no report on chain, and **relay** is a pair that would be live but whose selected path was a relay (from either end's path line). This is the same presence rule as the report funnel's joined stage. Each matrix entry also has **path** (relay, stun, direct or unknown): the path in force at the end of the round, relay if either end's was relay. Path lines exist only for games played on builds with the rtc.path logging; older logs have path unknown. Path changes are **events** of kind path.
- **Timeline states:** connecting, connected, reconnecting (dropped, ICE restart, rebuild or a stalled video), failed, disconnected (the player left the room), away (the viewer's app was out of view; shown over the link but not subtracted from coverage), not-grouped, and never-joined. The last two are neutral and excluded from bad-link filtering and coverage.
- **Rounds** follow the chain's play windows when game-report.py passes them: one round per window, so a group that plays both rounds together (the mesh opens once) still gives one matrix entry per pair per round, each with its own play window (the second round's link is read from where the mesh opened, then cut to the round). Without play windows, rounds are read from the mesh: each round opens a new room (the room key changes), and the rooms that open within 40 seconds of each other are one round's groups. A round ends at its last sealed turn, else at the next mesh open, else when the data channels closed. Every viewer is measured to the median end, so a player who left early drags the pair down.
- **Path:** read from the `[jollity-rtc] path` log lines. Games before the build that logs them print candidate stats only for a failed link, so their pairs have path unknown and are never marked relay.
- **Cut logs and missing players** are fine: a log that stops early is measured to its last line, a player with no log still appears in players (name taken from other games' logs when known) and their pairs are seen from the other side.
- **Matrix labels:** **n/j** means at least one endpoint never joined by the presence rule above; hover text identifies the exact absent endpoint(s), while row and column headers keep the player's plain name. **n/a** means both endpoints joined but neither side has a usable log. The **#links-<N>** view lays out the same matrices for screenshot review.
- Tests: python3 -m unittest test_game_links (in the scripts folder).

## Updating the game report by hand

The one command above does all of this. These are the manual steps behind it.

The page is **DIM2 Game Reports**: https://claude.ai/artifact/2hn8dX9fD7rxnp6GmXv3rF. Everyone in the Parity org can read it. Writing needs edit access to the artifact: ask its owner, ionut@parity.io, to share it with edit rights.

1. **Find the window.** Kickoff comes from the game's join and game journeys (query them by game.index). Use about 20 minutes before kickoff to about 10 minutes after the payoff, in UTC.
2. **Pull the data:** python3 .claude/skills/dim2-sentry/scripts/game-report-pull.py <game> <start ISO UTC> <end ISO UTC> <out.json>. It finds the players, their journeys and steps, failure events, device profile, payoff facts, metrics and game-log meta.
3. **Write the document.** Claude reads out.json and builds the report following references/game-report.md (example: references/example-report-g160.json).
4. **Save both documents** with the ArtifactData tool: action **set**, collection **games**, doc_id **g<N>** for the report and **g<N>-links** for the link picture. Read each doc first when it exists and pass **if_version**.
5. **Add the link picture.** Run game-links.py on the game's logs and use its JSON as the companion document's **links** field (see references/game-report.md).
6. **Say what changed:** the game, the players found, and the issues raised.

Be thorough. Include every player in the room key, every journey, every failure event, the payoff facts, and video and frame times per player. Leave a username or host build null when unknown, and say so in an issue. Do not guess.

## Telemetry store: setup

The local telemetry store dumps each game's Sentry rows once into Parquet files under
**docs-internal/telemetry-store/<network>/g<N>/** and never changes them, so a report can be rebuilt
after Sentry has dropped the data. It is local only and git-ignored; the raw tables are the store.
The store scripts that read or write Parquet need **duckdb** and **pyarrow** (the live report does
not); they live in a venv beside this skill, which the live report and the existing tests never import.

1. **Create it once:** **python3 -m venv .claude/skills/dim2-sentry/.venv**
2. **Install the pins:** **.claude/skills/dim2-sentry/.venv/bin/pip install -r .claude/skills/dim2-sentry/requirements-store.txt**
   (duckdb, pyarrow and pytest, each pinned with ==; the venv does not see the user-site pytest.)
3. **Run the store tests with that interpreter:** **.claude/skills/dim2-sentry/.venv/bin/python -m pytest -q .claude/skills/dim2-sentry/scripts/test_store_*.py**
   test_store_paths.py is stdlib and runs under plain python3 too; the tests that import duckdb or
   pyarrow need the venv.
