# PreviewNet crew and scenario catalogue

**Generated file. Do not edit by hand.**

- Identity source: scripts/e2e-live/crew/catalogue.json
- Scenario presentation: derived from scripts/e2e-live/profiles.json and the validated live-E2E plans
- Regenerate: npm run e2e-live:crew-doc
- Catalogue version: 1
- Coverage: 30 active identities and 64 scenarios

Identity prose is presentation-only. Scenario parameters, narration, and evidence wording are derived from the executable live-E2E profiles and plans on every render.

## Boot harness

**PreviewNet Boot Harness:** Boot-only infrastructure checks without a playing identity.

The harness owns boot-only infrastructure checks and never impersonates a playing identity.

## Identities

| Identity | PreviewNet username | Portrait filename | Tagline | Speciality | Bound profiles |
| --- | --- | --- | --- | --- | --- |
| Captain Baseline | jollitypv.12 | captain-baseline.webp | Keeps the happy path honest. | ordinary healthy play and telemetry controls | baseline-iphone14-wifi, game259-clean-video-control, telemetry-t1-baseline, telemetry-t7-sentry-block |
| Lady Latency | jollitypv.15 | lady-latency.webp | Turns every millisecond into a plot twist. | slow and lossy mobile links | slow-pixel7-lte-poor, game259-lossy-video, telemetry-t2-host-storage-hang, telemetry-t8-sentry-429 |
| Relay Ray | jollitypv.20 | relay-ray.webp | When the direct route vanishes, Ray knows a side door. | relay-only paths and returning warm sessions | relay-iphonese-fastclock, host-stuck-waiting, turn-warm-returning, game259-dropped-lane-rebuild, telemetry-t3-ios-fetch-gate, telemetry-t9-blackout |
| Handoff Hank | jollitypv.25 | handoff-hank.webp | Changes lanes without dropping the cargo. | Wi-Fi-to-cell handoffs and blocked-network recovery | switcher-pixel6a-wifi-to-cell, host-stuck-in-game, network-blocked, telemetry-t4-kill-while-stuck, telemetry-t10-big-log |
| The Rejoiner | jollitypv.29 | the-rejoiner.webp | Always comes back with the same story. | background kills and relaunch recovery | kill-background-iphone13, turn-cache-relaunch, telemetry-t5-stuck-first-reopen, telemetry-t11-no-localstorage |
| Late Larry | jollitypv.30 | late-larry.webp | Arrives after the briefing and still checks the map. | joining late and delayed reporting | late-join-galaxya55-lte-good, telemetry-t6-freeze-after-report, telemetry-t12-reload-dedupe |
| Locale Lola | jollylaenus.48 | locale-lola.webp | Reads every clock in Los Angeles time. | Los Angeles English locale behavior | locale-la-enus |
| Tokyo Taro | jollytokyojp.41 | tokyo-taro.webp | Keeps the Tokyo console precise. | Tokyo Japanese locale behavior | locale-tokyo-jajp |
| Berlin Bruno | jollyberlinde.65 | berlin-bruno.webp | Brings Berlin order to every timestamp. | Berlin German locale behavior | locale-berlin-dede |
| Shutter Sheila | jollycamdeny.25 | shutter-sheila.webp | Keeps the shutter closed on purpose. | denied-camera recovery | camera-denied, camera-mute-loop |
| Phantom Phil | jollycammiss.50 | phantom-phil.webp | Tests the camera that was never there. | missing-camera handling | camera-missing |
| Narrowband Ned | jollyuplink.08 | narrowband-ned.webp | Squeezes a signal through the narrowest pipe. | constrained and recovering uplinks | uplink-limited-pixel6a, uplink-lift-pixel6a |
| Packet Jack | jollystorm.90 | packet-jack.webp | Forecasts trouble one packet at a time. | multi-stage packet storms | storm-pixel6a-timeline |
| Chainless Charlie | jollitypv.32 | chainless-charlie.webp | Finds out what survives when the chain goes quiet. | People-chain outages | chain-outage |
| Relay Rita | jollitypv.34 | relay-rita.webp | Knows exactly when the relay lights go dark. | TURN relay outages | relay-outage, glare-forcer |
| Tap Tony | jollitypv.38 | tap-tony.webp | Has never met a button he would tap only once. | rapid repeated interaction | tap-storm-pixel7 |
| Timewarp Tess | jollitypv.39 | timewarp-tess.webp | Keeps one boot in every timezone. | device-clock jumps | clock-jumps |
| Crash Carter | jollitypv.40 | crash-carter.webp | Pulls the host plug and labels every spark. | host crashes and restarts | host-crash, host-restart-classified |
| Longhaul Lou | jollitypv.47 | longhaul-lou.webp | Waits out the long outage with a fresh notebook. | prolonged host downtime | host-crash-long |
| Clockwork Clyde | jollitypv.56 | clockwork-clyde.webp | Winds a slow clock toward the truth. | correcting a clock that starts behind | clock-wrong-then-corrected |
| Future Fran | jollitypv.58 | future-fran.webp | Visits tomorrow and brings the clock back. | correcting a clock that starts ahead | clock-ahead-then-corrected |
| Background Betty | jollitypv.62 | background-betty.webp | Does her strangest work offscreen. | hidden-page clock steps | clock-step-while-hidden |
| Reload Rex | jollitypv.66 | reload-rex.webp | Reloads the deck without losing the mission. | mid-game reload and session restoration | reload-mid-game, reload-clean-close, reload-video-back |
| Freeze-Frame Fred | jollitypv.67 | freeze-frame-fred.webp | Stops the picture while the world keeps moving. | visible JavaScript freezes | visible-freeze |
| Datagram Dana | jollitypv.73 | datagram-dana.webp | Cuts the datagrams and counts what reconnects. | bounded UDP path cuts | udp-cut-40s, late-signal |
| Flip Fiona | jollyvideoflip.90 | flip-fiona.webp | Makes video vanish on cue and checks its encore. | video that appears, disappears, and returns | video-role-late-flip |
| NULL Nancy | jollyvideonever.97 | null-nancy.webp | Broadcasts exactly nothing and makes that useful. | peers that never provide video | video-role-late-never, one-way-video |
| Stutter Stu | jollitypv.77 | stutter-stu.webp | Freezes the pictures without cutting the handshake. | RTP video stalls with live ICE consent | video-stall-30s, dropped-answer |
| Chaincut Chip | jollitypv.78 | chaincut-chip.webp | Separates the host from the chain with surgical care. | app and host chain isolation | host-chain-lost |
| Fifth-Turn Felix | jollitypv.83 | fifth-turn-felix.webp | Times his entrance for the fifth turn. | joining on game turn five | late-join-turn-5, issue874-fast-late-join |

## Scenarios

### baseline — Reserved Baseline

**Purpose:** The PreviewNet harness uses the reserved healthy-path controls to play an ordinary game without an injected disruption.

**Expected behavior:** Evidence for Reserved Baseline must show ordinary play completes with truthful evidence; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **mode:** "reserved baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The PreviewNet harness is preparing Reserved Baseline on the reserved healthy-path controls. |
| verifying | The PreviewNet harness finished the actions; the run is checking 1 evidence requirement. |
| passed | Reserved Baseline recorded every required observation. |
| failed | Reserved Baseline is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### baseline-iphone14-wifi — Baseline Iphone14 Wifi

**Purpose:** Captain Baseline: change one verdict and restore it, then confirm during the countdown. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Baseline Iphone14 Wifi must show \[pending, not evaluated\] metric signup.taps every point &gt;= 1 and &lt;= 1, metric signup.landed\_ms every point &lt;= 30000, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **roleChangeVerdictThenConfirm:** true

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Captain Baseline is preparing Baseline Iphone14 Wifi on iPhone 14 on wifi. |
| verifying | Captain Baseline finished the actions; the run is checking 7 evidence requirements. |
| passed | Baseline Iphone14 Wifi recorded every required observation. |
| failed | Baseline Iphone14 Wifi is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.confirm-tap | Captain Baseline: confirm tap — restore the changed verdict and tap Confirm while its countdown is visible. | — | The run could not prove Captain Baseline's confirm tap action. |

### slow-pixel7-lte-poor — Slow Pixel7 Lte Poor

**Purpose:** Lady Latency: hold the link on lte-poor, throttle the CPU by 4x, and delay camera frames by 9000 ms. Test setup: Pixel 7 on lte-poor.

**Expected behavior:** Evidence for Slow Pixel7 Lte Poor must show metric camera.first\_open\_ms is recorded, metric rtc.decode\_ms is recorded, metric rtc.encode\_ms is recorded, metric rtc.quality\_limited is recorded, metric rtc.signal\_rtt\_ms every point &lt;= 5000, event camera.acquire with {"camera.warm":"true"} seen at least once, event rtc.peer with {"rtc.last\_stage":"offer"} seen &lt;= 1 times, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 9000
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 4
- **device:** "Pixel 7"
- **networkProfile:** "lte-poor"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Lady Latency is preparing Slow Pixel7 Lte Poor on Pixel 7 on lte-poor. |
| verifying | Lady Latency finished the actions; the run is checking 11 evidence requirements. |
| passed | Slow Pixel7 Lte Poor recorded every required observation. |
| failed | Slow Pixel7 Lte Poor is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### relay-iphonese-fastclock — Relay Iphonese Fastclock

**Purpose:** Relay Ray: force media through relay only, and start the device clock 75 seconds ahead. Test setup: iPhone SE on wifi through relay-only media.

