# The state-machine explorer: reductions, results, and what did not work

This page reports what the explorer checked, what made the checks cheaper, and what did not, so that the next attempt starts from the measurements instead of repeating them. The explorer is in [`apps/jollity-app/lib/explorer/`](../../apps/jollity-app/lib/explorer/); its [README](../../apps/jollity-app/lib/explorer/README.md) says how to run it and how to read a report.

**About the numbers.** They come from runs between late October and early November 2026, on a shared 16-core server under load, against the code of that time. Wall-clock times are inflated by the load; counts of states, labels and leaves are not. The code has moved since (the room's key format is 3, the runs used 2; the beat label is now the default; Mesh's old decision path is gone), so a run of today's code gives different counts. Each section names the command that runs the same search today. Two of the reductions measured here (the sweep macro and the completion collapse) were never merged, so their numbers cannot be rerun.

Contents:

1. The system in one page
2. What worked
3. What did not work
4. Lessons
5. Open questions

## 1. The system in one page

### 1.1 What is explored

The explorer enumerates every order of the choices that the browser, the network and the clock could make, up to a depth. It has three levels. Each level trades fidelity for reach.

| Level | What runs | Size of a step | Used for |
| :-- | :-- | :-- | :-- |
| Peer actor | The pure reducer `lib/state-machines/peer-actor.ts` in a small world of events. No Mesh. | 1 actor step | Recovery rules, the state-count metric |
| Mesh pair ("mesh-pair") | Two real `Mesh` objects, with a controlled `RTCPeerConnection` and a model of the statement transport. A fake clock. | 1 label, about 0.57 ms replayed, 12.3 ms for a reset with a 21-label warmup | Confirming findings on real product code, recovery bounds |
| Abstract N-phone room ("room") | Every half-connection (one phone's side of one pair) is the peer actor. The wire, the clock and the phone queues are a model. | 1 label, about 2 ms per state | Breadth: 3 phones to depth 8 or 9 |

The room finds, and mesh-pair confirms. Only a finding confirmed on real Mesh is called a finding. Every other finding carries a verdict (`confirmed:mesh-pair`, `refuted`, `not-confirmable`, `abstract-3`, `unconfirmed`; the README's "Confirming a finding on real Mesh" defines them).

### 1.2 What is checked

| Property | Where | Meaning |
| :-- | :-- | :-- |
| P1 | mesh-pair | An answer on the wire is an answer, and carries the generation of the offer it answers. |
| P1b | mesh-pair | One PeerConnection never applies offers from two different remote connections. |
| P2 | mesh-pair | An answer outcome the actor reports is honest against the wire. |
| D (deadline) | mesh-pair, room | Recovery invariant: an open actor whose link is not connected holds the deadline its link recovers by, unless a named exemption holds. One function, `missingRecoveryDeadline` in `peer-actor.ts`. |
| L1 | mesh-pair | Eventually steady: a fair drain of the clock and the heartbeat, with no new faults, reaches a steady pair within 90 s of fake time from the leaf. |
| RP1, RP2 | room | A label changes only the halves it names. |
| RP3, RP4, RP6, RP7 | room | Phone consistency, roles, one connection one remote, no restart of a pair that has no fault. |
| RP10 | room | The room's L1: from a state, the fair continuation without faults brings every pair to steady within 60 steps per pair or 90 s. It is sampled. |
| Inclusion | room | Each half's step must be a step the single-actor explorer also takes. Sampled 1 in 100. |

A property P4 compared Mesh's copies of the actor's recovery times with the actor's own; it was retired when Mesh stopped keeping copies. The monitors are registered in `lib/explorer/mesh/monitors/index.ts`.

### 1.3 Faults, bounds and anchors

- **Fault budget F.** A fault spends one unit of F. Faults are: a rejected PeerConnection operation, a dropped frame, a reload, a network change, an ICE disconnect or failure. Mesh-pair runs here use F = 2. The room runs use F = 1 past the anchor.
- **Bounds.** Every verdict names them: `clean at d = 8, F = 2, H = 120 s`. Depth d counts labels. H is the fake-clock horizon.
- **Anchors.** A search starts from a named stable situation instead of from nothing. Mesh-pair has 10 anchors (`lib/explorer/mesh/anchors/`): steady, after-reload, half-open, mid-glare, mid-rebuild, lost-signal, rejoin-queued-offers, ice-failed, ice-disconnected and network-all; the runs in section 2.5 predate network-all. Each replays a fixed warmup (10 to 32 labels) after every reset. The room starts from three steady phones, then the reload of one of them (p2) or a network change on every phone (`ROOM_RUN=reload|network-all`).
- **What a clean run means.** It is bounded evidence, not proof. For the parts enumerated exhaustively, no schedule of at most d labels with at most F faults and a clock below H broke a checked property. Nothing is said about longer schedules, more faults, or what the model leaves out. Some checks are not exhaustive: RP10 probes and the inclusion check are sampled, so a clean room run says only that the sampled states passed them. With deduplication the claim also depends on the fingerprint being sound (README, "Running it").

### 1.4 What each method guarantees

| Method | Guarantee | It does not guarantee |
| :-- | :-- | :-- |
| Exhaustive enumeration to depth d (mesh-pair or room) | No violation of the exhaustively checked properties within the bounds | Anything past the bounds |
| Sampled probes in the room (RP10, inclusion) | No failure among the states sampled | A verdict for the states not sampled |
| Deduplication on the room fingerprint | The same, if the fingerprint and each monitor's closure declaration are sound | Soundness of a monitor that reads history outside the fingerprint |
| Tiled disk map | The same states as the in-memory search (section 2.1) | Anything about the model |
| Recovery bound K per anchor | K is the longest time to steady seen over every state the search reached | K is a lower bound of the true supremum. It grew with depth for several anchors (section 2.5). |
| Beat label | A model of the heartbeat that is close to production | Hellos at arbitrary instants (section 2.3) |
| Ample-set partial-order reduction (POR) | Findings whose check reads only a label's footprint. State counts become lower bounds. | Every state, and findings at the same depth (section 3.4) |

## 2. What worked

### 2.1 The disk-backed tiled map

**Idea.** Keep the visited set and the frontier of the room's breadth-first search on disk, not in the heap. Each state has a 128-bit id, and the id picks a tile. Worker processes expand one tile at a time. One barrier per depth keeps the layers equal to the in-memory search's layers. The code is `lib/explorer/room/tiled.ts`; the README's "The room as a tiled map on disk" has the command, which today runs with the beat label and 1,024 tiles unless told otherwise:

```bash
# from apps/jollity-app; re-running the same command on the same --out resumes
ROOM_BEAT=0 npx tsx lib/explorer/room/tiled-main.ts --run network-all --depth 9 --out /path/to/run --workers 4 --tiles 256
```

**Equality with the in-memory search.** The tiled run and the in-memory search agreed on states per depth, distinct pair states, edges, inclusion checks, gaps and RP10 probes, including runs whose workers, or the whole run, were killed and resumed:

| Run | States at the last depth | Distinct pair states | Edges | Inclusion checked / mismatches |
| :-- | --: | --: | --: | --: |
| reload d4, 2 workers | 79,422 | 12,906 | 251,798 | 2,875 / 0 |
| reload d5, one worker killed mid-depth 4 | 586,390 | 42,404 | 2,144,526 | 24,173 / 0 |
| network-all d5 | 20,968 | 1,901 | 68,880 | 810 / 0 |
| network-all d7, whole run killed mid-depth 6 and mid-depth 7, resumed twice | 1,543,523 | 29,420 | 6,687,019 | 74,229 / 0 |

`tiled.test.ts` keeps the equality as a test (with `ROOM_SAMPLING=key`, so both searches sample the same states).

**Depths reached.** 3 phones, F = 1, no beat label, 256 tiles. Growth is states at a depth over states at the previous depth.

| Depth | network-all: states | growth | pair states | reload of p2: states | growth | pair states |
| --: | --: | --: | --: | --: | --: | --: |
| 5 | 20,968 | 12.2 | 1,901 | 586,365 | 7.4 | 42,315 |
| 6 | 198,758 | 9.5 | 8,289 | 3,540,037 | 6.0 | 118,323 |
| 7 | 1,543,523 | 7.8 | 29,420 | 18,090,837 | 5.1 | 302,107 |
| 8 | 10,177,707 | 6.6 | 89,883 | **80,746,154** | 4.5 | **732,337** |
| 9 | **58,485,219** | 5.8 | **246,243** | | | |

Neither run closed: no depth added 0 states (`edgeReached` false in every row). The state ratios fall by about 0.85 to 0.87 per depth. The visited sets on disk were 10.8 GB (network-all d9) and 13.2 GB (reload d8); the highest worker peak was 1,735 MB, and the coordinator stayed near 150 MB. For comparison, the in-memory search held 10.3 million states in 1.8 GB.

**Findings from the deep runs.** Reload d8 reported 180 RP10 failures, explained in section 2.6. Network-all d9 reported 43, not triaged: the first five have the same shape, one pair not steady after 94 to 109 labels with only tick, hello and advance labels left.

### 2.2 The memory fix: log retention, not the dedup table

**Symptom.** Long mesh-pair runs died of out-of-memory. The search worker stayed under 0.7 GB, so the visited map of the deduplication looked like the suspect.

**Cause.** The process that grew was the test runner's parent, not the worker. Mesh writes a line for every RTC event with `console.log`. In a vitest worker each call is sent to the parent, which keeps every line on the task's `logs` array until the run ends, before any reporter filter, so `silent` does not stop it. That was about 8 to 12 KB per leaf; parents reached 10 to 11 GB while their workers held 0.55 to 0.67 GB.

**Fix.** The explorer silences Mesh's `console.log` inside explorer workers (`lib/explorer/core/quiet-console.ts`) and keeps `devLog`, which the fingerprint counts. Parent memory went flat (324 MB at 1k and at 35k leaves, against 442 and 716 MB before), the search result was identical, and search time on the steady anchor at d7 fell by 35%, together with cheaper quiescence checks and fingerprints.

### 2.3 The beat label

**Idea.** In the room, a "hello" (a phone telling a peer it is present) could happen at any instant, and the key keeps the time since each hello exactly, so every hello mints new states. In production a hello goes out on a heartbeat, to every peer, at one instant.

**Change.** `beat:<i>` replaces the free hello. It is due at once after a boot or reload, then 8 s after the last beat while any link of phone i is not connected, and 16 s once all are. A due beat is not optional: the clock cannot advance past it. It is the room's default now; `ROOM_BEAT=0` keeps the free hello for a comparison.

**Measurement.** Reload of one phone, F = 1, tiled map.

| Run | Without beat | With beat | Ratio |
| :-- | --: | --: | --: |
| n = 2, depth 9, 72 s horizon | 1,057,599 states | 112,389 | **9.4x** |
| n = 3, depth 4 | 79,422 states, 12,906 pair states | 16,511 states, 2,923 pair states | **4.8x**, 4.4x |
| n = 4, depth 4 | 638,810 | 142,843 | 4.5x |

The gap widens with depth.

**Stated approximation.** The period follows the phone's current link state, so a link that goes down can pull a beat earlier than when it was armed. A beat that cannot be delivered to one peer does not undo the others. The beat is a restriction of production behaviour, not a proof about all hello timings.

### 2.4 Shrinking the actor

The peer actor was reworked to own its recovery times and deadlines, with one link axis in place of a region label, and the explorer was the judge: the room's distinct pair states and the actor anchors' states were the size metric, and a change could not raise them without naming the source. Merging the "negotiating" and "recovering" region labels cut the actor anchors by 9 to 11% at d5 (away-and-back 230,753 to 209,309 states; network-changed 336,332 to 301,003) and the room by 1 to 4%. One later step raised the mid-glare anchor by 4% at d6, which its author put down to a new per-connection time in the fingerprint; that is inferred, not proven.

**The census.** Deleting a field from the key and counting the distinct keys among the states the full search reached measures what carrying the field costs (it is not a re-search without it). It found two fields no decision read: one cost 6.7% of the states at d4 and 9.1% at d5, the other nothing, and both were deleted. It also showed its limit: counters such as `failCount` cost states only deeper than the search reached. In real games `failCount` reached 10, while the explorer never saw it above 3.

### 2.5 Recovery checking per anchor

**Claim under test.** From each anchor, after a fault and after a second fault during the recovery, the two real Meshes return to steady within a bounded fake time K. L1 reports the longest fake time any leaf needed to reach steady, and `--liveness-bound-s B` turns a leaf that needs more than B into a finding. Every leaf was checked. The shape of the command, per anchor (the README's "Running it" lists the flags; L1 needs the `--legacy-dfs` path):

```bash
npm run explore -- --machine mesh-pair --scenario after-reload --legacy-dfs --faults 2 --depth 9 --liveness --liveness-bound-s 45
```

F1 runs reached depth 9 to 16 and F2 runs depth 8 to 16 (varies by anchor). "Before" and "after" are before and after the connect-by deadline (section 2.6).

| Anchor | Leaves checked (F1 + F2) | K before | K after |
| :-- | --: | --: | --: |
| steady | 270,282 | 39 s | below 45 s |
| after-reload | 301,047 | 62 s | 32.8 s |
| half-open | 163,443 | 62 s | 32.8 s |
| mid-rebuild | 145,947 | 62 s | below 45 s |
| ice-disconnected | 60,455 | 62.3 s | 20 s (not comparable, see below) |
| ice-failed | 121,668 | 62.3 s | 5 s (not comparable, see below) |
| lost-signal | 369,539 | 32.3 s | 32.3 s |
| mid-glare | 396,023 | 32 s | 32.3 s |
| rejoin-queued-offers | 383,468 | 32 s | below 45 s |

Results: 0 stuck leaves, 0 findings, 0 harness cuts, before and after. The bound went from **62 to 62.3 s to about 33 s**, for the anchors where the comparison is like for like. Two limits on that comparison:

- The ice anchors ran to depth 16 before and to depth 10 (F1) and 9 (F2) after, so their drop to 20 s and 5 s is not like for like.
- K is "time from the end of the explored path to steady", not "time since the fault". The first fault to steady took 68.0 s in the worst leaf.

**The chaining argument.** A game is steady stretches separated by faults. After one fault, every explored state returns to steady within K; if the next fault comes after steady, the same bound applies again; F = 2 covers a second fault inside a recovery. So a game with spaced faults, or faults nested in pairs inside the explored region, is back to steady within about K of the end of the explored prefix. This is an argument from bounded evidence, not a proof: K is measured from the leaf, which may lie well after the fault, so the step from K to a bound after the last fault is part of the argument, not a measurement.

**What the bound does not cover:**

- Only the hand-picked anchors, and only two phones.
- F = 2 is explored only in the first 9 to 12 s of fake time after the anchor, against recoveries of up to 62 s: about 15 to 20% of the window.
- K was not stable by depth (after-reload F2 went from 39 to 62 s between d8 and d9; ice from 6 s at d12 to 62.3 s at d16), so the printed K is the maximum seen, a lower bound of the true supremum.
- Three or more faults were not run. Reloads of both sides at once, a flapping link, TURN, a host that kills the page, and the video path are not covered.

### 2.6 Bugs and artefacts the explorer surfaced

The explorer found real defects and many model defects. Both kinds are results.

**The 62 s two-wait case (real defect, fixed).** After a fault two phones could need 62.25 s to recover. Replaying the worst leaf label by label showed where the time went:

| Wait | Seconds | Cause |
| :-- | --: | :-- |
| Unanswered offer | 30.0 | `answerWaitMs`: waiting for an answer that never comes (lost as stale in a glare race, or a refused setRemoteDescription the actor only logged) |
| Rounding to the supervisor tick | 2.25 | The 3 s sweep |
| Stranded wait | 30.0 | After a yield, `answerWaitMs` again, for an offer the peer had no reason to send |

The actor's connect-by deadline (`connectBy` in `peer-actor.ts`) makes it rebuild as an offerer instead of yielding: on the three worst leaves, ice-failed went from 62.25 to 32.25 s, half-open from 62 to 20 s and after-reload F2 from 62 to 32 s. The shape needed an adversarial order that real phones may rarely take. The explorer finds shapes, not rates.

**The refused-rejoin shape (found in the room, confirmed on Mesh, later closed).** The room found, three times in 3,315 liveness probes, a pair that never recovers after a reload followed by a refused rejoin offer (an SDP error from the local `setLocalDescription`). Mesh-pair confirmed it. The connect-by deadline closed it by construction; `room/findings/1562.json` keeps the finding, and `room/mesh-confirm.test.ts` checks that it no longer projects onto a pair. Once the controlled PC was made to fail as Chrome does (ICE fails about 30 s after the peer's PC is gone), the same shape healed in 33 s even before the fix, so the "never recovers" part was partly a harness artefact.

**Harness artefacts (found by checking, not by the product).**

| Artefact | Size | Fix |
| :-- | :-- | :-- |
| A controlled PC holding the description of a PC the other side closed stayed "new" for ever, so L1 reported stuck leaves a browser cannot reach. | 5 stuck leaves (after-reload), 1,913 (ice-disconnected d16), 804 (ice-failed d16) | The PC now fails after 30 s of fake time (`pc:<id>:ice-timeout-failed`). After it: 0 stuck. |
| The 180 RP10 failures of the reload d8 run | 176 were the refused-rejoin shape, 2 a settle at 182 steps against a cap of 180, 2 a quiet stall with crossing offers | With the harness fix and the connect-by deadline, all 180 reach steady in 67 to 151 steps. No Mesh bug in any group. |
| A model livelock at 4 phones (RP10 at n = 4, d4): connection epochs climb past 17 | The room's held rule sends the rebuilt peer's answer through the alphabet's statement-answer entry and the actor rebuilds again. Real Mesh escapes in `rollbackUnsentOffer`, which neither the alphabet nor the room models. | Not fixed. Driven on two real Meshes (5 fixed schedules and 400 random seeds, 120 s fake time): no loop. |

**The model-versus-Mesh asymmetry.** 13 supervisor mutants leave the room stuck while Mesh, with the same mutant, recovers: Mesh has a way back the room does not model. The room over-reports stuck pairs in this direction.

## 3. What did not work

Each entry has the same parts: the idea, why it was expected to help, the measurement, why it failed, and what it would take.

### 3.1 Exhaustive search of a whole game round to the 72 s horizon

**Idea.** Check a full six-phone round (12 s times 6 seats = 72 s) exhaustively: direct search first, with reductions that keep every state; composition by pairs only if that fails.

**Why it looked possible.** The tiled map had reached 80 million states at 3 phones. The estimate for a pair model was 10^7 to 10^9 states, with the gate "growth ratio below 1.3 by d15 and under 10^8 states".

**Measurement.** Two-phone room, beat label, 72 s horizon, F = 1, reload after a steady anchor:

| Depth | States | Growth | Distinct pair states |
| --: | --: | --: | --: |
| 4 | 1,188 | 3.40 | 1,134 |
| 8 | 51,148 | 2.31 | 45,866 |
| 12 | 931,127 | 1.95 | 806,573 |
| 13 | 1,755,915 | **1.89** | 1,506,524 |

- Growth was 1.89 at d13. The steps shrink by about 0.88 per depth, so, if they keep doing so, the ratio would level off near 1.4, above the gate. That is an extrapolation, not a measurement.
- Horizon cuts: **0 through d13.** A fair run reaches 72 s after about 50 labels (n = 2) and 82 labels (n = 3), so closure needs depth 35 to 50: **10^11 to 10^13 states for the pair alone.** At six phones growth is 31x per depth at d3 with the beat, and a round needs depth in the hundreds.

**Why it failed.** Not the clock. At n = 2, d9 the same search without elapsed time in the state has 112,289 states, against 112,389 with it. The growth is the number of ways to interleave steps that are really ordered: beats, half-local steps (offer, answer, set-remote-description) and deliveries.

**What it would take.** A reduction that cuts depth, not just states, and keeps every state that matters. None was found (sections 3.2 to 3.4). The remaining options are a coarser time model (needs a decision, not state preserving), or bounded depth with sampled walks and a stated "sampled" verdict (section 5). A composition of one pair against an abstract environment contains the two-phone room, so it is at least this large.

### 3.2 The sweep macro (not merged)

**Idea.** An `advance` of the clock makes every other phone owe a sweep (a supervisor tick) as a free label; `tick` and `advance` made 42% of the new states at d9 in the two-phone room. Fold the sweeps into the advance: one label moves the clock and sweeps every phone at the new instant.

**Measurement.** It is not state preserving: an owed sweep and a message or fault on the same phone at the same instant really race (an ICE loss before the sweep leaves the half "recovering" with `failCount` 1, after it reads link-down). It missed a handful of rest states in each run (11 of 134,937 at n = 2), lost no finding, and removed 14 to 18% of the states per depth with the completion collapse below, but growth at d13 stayed at 1.91 against 1.89. The labels for a fair 72 s run fell from 50 to 42 (n = 2): only the ticks go; the beats, the half-local steps, the deliveries and the advances stay.

**Why it failed.** It does not move the growth, which is what the gate tests, and no state-preserving fold of the clock steps can: the macro reaches a subset of the unreduced rest states. Keeping the races as separate labels is partial-order reduction (section 3.4); accepting the macro as the time model ("every phone sweeps first at an instant") is a coarser model that needs a decision first.

### 3.3 The completion collapse (not merged)

**Idea.** Run a `complete:overtaken` step at the end of the edge that enables it, instead of as a free label.

**Measurement.** It is **exact** on every check (the same state sets, pair states, findings and gaps), and small: 13.8% fewer states at n = 2 with the beat, 0.6% and 0% at n = 3. It does not change the growth ratio. Completions with other outcomes (resolved, rejected, stale) do not commute in many pairs, and ordering them canonically would be partial-order reduction.

### 3.4 Ample-set partial-order reduction

**Idea.** Explore only an "ample" subset of the enabled labels at each state, when the others commute with it. Most leaf steps (delivery, beat, ICE, tick, advance) leave no choice, the condition for a large gain. It was tried for the 3 to 6 phone rooms, with a gate: identical finding sets beside the full search, and a planted bug that must stay red.

**Where it is.** `lib/explorer/room/por.ts`, behind `ROOM_POR=1` on the in-memory room search (the tiled map is not wired); off, the search is exactly the full one. `room/por.test.ts` keeps the result below as a test, with the runtime independence check (`ROOM_POR_CHECK`) and its negative controls.

**Measurement.**

| Run | States | Quiet states expanded | Reduced | Full set: faults left | Full set: advance enabled | Full set: closure reaches all |
| :-- | --: | --: | --: | --: | --: | --: |
| 3 phones, d4 | 79,375 | 6,731 | **0** | 3,135 (47%) | 1,617 (24%) | 1,979 (29%) |
| 4 phones, d3 | 39,257 | 1,510 | **0** | 958 | 406 | 146 |
| 3 phones, beat, d4 | 16,481 | 2,014 | **0** | 828 | 94 | 1,092 |

**Why it failed.** At no quiet state did the ample set come out smaller than the full set. Three couplings make every label depend on every other:

1. **The per-phone sweep.** `tick:i` writes every pair of phone i. A label on pair (i, j) depends on `tick:i` and `tick:j`, and those reach every other pair of i and j: on the complete pair graph of 3 or more phones, everything.
2. **The shared fault budget.** While faults are left, a fault label is enabled at every quiet state (47% of the quiet states at 3 phones d4).
3. **The global clock.** Every half reads it.

**Guarantees and costs, had it reduced.** It keeps every finding whose check reads only a label's footprint, or a projection no ample label changes. It does not keep every state: state counts and anything sampled per state become lower bounds, and a finding can move deeper within a depth bound. So a reduction that works must be validated beside the full search, and it costs the "every state" claim.

**What it would take.** A model change with no gain measured for it yet: a per-half sweep label in place of the phone-wide tick, and a decision on whether replacing a connection resets `tickedAt`. Splitting the sweep changes what the model does at an instant, so it costs fidelity.

### 3.5 Checkpointing live Mesh state

**Idea.** Every mesh-pair visit that cannot continue from its parent resets the room and replays the anchor's warmup (21 labels at steady), and the warmup dominates CPU: at d7, 91% of visits reset and 78% of the executed steps were warmup. Snapshot the warmed room once and restore it. By Amdahl's rule a free checkpoint gives at most **2.2x to 2.9x** on steady.

**Why it failed** (a design analysis, with no code):

- **In-process snapshot.** `lib/webrtc/mesh.ts` is about 4,000 lines of closures: interval timers, handlers bound to each connection, dozens of `await` points, promise resolvers in each controlled PC's queue, and a fake clock holding every timer as a closure. `structuredClone`, `v8.serialize` and JSON refuse functions, and a suspended async frame cannot be read from JavaScript. Rehydrating Mesh from data needs a product-code API or writes to private fields, a second path to a Mesh state that real phones never take.
- **Warm spare room.** Two rooms cannot live in one worker: the fake timers, the PC stub and some module state are process-global.
- **OS fork.** Node has no `fork()` of a running process, and a fresh `node -e 0` took 40 ms, 3.3 times a whole steady reset.

**What it would take.** A product change that gives Mesh a real state export for its own reasons. What was done instead is section 2.2's cheaper steps.

### 3.6 Tiling the real-Mesh two-phone search

Not built, by inference: the out-of-memory was the runner's log retention (section 2.2), not the visited set, and mesh-pair is CPU-bound in replay (63% of the time at d8, plus 22% for the node fingerprint). Tiling spreads states over processes but does not make a reset cheaper. Mesh-pair kept its d = 8, F = 2 anchor runs and took a different job: confirming and deepening around room findings.

### 3.7 Can the two-phone room be closed?

**The question.** Could the explorer prove, rather than sample, that two phones are safe with no fault (F = 0)? That needs the reachable states to close: a depth beyond which no new state appears. It did not close.

- **At millisecond precision.** The room keys every time as an exact distance from now, and several folds make the key coarser without changing any future. From a cold start the new states per depth kept growing at about x2 a depth for every sound key, to d14 with free hellos and to d22 with the beat (x1.77 at d22). With every time dropped from the key, 1,776 keys were left of 53,607 at d11: the growth is timing, each field's age combined with the other half's.
- **Zones.** The standard way to close a timed model is a zone graph, keyed by constraints between clocks instead of exact ages. A design was written and reviewed; the review asked for dense time (the phone clock is fractional), the all-predicates cut by default, one old pending item per kind instead of eager completion, and judging the first stage by distinct discrete keys per depth.
- **With all time removed.** The cheapest decisive test: the room with every live time replaced by one token. This skeleton is a subset of what any zone graph holds, so if it does not close, no time abstraction can. It ran to d30 (1,258,938 states): the growth ratio fell from x2.5 at d12 to x1.366 at d24, then rose again to x1.387 at d30. The zone stage was therefore not built. Projecting groups of the key out one at a time, no group bent the ratio below x1.3; even deleting the actor state left x1.32. A closed claim would need one joint abstraction of both phones (a protocol-level quotient of the pair), which is new design work.

**What stands.** The bounded claim: clean except RP6, at cold start, F = 0, to d14 (free hellos) or d22 (beat), with RP10 sampled 1 in 100. Its scope is narrow: the room moves time only to a deadline instant or 1 ms before it, so every hello and delivery lands there. And RP6, which the room found in 18 labels from a cold start and real Mesh confirmed: an answer's description is still pending when the sender's next offer arrives, and both land on one connection. It is fixed (Mesh's new-session check now reads the session of an answer still being set), and `lib/explorer/mesh/rp6-answer-pending.test.ts` replays the schedule on real Mesh and checks that the pair heals.

## 4. Lessons

1. **The state space comes from ordered protocol events, not from clocks.** Removing elapsed time from the state changed the n = 2, d9 count by 0.1%. Folding the clock steps (42% of new states) moved the labels needed for 72 s from 50 to 42. What multiplies the states is the interleaving of beats, half-local steps and deliveries that are really ordered. A reduction that cuts the clock cannot cut the depth.

2. **Gather bounded evidence of recovery per anchor, not proof by whole runs.** A whole-round search is out of reach (10^11 to 10^13 states for two phones). A bound per anchor is reachable: 9 anchors, 2.2 million leaves checked, 0 stuck, K at most 62.3 s and then about 33 s. The cost is a smaller claim, stated with its gaps (section 2.5).

3. **Validate the harness against real Mesh before trusting a finding.** Thousands of stuck leaves at the ice anchors were a controlled PC that never failed; the refused-rejoin "never recovers" became "heals in 33 s" under the same fix; 176 of 180 RP10 failures came from that shape; 13 supervisor mutants stall the room while Mesh recovers; the 4-phone livelock is absent on real Mesh. The rule in section 1.1 (the room finds, Mesh confirms, an unconfirmed finding is not reported) exists because of these cases.

4. **Use real games as the reality check.** The explorer finds shapes, not rates. Before the connect-by deadline shipped, it was checked against the logs of real games on Paseo: no connection that reached "connected" would have been cut by it, and the refused-rejoin shape did not occur. Those logs are not in this repository. The absence of a log line is not proof either: the log is a ring buffer, and a page that dies ships nothing.

5. **Test the test.** The mutant self-test runs before every mesh-pair run by default, plants known bugs, and fails the run (exit 2) if the explorer misses a gating mutant (README, "The mutant self-test"). A clean verdict from a blind explorer is the failure it guards against. The recovery-bound, CPU-profile and memory runs on this page ran with `--no-self-test`; they measure counts and times.

## 5. Open questions

- **Pair-model closure.** The two-phone room does not close at 72 s under any state-preserving reduction found so far (sections 3.1 and 3.7). Options: a coarser time model (needs a decision), a protocol-level quotient of the pair, or giving up closure for the pair.
- **F of 3 or more.** Not run. F = 2 is explored only within the first 9 to 12 s of fake time after an anchor, so a fault late in a long recovery is not covered.
- **Random full-length walks with a "sampled" verdict.** Mesh-pair has seeded random schedules up to twice the depth (`--sample n --seed s`). Walks of 50 to 100 labels that reach the 72 s horizon would give a verdict that says "sampled, n walks". The room has none.
- **Network-all depth 10.** Not run. By extrapolation, about 290 million states, with the visited set at d9 already 10.8 GB.
- **POR after a model change.** Whether a per-half sweep makes the ample set smaller is unmeasured; `room/por.ts` can measure it again.
- **Unexplained.** The worker memory peaks at reload d7 (1,154 MB) and network-all d8 (1,735 MB), and the 43 RP10 failures at network-all d9.