**Expected behavior:** Evidence for Relay Iphonese Fastclock must show event rtc.path with {"rtc.path":"relay"} seen at least once, \[pending, not evaluated\] metric rtc.coverage\_pct every point &gt;= 90, event turn.issue with {"turn.ok":"true"} seen at least once, never has every established peer fail within 5000 ms, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 75
- **cpuThrottle:** 1
- **device:** "iPhone SE"
- **networkProfile:** "wifi"
- **relayOnly:** true
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Ray is preparing Relay Iphonese Fastclock on iPhone SE on wifi through relay-only media. |
| verifying | Relay Ray finished the actions; the run is checking 8 evidence requirements. |
| passed | Relay Iphonese Fastclock recorded every required observation. |
| failed | Relay Iphonese Fastclock is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### switcher-pixel6a-wifi-to-cell — Switcher Pixel6a Wifi To Cell

**Purpose:** Handoff Hank: at turn 2 switch the link to lte-good, and drop the whole link for 15 seconds. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Switcher Pixel6a Wifi To Cell must show \[pending, not evaluated\] event net.change seen at least once, event rtc.reconnect seen at least once, event rtc.heal with {"rtc.healed":"true"} seen at least once, metric rtc.heal\_ms is recorded, metric rtc.coverage\_pct every point &gt;= 60, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it"; appearances are allowed only inside the scripted fault window and recovery margin, and page never shows "We couldn't connect you to anyone."; appearances are allowed only inside the scripted fault window and recovery margin; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **network1AtTurn:** 2
- **network1BlackoutS:** 15
- **network1Profile:** "lte-good"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Handoff Hank is preparing Switcher Pixel6a Wifi To Cell on Pixel 6a on wifi. |
| verifying | Handoff Hank finished the actions; the run is checking 9 evidence requirements. |
| passed | Switcher Pixel6a Wifi To Cell recorded every required observation. |
| failed | Switcher Pixel6a Wifi To Cell is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 2, Handoff Hank will switch the link to lte-good, and drop the whole link for 15 seconds. | Handoff Hank's network phase has ended (switch the link to lte-good, and drop the whole link for 15 seconds); recovery evidence is now being checked. | The run could not prove Handoff Hank's network phase: at turn 2, switch the link to lte-good, and drop the whole link for 15 seconds. |

### kill-background-iphone13 — Kill Background Iphone13

**Purpose:** The Rejoiner: kill the app in round 2 and relaunch it, then hide the app 3 seconds after confirmation opens and show it again after 9 seconds hidden (12 seconds after confirmation opens). Test setup: iPhone 13 on wifi.

**Expected behavior:** Evidence for Kill Background Iphone13 must show event app-open with {"previous.exit":"crash-or-kill-foreground"} seen at least once, \[pending, not evaluated\] event game-log seen at least once, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 13"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "kill-relaunch"
- **roleBackgroundFromGameEndS:** 3
- **roleBackgroundUntilGameEndS:** 12
- **roleKillInRound:** 2

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The Rejoiner is preparing Kill Background Iphone13 on iPhone 13 on wifi. |
| verifying | The Rejoiner finished the actions; the run is checking 7 evidence requirements. |
| passed | Kill Background Iphone13 recorded every required observation. |
| failed | Kill Background Iphone13 is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.killed | The Rejoiner: killed — kill the app in round 2. | — | The run could not prove The Rejoiner's killed action. |
| role.relaunched | The Rejoiner: relaunched — relaunch the app on the same host slot. | The Rejoiner completed relaunched; recovery evidence is now being checked. | The run could not prove The Rejoiner's relaunched action. |
| role.hidden | The Rejoiner: hidden — hide the app 3 seconds after confirmation opens. | — | The run could not prove The Rejoiner's hidden action. |
| role.visible | The Rejoiner: visible — show the app again after 9 seconds hidden (12 seconds after confirmation opens). | The Rejoiner completed visible; recovery evidence is now being checked. | The run could not prove The Rejoiner's visible action. |

### late-join-galaxya55-lte-good — Late Join Galaxya55 Lte Good

**Purpose:** Late Larry: hold the link on lte-good, and leave the app and rejoin after turn 1. Test setup: Galaxy A55 on lte-good.

**Expected behavior:** Evidence for Late Join Galaxya55 Lte Good must show event camera.acquire with {"camera.warm":"false"} seen at least once, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Galaxy A55"
- **networkProfile:** "lte-good"
- **relayOnly:** false
- **role:** "late-join"
- **roleJoinAfterTurn:** 1

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Late Larry is preparing Late Join Galaxya55 Lte Good on Galaxy A55 on lte-good. |
| verifying | Late Larry finished the actions; the run is checking 6 evidence requirements. |
| passed | Late Join Galaxya55 Lte Good recorded every required observation. |
| failed | Late Join Galaxya55 Lte Good is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.left-app | Late Larry: left app — leave the app before handover. | — | The run could not prove Late Larry's left app action. |
| role.rejoined | Late Larry: rejoined — rejoin after turn 1. | Late Larry completed rejoined; recovery evidence is now being checked. | The run could not prove Late Larry's rejoined action. |

### check-seat-preparing — Check Seat Preparing

**Purpose:** The PreviewNet harness: exercise a freshly bound seat while it is preparing. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Check Seat Preparing must show \[pending, not evaluated\] event game-signup with {"signup.retry\_reason":"bind-pending"} seen &gt;= 1 times, \[pending, not evaluated\] metric signup.taps every point &gt;= 1 and &lt;= 1, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **freshIdentity:** true
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "seat-preparing"
- **roleFreshLitePerson:** true

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The PreviewNet harness is preparing Check Seat Preparing on iPhone 14 on wifi. |
| verifying | The PreviewNet harness finished the actions; the run is checking 6 evidence requirements. |
| passed | Check Seat Preparing recorded every required observation. |
| failed | Check Seat Preparing is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### check-stale-build — Check Stale Build

**Purpose:** The PreviewNet harness: show the stale-build update gate before sign-up and prevent a transaction broadcast. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Check Stale Build must show page shows "Update available", event tx.broadcast never seen, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The PreviewNet harness is preparing Check Stale Build on iPhone 14 on wifi. |
| verifying | The PreviewNet harness finished the actions; the run is checking 6 evidence requirements. |
| passed | Check Stale Build recorded every required observation. |
| failed | Check Stale Build is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### locale-la-enus — Locale La Enus

**Purpose:** Locale Lola: run with the en-US locale in America/Los\_Angeles. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Locale La Enus must show \[pending, not evaluated\] event app-open seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **locale:** "en-US"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **timezone:** "America/Los\_Angeles"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Locale Lola is preparing Locale La Enus on iPhone 14 on wifi. |
| verifying | Locale Lola finished the actions; the run is checking 5 evidence requirements. |
| passed | Locale La Enus recorded every required observation. |
| failed | Locale La Enus is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### locale-tokyo-jajp — Locale Tokyo Jajp

**Purpose:** Tokyo Taro: run with the ja-JP locale in Asia/Tokyo. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Locale Tokyo Jajp must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **locale:** "ja-JP"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **timezone:** "Asia/Tokyo"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Tokyo Taro is preparing Locale Tokyo Jajp on Pixel 7 on wifi. |
| verifying | Tokyo Taro finished the actions; the run is checking 4 evidence requirements. |
| passed | Locale Tokyo Jajp recorded every required observation. |
| failed | Locale Tokyo Jajp is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### locale-berlin-dede — Locale Berlin Dede

**Purpose:** Berlin Bruno: run with the de-DE locale in Europe/Berlin. Test setup: iPhone 13 on wifi.

**Expected behavior:** Evidence for Locale Berlin Dede must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 13"
- **locale:** "de-DE"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **timezone:** "Europe/Berlin"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Berlin Bruno is preparing Locale Berlin Dede on iPhone 13 on wifi. |
| verifying | Berlin Bruno finished the actions; the run is checking 4 evidence requirements. |
| passed | Locale Berlin Dede recorded every required observation. |
| failed | Locale Berlin Dede is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### camera-denied — Camera Denied

**Purpose:** Shutter Sheila: put camera permission into the denied state and verify the terminal camera-recovery screen. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Camera Denied must show \[pending, not evaluated\] event camera.acquire seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "denied"
- **cameraReason:** "denied"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **expectedOutcome:** "camera-unavailable"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Shutter Sheila is preparing Camera Denied on Pixel 7 on wifi. |
| verifying | Shutter Sheila finished the actions; the run is checking 5 evidence requirements. |
| passed | Camera Denied recorded every required observation. |
| failed | Camera Denied is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### camera-missing — Camera Missing

**Purpose:** Phantom Phil: run with no camera device and verify the terminal camera-recovery screen. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Camera Missing must show \[pending, not evaluated\] event camera.acquire seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "missing"
- **cameraReason:** "no-camera"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **expectedOutcome:** "camera-unavailable"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Phantom Phil is preparing Camera Missing on Pixel 7 on wifi. |
| verifying | Phantom Phil finished the actions; the run is checking 5 evidence requirements. |
| passed | Camera Missing recorded every required observation. |
| failed | Camera Missing is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### uplink-limited-pixel6a — Uplink Limited Pixel6a

**Purpose:** Narrowband Ned: hold the link on lte-upload-limited. Test setup: Pixel 6a on lte-upload-limited.

**Expected behavior:** Evidence for Uplink Limited Pixel6a must show metric rtc.quality\_limited is recorded, metric rtc.encode\_ms is recorded, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "lte-upload-limited"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Narrowband Ned is preparing Uplink Limited Pixel6a on Pixel 6a on lte-upload-limited. |
| verifying | Narrowband Ned finished the actions; the run is checking 6 evidence requirements. |
| passed | Uplink Limited Pixel6a recorded every required observation. |
| failed | Uplink Limited Pixel6a is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### uplink-lift-pixel6a — Uplink Lift Pixel6a

**Purpose:** Narrowband Ned: hold the link on lte-upload-limited, force media through relay only, and at turn 4 switch the link to lte-good. Test setup: Pixel 6a on lte-upload-limited through relay-only media.

**Expected behavior:** Evidence for Uplink Lift Pixel6a must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **network1AtTurn:** 4
- **network1Profile:** "lte-good"
- **networkProfile:** "lte-upload-limited"
- **relayOnly:** true
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Narrowband Ned is preparing Uplink Lift Pixel6a on Pixel 6a on lte-upload-limited through relay-only media. |
| verifying | Narrowband Ned finished the actions; the run is checking 4 evidence requirements. |
| passed | Uplink Lift Pixel6a recorded every required observation. |
| failed | Uplink Lift Pixel6a is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 4, Narrowband Ned will switch the link to lte-good. | — | The run could not prove Narrowband Ned's network phase: at turn 4, switch the link to lte-good. |

### storm-pixel6a-timeline — Storm Pixel6a Timeline

**Purpose:** Packet Jack: hold the link on lte-good, at turn 3 apply 30% packet loss for 10 seconds, at turn 6 switch the link to lte-poor, and at turn 9 switch the link to wifi. Test setup: Pixel 6a on lte-good.

**Expected behavior:** Evidence for Storm Pixel6a Timeline must show event net.change seen at least once, event rtc.heal with {"rtc.healed":"true"} seen at least once, metric rtc.heal\_ms is recorded, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **network1AtTurn:** 3
- **network1ForS:** 10
- **network1LossPct:** 30
- **network2AtTurn:** 6
- **network2Profile:** "lte-poor"
- **network3AtTurn:** 9
- **network3Profile:** "wifi"
- **networkProfile:** "lte-good"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Packet Jack is preparing Storm Pixel6a Timeline on Pixel 6a on lte-good. |
| verifying | Packet Jack finished the actions; the run is checking 7 evidence requirements. |
| passed | Storm Pixel6a Timeline recorded every required observation. |
| failed | Storm Pixel6a Timeline is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 3, Packet Jack will apply 30% packet loss for 10 seconds. | Packet Jack's network phase has ended (apply 30% packet loss for 10 seconds); recovery evidence is now being checked. | The run could not prove Packet Jack's network phase: at turn 3, apply 30% packet loss for 10 seconds. |
| network.2 | at turn 6, Packet Jack will switch the link to lte-poor. | — | The run could not prove Packet Jack's network phase: at turn 6, switch the link to lte-poor. |
| network.3 | at turn 9, Packet Jack will switch the link to wifi. | — | The run could not prove Packet Jack's network phase: at turn 9, switch the link to wifi. |

### chain-outage — Chain Outage

**Purpose:** Chainless Charlie: at turn 4 take people-rpc offline for 10 seconds. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Chain Outage must show event rtc.heal with {"rtc.healed":"false"} never seen, event rtc.peer with {"rtc.last\_stage":"offer"} never seen, metric rtc.signal\_problems is recorded, metric rtc.signal\_rtt\_ms every point &lt;= 30000, and page never shows "Voting has closed"; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **network1AtTurn:** 4
- **network1ForS:** 10
- **network1Outage:** "people-rpc"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Chainless Charlie is preparing Chain Outage on Pixel 6a on wifi. |
| verifying | Chainless Charlie finished the actions; the run is checking 5 evidence requirements. |
| passed | Chain Outage recorded every required observation. |
| failed | Chain Outage is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 4, Chainless Charlie will take people-rpc offline for 10 seconds. | Chainless Charlie's network phase has ended (take people-rpc offline for 10 seconds); recovery evidence is now being checked. | The run could not prove Chainless Charlie's network phase: at turn 4, take people-rpc offline for 10 seconds. |

### turn-issuer-outage — Turn Issuer Outage

**Purpose:** The PreviewNet harness: when the app opens take turn-issuer offline for 20 seconds. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Turn Issuer Outage must show event network.turn-receipt with {"turn.received":"false"} seen at least once, metric rtc.turn\_ttl\_left\_s is recorded, \[pending, not evaluated\] event turn-retry seen at least once, \[pending, not evaluated\] event turn-unavailable seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **network1AtOpen:** true
- **network1ForS:** 20
- **network1Outage:** "turn-issuer"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The PreviewNet harness is preparing Turn Issuer Outage on iPhone 14 on wifi. |
| verifying | The PreviewNet harness finished the actions; the run is checking 8 evidence requirements. |
| passed | Turn Issuer Outage recorded every required observation. |
| failed | Turn Issuer Outage is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### relay-outage — Relay Outage

**Purpose:** Relay Rita: force media through relay only, and at turn 4 take turn-relay offline for 10 seconds. Test setup: iPhone SE on wifi through relay-only media.

**Expected behavior:** Evidence for Relay Outage must show event rtc.path with {"rtc.path":"relay"} seen at least once, event rtc.heal with {"rtc.healed":"true"} seen at least once, event rtc.heal with {"rtc.healed":"false"} never seen, metric rtc.coverage\_pct every point &gt;= 50, page never shows "Voting has closed", page never shows "Restart the Polkadot app", and page never shows "Your Polkadot app is stuck, restart it"; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone SE"
- **network1AtTurn:** 4
- **network1ForS:** 10
- **network1Outage:** "turn-relay"
- **networkProfile:** "wifi"
- **relayOnly:** true
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Rita is preparing Relay Outage on iPhone SE on wifi through relay-only media. |
| verifying | Relay Rita finished the actions; the run is checking 7 evidence requirements. |
| passed | Relay Outage recorded every required observation. |
| failed | Relay Outage is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 4, Relay Rita will take turn-relay offline for 10 seconds. | Relay Rita's network phase has ended (take turn-relay offline for 10 seconds); recovery evidence is now being checked. | The run could not prove Relay Rita's network phase: at turn 4, take turn-relay offline for 10 seconds. |

### tap-storm-pixel7 — Tap Storm Pixel7

**Purpose:** Tap Tony: apply 3 opposing tap pairs per turn. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Tap Storm Pixel7 must show chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "tap-storm"
- **roleFlips:** 3

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Tap Tony is preparing Tap Storm Pixel7 on Pixel 7 on wifi. |
| verifying | Tap Tony finished the actions; the run is checking 5 evidence requirements. |
| passed | Tap Storm Pixel7 recorded every required observation. |
| failed | Tap Storm Pixel7 is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.storm-taps | Tap Tony: storm taps — apply 3 opposing tap pairs to one tile, then settle it approved. | — | The run could not prove Tap Tony's storm taps action. |

### clock-jumps — Clock Jumps

**Purpose:** Timewarp Tess: move the device clock to +30 seconds at turn 4, and move the device clock to -75 seconds at turn 8. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Clock Jumps must show metric rtc.signal\_rtt\_ms every point &lt;= 10000, metric rtc.turn\_ttl\_left\_s is recorded, \[pending, not evaluated\] event clock-stage seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clock1AtTurn:** 4
- **clock1OffsetS:** 30
- **clock2AtTurn:** 8
- **clock2OffsetS:** -75
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Timewarp Tess is preparing Clock Jumps on Pixel 7 on wifi. |
| verifying | Timewarp Tess finished the actions; the run is checking 7 evidence requirements. |
| passed | Clock Jumps recorded every required observation. |
| failed | Clock Jumps is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| clock.1 | Timewarp Tess moves the device clock to +30 seconds at turn 4. | — | The run could not prove Timewarp Tess's clock change at turn 4. |
| clock.2 | Timewarp Tess moves the device clock to -75 seconds at turn 8. | — | The run could not prove Timewarp Tess's clock change at turn 8. |

### host-crash — Host Crash

**Purpose:** Crash Carter: stop the signing host in round 2 for 1 seconds, then restart it. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Host Crash must show page never shows "Open Jollity in the Polkadot app", chain report matches the bot's vote trail, \[pending, not evaluated\] event host-lost seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "host-crash"
- **roleCrashInRound:** 2
- **roleDownS:** 1

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Crash Carter is preparing Host Crash on Pixel 7 on wifi. |
| verifying | Crash Carter finished the actions; the run is checking 7 evidence requirements. |
| passed | Host Crash recorded every required observation. |
| failed | Host Crash is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.host-killed | Crash Carter: host killed — stop the signing host in round 2. | — | The run could not prove Crash Carter's host killed action. |
| role.host-restarted | Crash Carter: host restarted — restart the signing host after 1 seconds. | Crash Carter completed host restarted; recovery evidence is now being checked. | The run could not prove Crash Carter's host restarted action. |

### host-crash-long — Host Crash Long

**Purpose:** Longhaul Lou: stop the signing host in round 2 for 8 seconds, then restart it. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Host Crash Long must show chain report matches the bot's vote trail, \[pending, not evaluated\] event host-lost seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "host-crash"
- **roleCrashInRound:** 2
- **roleDownS:** 8

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Longhaul Lou is preparing Host Crash Long on Pixel 7 on wifi. |
| verifying | Longhaul Lou finished the actions; the run is checking 6 evidence requirements. |
| passed | Host Crash Long recorded every required observation. |
| failed | Host Crash Long is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.host-killed | Longhaul Lou: host killed — stop the signing host in round 2. | — | The run could not prove Longhaul Lou's host killed action. |
| role.host-restarted | Longhaul Lou: host restarted — restart the signing host after 8 seconds. | Longhaul Lou completed host restarted; recovery evidence is now being checked. | The run could not prove Longhaul Lou's host restarted action. |

### clock-wrong-then-corrected — Clock Wrong Then Corrected

**Purpose:** Clockwork Clyde: start the device clock 5 seconds behind, and move the device clock to +0 seconds at turn 6. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Clock Wrong Then Corrected must show metric rtc.store\_calibration\_margin\_ms every point &lt;= 60000, the statement store never refuses a submit with alreadyExpired, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clock1AtTurn:** 6
- **clock1OffsetS:** 0
- **clockOffsetS:** -5
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Clockwork Clyde is preparing Clock Wrong Then Corrected on Pixel 7 on wifi. |
| verifying | Clockwork Clyde finished the actions; the run is checking 7 evidence requirements. |
| passed | Clock Wrong Then Corrected recorded every required observation. |
| failed | Clock Wrong Then Corrected is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| clock.1 | Clockwork Clyde moves the device clock to +0 seconds at turn 6. | — | The run could not prove Clockwork Clyde's clock change at turn 6. |

### clock-ahead-then-corrected — Clock Ahead Then Corrected

**Purpose:** Future Fran: start the device clock 5 seconds ahead, and move the device clock to +0 seconds at turn 6. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Clock Ahead Then Corrected must show metric rtc.store\_calibration\_margin\_ms every point &lt;= 60000, the statement store never refuses a submit with alreadyExpired, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clock1AtTurn:** 6
- **clock1OffsetS:** 0
- **clockOffsetS:** 5
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Future Fran is preparing Clock Ahead Then Corrected on iPhone 14 on wifi. |
| verifying | Future Fran finished the actions; the run is checking 7 evidence requirements. |
| passed | Clock Ahead Then Corrected recorded every required observation. |
| failed | Clock Ahead Then Corrected is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| clock.1 | Future Fran moves the device clock to +0 seconds at turn 6. | — | The run could not prove Future Fran's clock change at turn 6. |

### clock-step-while-hidden — Clock Step While Hidden

**Purpose:** Background Betty: hide at turn 5, step the clock by -60 seconds, and return at turn 7. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Clock Step While Hidden must show the statement store never refuses a submit with alreadyExpired, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "hidden-step"
- **roleHideAtTurn:** 5
- **roleShowAtTurn:** 7
- **roleStepS:** -60

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Background Betty is preparing Clock Step While Hidden on Pixel 6a on wifi. |
| verifying | Background Betty finished the actions; the run is checking 6 evidence requirements. |
| passed | Clock Step While Hidden recorded every required observation. |
| failed | Clock Step While Hidden is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.hidden | Background Betty: hidden — hide the app at turn 5. | — | The run could not prove Background Betty's hidden action. |
| role.clock-step | Background Betty: clock step — step the hidden device clock by -60 seconds. | — | The run could not prove Background Betty's clock step action. |
| role.visible | Background Betty: visible — show the app again at turn 7. | Background Betty completed visible; recovery evidence is now being checked. | The run could not prove Background Betty's visible action. |

### reload-mid-game — Reload Mid Game

**Purpose:** Reload Rex: reload the page at turn 11. Test setup: iPhone 13 on wifi.

**Expected behavior:** Evidence for Reload Mid Game must show the statement store never refuses a submit with channelPriorityTooLow, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 13"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "reload"
- **roleReloadAtTurn:** 11

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Reload Rex is preparing Reload Mid Game on iPhone 13 on wifi. |
| verifying | Reload Rex finished the actions; the run is checking 6 evidence requirements. |
| passed | Reload Mid Game recorded every required observation. |
| failed | Reload Mid Game is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.reloading | Reload Rex: reloading — start a page reload at turn 11. | — | The run could not prove Reload Rex's reloading action. |
| role.reloaded | Reload Rex: reloaded — complete the turn-11 reload. | Reload Rex completed reloaded; recovery evidence is now being checked. | The run could not prove Reload Rex's reloaded action. |

### visible-freeze — Visible Freeze

**Purpose:** Freeze-Frame Fred: freeze visible JavaScript at turn 9 for 20 seconds. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Visible Freeze must show chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "freeze"
- **roleFreezeAtTurn:** 9
- **roleFreezeS:** 20
- **roleMonotonicStops:** true

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Freeze-Frame Fred is preparing Visible Freeze on iPhone 14 on wifi. |
| verifying | Freeze-Frame Fred finished the actions; the run is checking 5 evidence requirements. |
| passed | Visible Freeze recorded every required observation. |
| failed | Visible Freeze is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.frozen | Freeze-Frame Fred: frozen — freeze visible JavaScript at turn 9. | — | The run could not prove Freeze-Frame Fred's frozen action. |
| role.thawed | Freeze-Frame Fred: thawed — resume JavaScript after 20 seconds. | Freeze-Frame Fred completed thawed; recovery evidence is now being checked. | The run could not prove Freeze-Frame Fred's thawed action. |

### udp-cut-40s — Udp Cut 40s

**Purpose:** Datagram Dana: at turn 4 cut UDP for 40 seconds while signaling stays reachable. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Udp Cut 40s must show devLog \[rtc\] line containing "self-heal" at least once, event rtc.heal with {"rtc.healed":"true"} seen at least once, event rtc.heal with {"rtc.healed":"false","rtc.heal\_end":"peer\_left"} never seen, devLog \[rtc\] line containing "view from" at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; appearances are allowed only inside the scripted fault window and recovery margin; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **network1AtTurn:** 4
- **network1UdpCutS:** 40
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Datagram Dana is preparing Udp Cut 40s on Pixel 7 on wifi. |
| verifying | Datagram Dana finished the actions; the run is checking 8 evidence requirements. |
| passed | Udp Cut 40s recorded every required observation. |
| failed | Udp Cut 40s is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 4, Datagram Dana will cut UDP for 40 seconds while signaling stays reachable. | Datagram Dana's network phase has ended (cut UDP for 40 seconds while signaling stays reachable); recovery evidence is now being checked. | The run could not prove Datagram Dana's network phase: at turn 4, cut UDP for 40 seconds while signaling stays reachable. |

### video-role-late-flip — Video Role Late Flip

**Purpose:** Flip Fiona: rejoin after turn 1, enable video at turn 4, then disable it at turn 10. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Video Role Late Flip must show chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "video-return"
- **roleDisableAtTurn:** 10
- **roleEnableAtTurn:** 4
- **roleJoinAfterTurn:** 1

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Flip Fiona is preparing Video Role Late Flip on Pixel 7 on wifi. |
| verifying | Flip Fiona finished the actions; the run is checking 5 evidence requirements. |
| passed | Video Role Late Flip recorded every required observation. |
| failed | Video Role Late Flip is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.left-app | Flip Fiona: left app — leave the app before handover. | — | The run could not prove Flip Fiona's left app action. |
| role.rejoined | Flip Fiona: rejoined — rejoin after turn 1. | Flip Fiona completed rejoined; recovery evidence is now being checked. | The run could not prove Flip Fiona's rejoined action. |
| role.video-suppressed | Flip Fiona: video suppressed — suppress outbound video before returning. | — | The run could not prove Flip Fiona's video suppressed action. |
| role.video-enabled | Flip Fiona: video enabled — enable outbound video at turn 4. | Flip Fiona completed video enabled; recovery evidence is now being checked. | The run could not prove Flip Fiona's video enabled action. |
| role.video-disabled | Flip Fiona: video disabled — disable outbound video at turn 10. | — | The run could not prove Flip Fiona's video disabled action. |

### video-role-late-never — Video Role Late Never

**Purpose:** NULL Nancy: rejoin after turn 1. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Video Role Late Never must show chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "video-return"
- **roleJoinAfterTurn:** 1

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | NULL Nancy is preparing Video Role Late Never on Pixel 7 on wifi. |
| verifying | NULL Nancy finished the actions; the run is checking 5 evidence requirements. |
| passed | Video Role Late Never recorded every required observation. |
| failed | Video Role Late Never is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.left-app | NULL Nancy: left app — leave the app before handover. | — | The run could not prove NULL Nancy's left app action. |
| role.rejoined | NULL Nancy: rejoined — rejoin after turn 1. | NULL Nancy completed rejoined; recovery evidence is now being checked. | The run could not prove NULL Nancy's rejoined action. |
| role.video-suppressed | NULL Nancy: video suppressed — suppress outbound video before returning. | — | The run could not prove NULL Nancy's video suppressed action. |

### video-stall-30s — Video Stall 30s

**Purpose:** Stutter Stu: at turn 4 stall RTP video for 30 seconds while ICE consent stays live. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Video Stall 30s must show devLog \[rtc\] line containing "media-stall:" or "media frozen:" at least once, devLog \[rtc\] line containing "media-stall:" or "media frozen:" &lt;= 15 times, devLog \[rtc\] line containing "view from" at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **network1AtTurn:** 4
- **network1VideoStallS:** 30
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Stutter Stu is preparing Video Stall 30s on Pixel 7 on wifi. |
| verifying | Stutter Stu finished the actions; the run is checking 7 evidence requirements. |
| passed | Video Stall 30s recorded every required observation. |
| failed | Video Stall 30s is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 4, Stutter Stu will stall RTP video for 30 seconds while ICE consent stays live. | Stutter Stu's network phase has ended (stall RTP video for 30 seconds while ICE consent stays live); recovery evidence is now being checked. | The run could not prove Stutter Stu's network phase: at turn 4, stall RTP video for 30 seconds while ICE consent stays live. |

### host-chain-lost — Host Chain Lost

**Purpose:** Chaincut Chip: at sign-up drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window, and when confirmation opens drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Host Chain Lost must show page never shows "You missed this one", metric signup.landed\_ms is recorded, \[pending, not evaluated\] metric signup.window\_check\_timeout every point &lt;= 0, \[pending, not evaluated\] metric chain.restart\_card\_shown is recorded, \[pending, not evaluated\] devLog \[chain\] line containing "restart card shown" at least once, event report.landed seen at least once, \[pending, not evaluated\] metric report.retries is recorded, \[pending, not evaluated\] event join with {"turn.stage":"proof-chain"} seen at least once, and page never shows "Voting has closed"; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **network1AtSignUp:** true
- **network1HostChainCutS:** 60
- **network1HostChainHoldS:** 45
- **network2AtConfirm:** true
- **network2HostChainCutS:** 60
- **network2HostChainHoldS:** 45
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Chaincut Chip is preparing Host Chain Lost on Pixel 7 on wifi. |
| verifying | Chaincut Chip finished the actions; the run is checking 9 evidence requirements. |
| passed | Host Chain Lost recorded every required observation. |
| failed | Host Chain Lost is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at sign-up, Chaincut Chip will drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window. | Chaincut Chip's network phase has ended (drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window); recovery evidence is now being checked. | The run could not prove Chaincut Chip's network phase: at sign-up, drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window. |
| network.2 | when confirmation opens, Chaincut Chip will drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window. | Chaincut Chip's network phase has ended (drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window); recovery evidence is now being checked. | The run could not prove Chaincut Chip's network phase: when confirmation opens, drop the signing host's People RPC sockets and refuse new connections for 45 seconds, then observe reconnection through the rest of the 60-second window. |

### host-stuck-waiting — Host Stuck Waiting

**Purpose:** Relay Ray: 300 seconds before the game starts silently hang the host chain path for 120 seconds. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Host Stuck Waiting must show page shows "Restart the Polkadot app", metric chain.restart\_card\_shown is recorded, metric chain.restart\_card\_next\_probe is recorded, devLog \[chain\] line containing "restart card's next probe succeeded" at least once, event report.landed seen at least once, chain report matches the bot's vote trail, metric failure with {"failure.kind":"unclean-exit"} every point &lt;= 0, metric app.previous\_end with {"previous.end":"host-reload","previous.in\_game":"false"} is recorded, and page never shows "Voting has closed"; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **network1AtBeforeGameS:** 300
- **network1HostChainHangS:** 120
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Ray is preparing Host Stuck Waiting on Pixel 7 on wifi. |
| verifying | Relay Ray finished the actions; the run is checking 9 evidence requirements. |
| passed | Host Stuck Waiting recorded every required observation. |
| failed | Host Stuck Waiting is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | 300 seconds before the game starts, Relay Ray will silently hang the host chain path for 120 seconds. | Relay Ray's network phase has ended (silently hang the host chain path for 120 seconds); recovery evidence is now being checked. | The run could not prove Relay Ray's network phase: 300 seconds before the game starts, silently hang the host chain path for 120 seconds. |

### host-stuck-in-game — Host Stuck In Game

**Purpose:** Handoff Hank: at turn 4 silently hang the host chain path for 110 seconds. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Host Stuck In Game must show page shows "Your Polkadot app is stuck, restart it", devLog \[chain\] line containing "host stuck during game" at least once, devLog \[chain\] line containing "host answering during game after stuck transition" at least once, event report.landed seen at least once, chain report matches the bot's vote trail, and page never shows "Voting has closed"; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **network1AtTurn:** 4
- **network1HostChainHangS:** 110
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Handoff Hank is preparing Host Stuck In Game on Pixel 7 on wifi. |
| verifying | Handoff Hank finished the actions; the run is checking 6 evidence requirements. |
| passed | Host Stuck In Game recorded every required observation. |
| failed | Host Stuck In Game is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 4, Handoff Hank will silently hang the host chain path for 110 seconds. | Handoff Hank's network phase has ended (silently hang the host chain path for 110 seconds); recovery evidence is now being checked. | The run could not prove Handoff Hank's network phase: at turn 4, silently hang the host chain path for 110 seconds. |

### reload-clean-close — Reload Clean Close

**Purpose:** Reload Rex: reload the page at turn 2. Test setup: iPhone 13 on wifi.

**Expected behavior:** Evidence for Reload Clean Close must show metric app.previous\_end with {"previous.end":"clean-close"} is recorded, metric failure with {"failure.kind":"unclean-exit"} every point &lt;= 0, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 13"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "reload"
- **roleReloadAtTurn:** 2

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Reload Rex is preparing Reload Clean Close on iPhone 13 on wifi. |
| verifying | Reload Rex finished the actions; the run is checking 7 evidence requirements. |
| passed | Reload Clean Close recorded every required observation. |
| failed | Reload Clean Close is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.reloading | Reload Rex: reloading — start a page reload at turn 2. | — | The run could not prove Reload Rex's reloading action. |
| role.reloaded | Reload Rex: reloaded — complete the turn-2 reload. | Reload Rex completed reloaded; recovery evidence is now being checked. | The run could not prove Reload Rex's reloaded action. |

### reload-video-back — Reload Video Back

**Purpose:** Reload Rex: reload the page at turn 2. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Reload Video Back must show after the reload, every co-player seen before it (and not gone) sends video again within 45000 ms of the new page booting, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "reload"
- **roleReloadAtTurn:** 2

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Reload Rex is preparing Reload Video Back on iPhone 14 on wifi. |
| verifying | Reload Rex finished the actions; the run is checking 6 evidence requirements. |
| passed | Reload Video Back recorded every required observation. |
| failed | Reload Video Back is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.reloading | Reload Rex: reloading — start a page reload at turn 2. | — | The run could not prove Reload Rex's reloading action. |
| role.reloaded | Reload Rex: reloaded — complete the turn-2 reload. | Reload Rex completed reloaded; recovery evidence is now being checked. | The run could not prove Reload Rex's reloaded action. |

### turn-cache-relaunch — Turn Cache Relaunch

**Purpose:** The Rejoiner: force media through relay only, and kill the app in round 1 and relaunch it. Test setup: iPhone 13 on wifi through relay-only media.

**Expected behavior:** Evidence for Turn Cache Relaunch must show event network.turn-receipt with {"turn.received":"cached","turn.source":"cache-hit"} seen at least once, event network.turn-receipt with {"turn.received":"true"} never seen, event rtc.path with {"rtc.path":"relay"} seen at least once, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 13"
- **networkProfile:** "wifi"
- **relayOnly:** true
- **role:** "kill-relaunch"
- **roleKillInRound:** 1

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The Rejoiner is preparing Turn Cache Relaunch on iPhone 13 on wifi through relay-only media. |
| verifying | The Rejoiner finished the actions; the run is checking 8 evidence requirements. |
| passed | Turn Cache Relaunch recorded every required observation. |
| failed | Turn Cache Relaunch is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.killed | The Rejoiner: killed — kill the app in round 1. | — | The run could not prove The Rejoiner's killed action. |
| role.relaunched | The Rejoiner: relaunched — relaunch the app on the same host slot. | The Rejoiner completed relaunched; recovery evidence is now being checked. | The run could not prove The Rejoiner's relaunched action. |

### host-restart-classified — Host Restart Classified

**Purpose:** Crash Carter: stop the signing host in round 1 for 1 seconds, then restart it. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Host Restart Classified must show metric app.previous\_end with {"previous.end":"host-reload","previous.in\_game":"true"} is recorded, metric failure with {"failure.kind":"unclean-exit","failure.reason":"host-reload"} is recorded, chain report matches the bot's vote trail, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "host-crash"
- **roleCrashInRound:** 1
- **roleDownS:** 1

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Crash Carter is preparing Host Restart Classified on Pixel 7 on wifi. |
| verifying | Crash Carter finished the actions; the run is checking 7 evidence requirements. |
| passed | Host Restart Classified recorded every required observation. |
| failed | Host Restart Classified is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.host-killed | Crash Carter: host killed — stop the signing host in round 1. | — | The run could not prove Crash Carter's host killed action. |
| role.host-restarted | Crash Carter: host restarted — restart the signing host after 1 seconds. | Crash Carter completed host restarted; recovery evidence is now being checked. | The run could not prove Crash Carter's host restarted action. |

### turn-warm-returning — Turn Warm Returning

**Purpose:** Relay Ray: force media through relay only, and 90 seconds before the game starts take turn-issuer offline for 120 seconds. Test setup: iPhone SE on wifi through relay-only media.

**Expected behavior:** Evidence for Turn Warm Returning must show event network.turn-receipt with {"turn.received":"true","turn.source":"warmup"} seen at least once, event network.turn-receipt with {"turn.received":"cached","turn.source":"cache-hit"} seen &gt;= 2 times, event rtc.path with {"rtc.path":"relay"} seen at least once, event report.landed seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone SE"
- **network1AtBeforeGameS:** 90
- **network1ForS:** 120
- **network1Outage:** "turn-issuer"
- **networkProfile:** "wifi"
- **relayOnly:** true
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Ray is preparing Turn Warm Returning on iPhone SE on wifi through relay-only media. |
| verifying | Relay Ray finished the actions; the run is checking 8 evidence requirements. |
| passed | Turn Warm Returning recorded every required observation. |
| failed | Turn Warm Returning is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | 90 seconds before the game starts, Relay Ray will take turn-issuer offline for 120 seconds. | Relay Ray's network phase has ended (take turn-issuer offline for 120 seconds); recovery evidence is now being checked. | The run could not prove Relay Ray's network phase: 90 seconds before the game starts, take turn-issuer offline for 120 seconds. |

### network-blocked — Network Blocked

**Purpose:** Handoff Hank: force media through relay only, 300 seconds before the game starts take turn-relay offline for 298 seconds, and run the disruption concurrently with the triggering game action, and 2 seconds before the game starts switch the link to lte-good, and restore direct UDP. Test setup: Pixel 6a on wifi through relay-only media.

**Expected behavior:** Evidence for Network Blocked must show page shows then clears one of "You can’t reach the other players" or "Switch to mobile data to join", page never shows "Restart the Polkadot app", event network.waiting-check with {"waiting\_check.result":"blocked","waiting\_check.trigger":"network-change"} seen at least once, event network.turn-receipt with {"turn.received":"cached","turn.source":"cache-hit"} seen &gt;= 2 times, event rtc.path with {"rtc.path":"relay"} seen at least once, event report.landed seen at least once, page never shows "Voting has closed", and page never shows "Your Polkadot app is stuck, restart it"; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **network1AtBeforeGameS:** 300
- **network1Concurrent:** true
- **network1ForS:** 298
- **network1Outage:** "turn-relay"
- **network2AllowUdp:** true
- **network2AtBeforeGameS:** 2
- **network2Profile:** "lte-good"
- **networkProfile:** "wifi"
- **relayOnly:** true
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Handoff Hank is preparing Network Blocked on Pixel 6a on wifi through relay-only media. |
| verifying | Handoff Hank finished the actions; the run is checking 8 evidence requirements. |
| passed | Network Blocked recorded every required observation. |
| failed | Network Blocked is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | 300 seconds before the game starts, Handoff Hank will take turn-relay offline for 298 seconds, and run the disruption concurrently with the triggering game action. | Handoff Hank's network phase has ended (take turn-relay offline for 298 seconds, and run the disruption concurrently with the triggering game action); recovery evidence is now being checked. | The run could not prove Handoff Hank's network phase: 300 seconds before the game starts, take turn-relay offline for 298 seconds, and run the disruption concurrently with the triggering game action. |
| network.2 | 2 seconds before the game starts, Handoff Hank will switch the link to lte-good, and restore direct UDP. | — | The run could not prove Handoff Hank's network phase: 2 seconds before the game starts, switch the link to lte-good, and restore direct UDP. |

### late-join-turn-5 — Late Join Turn 5

**Purpose:** Fifth-Turn Felix: hold the link on lte-good, and leave the app and rejoin after turn 5. Test setup: Galaxy A55 on lte-good.

**Expected behavior:** Evidence for Late Join Turn 5 must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Galaxy A55"
- **networkProfile:** "lte-good"
- **relayOnly:** false
- **role:** "late-join"
- **roleJoinAfterTurn:** 5

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Fifth-Turn Felix is preparing Late Join Turn 5 on Galaxy A55 on lte-good. |
| verifying | Fifth-Turn Felix finished the actions; the run is checking 4 evidence requirements. |
| passed | Late Join Turn 5 recorded every required observation. |
| failed | Late Join Turn 5 is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.left-app | Fifth-Turn Felix: left app — leave the app before handover. | — | The run could not prove Fifth-Turn Felix's left app action. |
| role.rejoined | Fifth-Turn Felix: rejoined — rejoin after turn 5. | Fifth-Turn Felix completed rejoined; recovery evidence is now being checked. | The run could not prove Fifth-Turn Felix's rejoined action. |

### issue874-fast-late-join — Issue874 Fast Late Join

**Purpose:** Fifth-Turn Felix: hold the link on lte-good, and leave the app and rejoin after turn 6. Test setup: Galaxy A55 on lte-good.

**Expected behavior:** Evidence for Issue874 Fast Late Join must show cold late join opens only round 1, receives co-player video within 8000 ms, and never taps or seals before clock ready, event report.landed seen at least once, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Galaxy A55"
- **networkProfile:** "lte-good"
- **relayOnly:** false
- **role:** "late-join"
- **roleJoinAfterTurn:** 6

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Fifth-Turn Felix is preparing Issue874 Fast Late Join on Galaxy A55 on lte-good. |
| verifying | Fifth-Turn Felix finished the actions; the run is checking 6 evidence requirements. |
| passed | Issue874 Fast Late Join recorded every required observation. |
| failed | Issue874 Fast Late Join is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.left-app | Fifth-Turn Felix: left app — leave the app before handover. | — | The run could not prove Fifth-Turn Felix's left app action. |
| role.rejoined | Fifth-Turn Felix: rejoined — rejoin after turn 6. | Fifth-Turn Felix completed rejoined; recovery evidence is now being checked. | The run could not prove Fifth-Turn Felix's rejoined action. |

### game259-lossy-video — Lossy Video

**Purpose:** Lady Latency: during the run switch the link to game259-negotiation-burst. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Lossy Video must show devLog \[rtc\] line containing "\[jollity-rtc\] media-stall: no-video-rebuild" with fields {"peer":"5Fnj4wBcoiBfHCcjtKZXcVC2fyiK4SGqDs3YSip3pZzKCbMJ"} never, devLog \[rtc\] line containing "\[jollity-rtc\] media-stall: no-video-rebuild" with fields {"peer":"5EWNTaqLH4f2qHWWxe5eGwrzX1p9HVn18x31NQB918zYJzEc"} never, devLog \[rtc\] line containing "\[jollity-rtc\] media-stall: no-video-rebuild" with fields {"peer":"5Fn17Vt9fjBjWMqqnUMymk3GXbZm4AyhnGKSvosJQXjCEaBZ"} never, devLog \[rtc\] line containing "\[jollity-rtc\] media-stall: no-video-rebuild" with fields {"peer":"5H5qqwSiaWcoEtPnkr76JZ87hgg4qMwZn2FLfsC6Rg3GzJKn"} never, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **network1AtRoundChannelsOpenByGameS:** 105
- **network1AtRoundChannelsOpenCount:** 5
- **network1AtRoundChannelsOpenRound:** 2
- **network1ForS:** 15
- **network1Profile:** "game259-negotiation-burst"
- **network1RestoreProfile:** "game259-lossy"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Lady Latency is preparing Lossy Video on Pixel 7 on wifi. |
| verifying | Lady Latency finished the actions; the run is checking 8 evidence requirements. |
| passed | Lossy Video recorded every required observation. |
| failed | Lossy Video is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | during the run, Lady Latency will switch the link to game259-negotiation-burst. | — | The run could not prove Lady Latency's network phase: during the run, switch the link to game259-negotiation-burst. |

### game259-dropped-lane-rebuild — Dropped Lane Rebuild

**Purpose:** Relay Ray uses iPhone SE on wifi to play an ordinary game without an injected disruption.

**Expected behavior:** Evidence for Dropped Lane Rebuild must show devLog \[rtc\] line containing "\[e2e-data-channel-fault\] dropped renegotiation offer" with fields {"fault":"offer-1"} &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "\[jollity-rtc\] round-link" with fields {"stage":"channel-open","round":"1"} with peer present &gt;= 5 and &lt;= 5 times, devLog \[rtc\] line containing "\[jollity-rtc\] round-link" with fields {"stage":"first-video","round":"1"} with peer present &gt;= 5 and &lt;= 5 times, devLog \[rtc\] line containing "\[jollity-rtc\] round-link" with fields {"stage":"first-video","round":"1","fault":"offer-1"} with peer present &gt;= 1 and &lt;= 1 times, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone SE"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Ray is preparing Dropped Lane Rebuild on iPhone SE on wifi. |
| verifying | Relay Ray finished the actions; the run is checking 8 evidence requirements. |
| passed | Dropped Lane Rebuild recorded every required observation. |
| failed | Dropped Lane Rebuild is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### game259-clean-video-control — Clean Video Control

**Purpose:** Captain Baseline uses iPhone 14 on wifi to play an ordinary game without an injected disruption.

**Expected behavior:** Evidence for Clean Video Control must show devLog \[rtc\] line containing "\[jollity-rtc\] round-link" with fields {"stage":"first-video","round":"1","peer":"5EWNTaqLH4f2qHWWxe5eGwrzX1p9HVn18x31NQB918zYJzEc"} &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "\[jollity-rtc\] round-link" with fields {"stage":"first-video","round":"1","peer":"5Fn17Vt9fjBjWMqqnUMymk3GXbZm4AyhnGKSvosJQXjCEaBZ"} &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "\[jollity-rtc\] round-link" with fields {"stage":"first-video","round":"1","peer":"5H5qqwSiaWcoEtPnkr76JZ87hgg4qMwZn2FLfsC6Rg3GzJKn"} &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "\[jollity-rtc\] media-stall: no-video-rebuild" with fields {"peer":"5EWNTaqLH4f2qHWWxe5eGwrzX1p9HVn18x31NQB918zYJzEc"} never, devLog \[rtc\] line containing "\[jollity-rtc\] media-stall: no-video-rebuild" with fields {"peer":"5Fn17Vt9fjBjWMqqnUMymk3GXbZm4AyhnGKSvosJQXjCEaBZ"} never, devLog \[rtc\] line containing "\[jollity-rtc\] media-stall: no-video-rebuild" with fields {"peer":"5H5qqwSiaWcoEtPnkr76JZ87hgg4qMwZn2FLfsC6Rg3GzJKn"} never, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Captain Baseline is preparing Clean Video Control on iPhone 14 on wifi. |
| verifying | Captain Baseline finished the actions; the run is checking 10 evidence requirements. |
| passed | Clean Video Control recorded every required observation. |
| failed | Clean Video Control is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### glare-forcer — Glare Forcer

**Purpose:** Relay Rita: force simultaneous local and remote offers on the polite side after sendrecv video is negotiated, and at turn 4 stall RTP video for 30 seconds while ICE consent stays live. Test setup: iPhone SE on wifi.

**Expected behavior:** Evidence for Glare Forcer must show devLog \[rtc\] line containing "\[e2e-peer-fault\] glare-forcer fired" &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "glare on lane with video negotiated: rebuild instead of rolling back" &gt;= 1 times, devLog \[rtc\] line containing "\[e2e-peer-fault\] glare-forcer recovered" with peer present and frames present &gt;= 1 and &lt;= 1 times, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone SE"
- **network1AtTurn:** 4
- **network1VideoStallS:** 30
- **networkProfile:** "wifi"
- **peerFault:** "glare-forcer"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Rita is preparing Glare Forcer on iPhone SE on wifi. |
| verifying | Relay Rita finished the actions; the run is checking 7 evidence requirements. |
| passed | Glare Forcer recorded every required observation. |
| failed | Glare Forcer is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 4, Relay Rita will stall RTP video for 30 seconds while ICE consent stays live. | Relay Rita's network phase has ended (stall RTP video for 30 seconds while ICE consent stays live); recovery evidence is now being checked. | The run could not prove Relay Rita's network phase: at turn 4, stall RTP video for 30 seconds while ICE consent stays live. |

### late-signal — Late Signal

**Purpose:** Datagram Dana: deliver an older inbound statement-store page after its newer replacement. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Late Signal must show \[pending, not evaluated\] devLog \[rtc\] line containing "\[jollity-rtc\] e2e-late-signal stage=complete" with fields {"replacements":"2"} with peer present &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "\[e2e-peer-fault\] late-signal fired" with peer present and link present &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "\[e2e-peer-fault\] late-signal recovered" with peer present and frames present &gt;= 1 and &lt;= 1 times, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **peerFault:** "late-signal"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Datagram Dana is preparing Late Signal on Pixel 7 on wifi. |
| verifying | Datagram Dana finished the actions; the run is checking 7 evidence requirements. |
| passed | Late Signal recorded every required observation. |
| failed | Late Signal is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### one-way-video — One Way Video

**Purpose:** NULL Nancy: suppress only this bot's outbound video. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for One Way Video must show devLog \[rtc\] line containing "\[e2e-peer-fault\] one-way-video fired" with initiator-peer present &gt;= 1 times, devLog \[rtc\] line containing "unseen: signalingState=" &gt;= 1 times, devLog \[rtc\] line containing "\[e2e-peer-fault\] one-way-video recovered" with peer present and frames present &gt;= 1 times, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **peerFault:** "one-way-video"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | NULL Nancy is preparing One Way Video on Pixel 7 on wifi. |
| verifying | NULL Nancy finished the actions; the run is checking 7 evidence requirements. |
| passed | One Way Video recorded every required observation. |
| failed | One Way Video is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### dropped-answer — Dropped Answer

**Purpose:** Stutter Stu: drop one lane answer after the same peer link is rebuilt. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Dropped Answer must show devLog \[rtc\] line containing "\[e2e-peer-fault\] dropped-answer fired" &gt;= 1 and &lt;= 1 times, devLog \[rtc\] line containing "\[e2e-peer-fault\] dropped-answer recovered" &gt;= 1 and &lt;= 1 times, page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **peerFault:** "dropped-answer"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Stutter Stu is preparing Dropped Answer on Pixel 7 on wifi. |
| verifying | Stutter Stu finished the actions; the run is checking 6 evidence requirements. |
| passed | Dropped Answer recorded every required observation. |
| failed | Dropped Answer is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.

### telemetry-t1-baseline — Telemetry T1 Baseline

**Purpose:** Captain Baseline: run telemetry case T1 to keep a healthy telemetry baseline. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Telemetry T1 Baseline must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryFault:** "none"
- **telemetryId:** "T1"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Captain Baseline is preparing Telemetry T1 Baseline on Pixel 6a on wifi. |
| verifying | Captain Baseline finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T1 Baseline recorded every required observation. |
| failed | Telemetry T1 Baseline is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| telemetry.T1 | Captain Baseline activates T1: keep a healthy telemetry baseline. | — | The run could not prove telemetry case T1: keep a healthy telemetry baseline. |

### telemetry-t2-host-storage-hang — Telemetry T2 Host Storage Hang

**Purpose:** Lady Latency: run telemetry case T2 to hang the host storage call for 120 seconds while the local outbox continues independently. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Telemetry T2 Host Storage Hang must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryDurationS:** 120
- **telemetryFault:** "host-storage-hang"
- **telemetryId:** "T2"
- **telemetryPageLoads:** \[0\]

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Lady Latency is preparing Telemetry T2 Host Storage Hang on Pixel 6a on wifi. |
| verifying | Lady Latency finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T2 Host Storage Hang recorded every required observation. |
| failed | Telemetry T2 Host Storage Hang is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| telemetry.T2 | Lady Latency activates T2: hang the host storage call for 120 seconds while the local outbox continues independently. | — | The run could not prove telemetry case T2: hang the host storage call for 120 seconds while the local outbox continues independently. |

### telemetry-t3-ios-fetch-gate — Telemetry T3 Ios Fetch Gate

**Purpose:** Relay Ray: run telemetry case T3 to hold the emulated iOS Sentry fetch for 180 seconds, then release it. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Telemetry T3 Ios Fetch Gate must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryActivateAtTurn:** 1
- **telemetryDurationS:** 180
- **telemetryFault:** "ios-fetch-gate"
- **telemetryId:** "T3"
- **telemetryPageLoads:** \[0\]

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Ray is preparing Telemetry T3 Ios Fetch Gate on iPhone 14 on wifi. |
| verifying | Relay Ray finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T3 Ios Fetch Gate recorded every required observation. |
| failed | Telemetry T3 Ios Fetch Gate is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| telemetry.T3 | Relay Ray activates T3: hold the emulated iOS Sentry fetch for 180 seconds, then release it. | — | The run could not prove telemetry case T3: hold the emulated iOS Sentry fetch for 180 seconds, then release it. |

### telemetry-t4-kill-while-stuck — Telemetry T4 Kill While Stuck

**Purpose:** Handoff Hank: kill the app in round 1 and relaunch it, and run telemetry case T4 to hang host storage and Sentry fetch, kill the first document while stuck, then reopen healthy. Test setup: iPhone 13 on wifi.

**Expected behavior:** Evidence for Telemetry T4 Kill While Stuck must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 13"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "kill-relaunch"
- **roleKillInRound:** 1
- **telemetryActivateAtTurn:** 1
- **telemetryFault:** "host-storage-hang"
- **telemetryFetchGatePageLoads:** \[0\]
- **telemetryFetchGateS:** 3600
- **telemetryId:** "T4"
- **telemetryPageLoads:** \[0\]

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Handoff Hank is preparing Telemetry T4 Kill While Stuck on iPhone 13 on wifi. |
| verifying | Handoff Hank finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T4 Kill While Stuck recorded every required observation. |
| failed | Telemetry T4 Kill While Stuck is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.killed | Handoff Hank: killed — kill the app in round 1. | — | The run could not prove Handoff Hank's killed action. |
| role.relaunched | Handoff Hank: relaunched — relaunch the app on the same host slot. | Handoff Hank completed relaunched; recovery evidence is now being checked. | The run could not prove Handoff Hank's relaunched action. |
| telemetry.T4 | Handoff Hank activates T4: hang host storage and Sentry fetch, kill the first document while stuck, then reopen healthy. | — | The run could not prove telemetry case T4: hang host storage and Sentry fetch, kill the first document while stuck, then reopen healthy. |

### telemetry-t5-stuck-first-reopen — Telemetry T5 Stuck First Reopen

**Purpose:** The Rejoiner: kill the app in round 1 and relaunch it, and run telemetry case T5 to keep the initial and first reopened documents stuck, then prove the second reopen is healthy. Test setup: iPhone 13 on wifi.

**Expected behavior:** Evidence for Telemetry T5 Stuck First Reopen must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 13"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "kill-relaunch"
- **roleKillInRound:** 1
- **telemetryActivateAtTurn:** 1
- **telemetryFault:** "host-storage-hang"
- **telemetryFetchGatePageLoads:** \[0,1\]
- **telemetryFetchGateS:** 3600
- **telemetryId:** "T5"
- **telemetryPageLoads:** \[0,1\]

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The Rejoiner is preparing Telemetry T5 Stuck First Reopen on iPhone 13 on wifi. |
| verifying | The Rejoiner finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T5 Stuck First Reopen recorded every required observation. |
| failed | Telemetry T5 Stuck First Reopen is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.killed | The Rejoiner: killed — kill the app in round 1. | — | The run could not prove The Rejoiner's killed action. |
| role.relaunched | The Rejoiner: relaunched — relaunch the app on the same host slot. | The Rejoiner completed relaunched; recovery evidence is now being checked. | The run could not prove The Rejoiner's relaunched action. |
| telemetry.T5 | The Rejoiner activates T5: keep the initial and first reopened documents stuck, then prove the second reopen is healthy. | — | The run could not prove telemetry case T5: keep the initial and first reopened documents stuck, then prove the second reopen is healthy. |

### telemetry-t6-freeze-after-report — Telemetry T6 Freeze After Report

**Purpose:** Late Larry: run telemetry case T6 to freeze visible JavaScript after the report for 30 seconds, kill it, then drain telemetry on the next open. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Telemetry T6 Freeze After Report must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryFault:** "none"
- **telemetryFreezeAfterReportS:** 30
- **telemetryId:** "T6"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Late Larry is preparing Telemetry T6 Freeze After Report on Pixel 6a on wifi. |
| verifying | Late Larry finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T6 Freeze After Report recorded every required observation. |
| failed | Telemetry T6 Freeze After Report is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| telemetry.T6 | Late Larry activates T6: freeze visible JavaScript after the report for 30 seconds, kill it, then drain telemetry on the next open. | — | The run could not prove telemetry case T6: freeze visible JavaScript after the report for 30 seconds, kill it, then drain telemetry on the next open. |

### telemetry-t7-sentry-block — Telemetry T7 Sentry Block

**Purpose:** Captain Baseline: run telemetry case T7 to block Sentry ingest for 300 seconds, then prove recovery. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Telemetry T7 Sentry Block must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryActivateAtTurn:** 1
- **telemetryDurationS:** 300
- **telemetryFault:** "sentry-block"
- **telemetryId:** "T7"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Captain Baseline is preparing Telemetry T7 Sentry Block on Pixel 6a on wifi. |
| verifying | Captain Baseline finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T7 Sentry Block recorded every required observation. |
| failed | Telemetry T7 Sentry Block is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| telemetry.T7 | Captain Baseline activates T7: block Sentry ingest for 300 seconds, then prove recovery. | — | The run could not prove telemetry case T7: block Sentry ingest for 300 seconds, then prove recovery. |

### telemetry-t8-sentry-429 — Telemetry T8 Sentry 429

**Purpose:** Lady Latency: run telemetry case T8 to return sentry-429 responses for 120 seconds with a 120-second Retry-After, then prove the retry obeys it. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Telemetry T8 Sentry 429 must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryActivateAtTurn:** 1
- **telemetryDurationS:** 120
- **telemetryFault:** "sentry-429"
- **telemetryId:** "T8"
- **telemetryRetryAfterS:** 120

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Lady Latency is preparing Telemetry T8 Sentry 429 on Pixel 6a on wifi. |
| verifying | Lady Latency finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T8 Sentry 429 recorded every required observation. |
| failed | Telemetry T8 Sentry 429 is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| telemetry.T8 | Lady Latency activates T8: return sentry-429 responses for 120 seconds with a 120-second Retry-After, then prove the retry obeys it. | — | The run could not prove telemetry case T8: return sentry-429 responses for 120 seconds with a 120-second Retry-After, then prove the retry obeys it. |

### telemetry-t9-blackout — Telemetry T9 Blackout

**Purpose:** Relay Ray: at turn 2 drop the whole link for 120 seconds, and run telemetry case T9 to prove telemetry isolation and recovery across the whole-link blackout. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Telemetry T9 Blackout must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page shows "We couldn't connect you to anyone." inside the bounded blackout and recovery is observed; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **network1AtTurn:** 2
- **network1BlackoutS:** 120
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryFault:** "none"
- **telemetryId:** "T9"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Relay Ray is preparing Telemetry T9 Blackout on Pixel 6a on wifi. |
| verifying | Relay Ray finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T9 Blackout recorded every required observation. |
| failed | Telemetry T9 Blackout is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| network.1 | at turn 2, Relay Ray will drop the whole link for 120 seconds. | Relay Ray's network phase has ended (drop the whole link for 120 seconds); recovery evidence is now being checked. | The run could not prove Relay Ray's network phase: at turn 2, drop the whole link for 120 seconds. |
| telemetry.T9 | Relay Ray activates T9: prove telemetry isolation and recovery across the whole-link blackout. | — | The run could not prove telemetry case T9: prove telemetry isolation and recovery across the whole-link blackout. |

### telemetry-t10-big-log — Telemetry T10 Big Log

**Purpose:** Handoff Hank: apply 20 opposing tap pairs per turn, and run telemetry case T10 to produce a large game log and prove more than 48 KiB of rolling-chunk durability. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Telemetry T10 Big Log must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "tap-storm"
- **roleFlips:** 20
- **telemetryFault:** "none"
- **telemetryId:** "T10"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Handoff Hank is preparing Telemetry T10 Big Log on Pixel 7 on wifi. |
| verifying | Handoff Hank finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T10 Big Log recorded every required observation. |
| failed | Telemetry T10 Big Log is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.storm-taps | Handoff Hank: storm taps — apply 20 opposing tap pairs to one tile, then settle it approved. | — | The run could not prove Handoff Hank's storm taps action. |
| telemetry.T10 | Handoff Hank activates T10: produce a large game log and prove more than 48 KiB of rolling-chunk durability. | — | The run could not prove telemetry case T10: produce a large game log and prove more than 48 KiB of rolling-chunk durability. |

### telemetry-t11-no-localstorage — Telemetry T11 No Localstorage

**Purpose:** The Rejoiner: run telemetry case T11 to make the localStorage getter throw SecurityError and prove telemetry still survives. Test setup: iPhone 14 on wifi.

**Expected behavior:** Evidence for Telemetry T11 No Localstorage must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "iPhone 14"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"
- **telemetryFault:** "no-localstorage"
- **telemetryId:** "T11"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | The Rejoiner is preparing Telemetry T11 No Localstorage on iPhone 14 on wifi. |
| verifying | The Rejoiner finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T11 No Localstorage recorded every required observation. |
| failed | Telemetry T11 No Localstorage is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| telemetry.T11 | The Rejoiner activates T11: make the localStorage getter throw SecurityError and prove telemetry still survives. | — | The run could not prove telemetry case T11: make the localStorage getter throw SecurityError and prove telemetry still survives. |

### telemetry-t12-reload-dedupe — Telemetry T12 Reload Dedupe

**Purpose:** Late Larry: reload the page at turn 2, and run telemetry case T12 to reload while telemetry is queued and prove outbox persistence plus stable-chunk Sentry deduplication. Test setup: Pixel 6a on wifi.

**Expected behavior:** Evidence for Telemetry T12 Reload Dedupe must show page never shows "Voting has closed", page never shows "Restart the Polkadot app", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraResolution:** "360p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 6a"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "reload"
- **roleReloadAtTurn:** 2
- **telemetryFault:** "none"
- **telemetryId:** "T12"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Late Larry is preparing Telemetry T12 Reload Dedupe on Pixel 6a on wifi. |
| verifying | Late Larry finished the actions; the run is checking 4 evidence requirements. |
| passed | Telemetry T12 Reload Dedupe recorded every required observation. |
| failed | Telemetry T12 Reload Dedupe is missing or contradicted by required evidence. |

#### Action narration

| Action | Active | Recovered | Failed |
| --- | --- | --- | --- |
| role.reloading | Late Larry: reloading — start a page reload at turn 2. | — | The run could not prove Late Larry's reloading action. |
| role.reloaded | Late Larry: reloaded — complete the turn-2 reload. | Late Larry completed reloaded; recovery evidence is now being checked. | The run could not prove Late Larry's reloaded action. |
| telemetry.T12 | Late Larry activates T12: reload while telemetry is queued and prove outbox persistence plus stable-chunk Sentry deduplication. | — | The run could not prove telemetry case T12: reload while telemetry is queued and prove outbox persistence plus stable-chunk Sentry deduplication. |

### camera-mute-loop — Camera Mute Loop

**Purpose:** Shutter Sheila: mute every fresh camera track unless its open has live user activation. Test setup: Pixel 7 on wifi.

**Expected behavior:** Evidence for Camera Mute Loop must show page shows "Restart the Polkadot app", page never shows "Voting has closed", page never shows "Your Polkadot app is stuck, restart it", and page never shows "We couldn't connect you to anyone."; absent evidence remains a failure and pending guards stay visibly pending.

#### Safe parameters

- **acceptanceOnly:** true
- **cameraDelayMs:** 0
- **cameraMode:** "ok"
- **cameraMuteLoop:** true
- **cameraResolution:** "720p"
- **clockOffsetS:** 0
- **cpuThrottle:** 1
- **device:** "Pixel 7"
- **networkProfile:** "wifi"
- **relayOnly:** false
- **role:** "baseline"

#### Video narration lifecycle

| Phase | Overlay narration |
| --- | --- |
| preparing | Shutter Sheila is preparing Camera Mute Loop on Pixel 7 on wifi. |
| verifying | Shutter Sheila finished the actions; the run is checking 4 evidence requirements. |
| passed | Camera Mute Loop recorded every required observation. |
| failed | Camera Mute Loop is missing or contradicted by required evidence. |

#### Action narration

No disruptive actions.
