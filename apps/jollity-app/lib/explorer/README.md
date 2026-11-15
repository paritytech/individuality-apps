# The state-machine explorer

An on-demand test tool. It drives two real `Mesh`es (`a` and `b`, room `g42`) over controlled
PeerConnections and a model of the statement transport, and enumerates every order of the choices
the browser, the network and the clock could make, up to a depth. Monitors judge each step against
oracles the harness writes itself (the wire log, the op log, the delivery log and the effect
outcomes), never against Mesh's own verdicts. What it checked, the reductions that made it cheaper
and what did not work are written up in
[`docs/explorer/reductions-and-results.md`](../../../../docs/explorer/reductions-and-results.md).

**A clean run is bounded evidence, never a proof.** Every verdict names its bounds, as in
`clean at d = 8, F = 2, H = 120 s (closed at the depth bound)`: no schedule of at most d labels, with
at most F faults and a fake clock that never passes H, violated a monitored property. Nothing is said
about longer schedules, more faults, the three-phone room, or anything the model leaves out (the
room.ts header lists what it does not model).

With dedup the verdict says
`clean at d = 8, F = 2, H = 120 s (closed at the depth bound, dedup on the room fingerprint)`.
That qualification is part of the claim: the pruned subtree is covered only if the hardened
fingerprint and every active trace-closed declaration are sound.

It never runs in PR CI. Its tests run only through `vitest.explore.config.ts`, and
`vitest.lib.config.ts` excludes `lib/explorer/**` (checked by `vitest list` in core/config.test.ts).

## Running it

From the repository root:

```bash
npm run explore -- --machine mesh-pair --scenario rejoin-two-offers
npm run explore -- --machine mesh-pair --scenario single-offer
npm run explore -- --machine mesh-pair --scenario single-offer --dedup
npm run explore -- --machine mesh-pair --scenario outage --dedup
npm run explore -- --replay test-results/explorer/<run>/witnesses/<file>.json --machine mesh-pair [--emit-test]
npx vitest run --config vitest.explore.config.ts lib/explorer/mutants/self-test.test.ts   # from apps/jollity-app
```

- `--depth`, `--faults`, `--horizon-s`: the bounds. Unset, they are the scenario's defaults (below).
- `--budget-min` (default 30 on the `--legacy-dfs` path): a wall-time stop, never a bound. A run the budget stopped says
  `inconclusive` and exits 3, whatever it found clean so far.
- `--workers` (default cores - 2): worker processes. A deduplicating run owns each disk-backed tile
  by its 128-bit state hash, so it may resume with a different worker count. The
  `--legacy-dfs` path instead deals depth-two root/child label pairs among shards. Set
  `NODE_OPTIONS=--max-old-space-size=<MB>` and `--heap-gb` so that workers x heap fits the box: one
  worker uses well under 0.5 GB.
- `--no-self-test`: skip the mutant self-test (below). It runs by default before every mesh-pair run,
  in shard 0.
- `--sample n --seed s`: n seeded random schedules up to twice the depth after the exhaustive search.
  Their findings are labelled sampled.
- `--dedup` (default **off**): use the tiled, disk-backed breadth-first frontier and visited set. The
  state id is the 128-bit room fingerprint plus exact `faultsLeft`; its hash chooses a tile, and tile
  ownership is repartitioned across the selected workers at every resume. `--legacy-dfs` selects the
  iterative-deepening implementation, kept for correctness comparison.
- `--resume <out>`: continue a deduplicating mesh-pair run from its journals and frontiers. The run
  records the git SHA and a deterministic hash of its explorer sources, and refuses a mismatch unless
  `--force-resume` is also passed. Pass a larger `--depth` to extend a completed run from its retained
  bound frontier; a stopped extension resumes from its own journal without recomputing committed states.
- The tiled path refuses `--liveness`, `--sample`, `--census`, `--budget-min`, and `--dedup-check`
  because it does not implement those analyses. Pass `--legacy-dfs` explicitly when one is required;
  no report silently omits a requested analysis.
- **Checkpoint signal:** send `SIGUSR1` to the explorer process. Each worker finishes its current
  state, flushes its journaled children, and the coordinator atomically renames `checkpoint.json`
  into place before exiting 0. The visited set and both frontiers already live on disk, so checkpointing
  does not copy them into memory or duplicate their peak memory. Resume may use another `--workers`
  value.
- `--dedup-check 1/N` (`--legacy-dfs` only): enable dedup and replay a depth-two suffix from every ordered Nth `seen` node
  against its kept twin. The comparison does not consult the fingerprint: it checks canonical enabled
  actions, work counters, findings, known gaps and the fair-drain outcome. A mismatch is a `harness`
  cut and exit 4. On the explicit `--legacy-dfs` route, `--dedup` defaults this check to **1/100**;
  pass an explicit rate to change it. The tiled path rejects the option instead of ignoring it.

Dedup is valid only for **trace-closed monitors**: a monitor's verdict must be a function of the room
fingerprint, including the per-side projected histories. Every active monitor declares `closed`.
The runner refuses `--dedup` with exit 4 if any active declaration is false. A monitor triggered by
the last label (for example, a check of the recovery that label starts) must declare false; do not work
around the refusal by assuming equal states have equal global paths.

**Exit codes:** 0 clean within the bounds and the self-test found every gating mutant; 1 a violation
(or a replay that reproduced one); 2 the explorer is blind (a gating mutant was missed, or a mutant
needs a refresh); 3 inconclusive (the budget stopped it); 4 a harness error (a harness cut in the
tree, a shard that died, an out-of-date witness).

### Default bounds

Measured on a shared 16-core server on 29 Oct 2026, with the room as it is now (no `dup`), on 7
workers (7 x 1.5 GB heap, inside the 12 GB the box allows) and the default 30-minute budget. These
runs predate the removal of Mesh's old decision path, when `--flag on|off|both` also searched that
path's tree; "flag on" is the only tree now:

| scenario | default depth | F | H | closed tree at the default depth | mean enabled | slowest shard |
|---|---|---|---|---|---|---|
| rejoin-two-offers, `--flag both` | 8 | 2 | 120 s | 522,762 leaves (both flags together) | 4.15 | shard 0: 576 s of search at d = 8 (both flags), 736 s wall for the whole run |
| single-offer, flag on | 10 | 2 | 120 s | 1,057,234 leaves | 3.03 | shard 0: 1,257 s at d = 10 |

- rejoin-two-offers at d = 9 did **not** close in 30 minutes. Counted per flag, the d = 9 leaves of
  the six shards that closed it were 31,547-253,474 each, while shard 0, which holds the root's
  heaviest label alone, had reached 279,081 (flag off) and 255,541 (flag on) when each flag's
  15 minutes ran out. That run's verdict was `clean at d = 8, F = 2, H = 120 s (inconclusive)`,
  exit 3, so the default is 8.
- **What the scenario runs do not cover.** rejoin-two-offers clean at d = 8 says nothing about
  #1385's shape, which needs 14 labels (a 10-label warmup, then two deliveries and two SRDs). That
  subtree is covered by the self-test's warmup-seeded search with no mutant (check 3: 1,330
  leaves to d = 14 on each flag, clean), not by the scenario run.
- Leaves grow about x4.3 per depth on rejoin-two-offers and x3.1-3.6 on single-offer.
- One worker runs about 380-520 schedules a second (a schedule at depth d replays d steps from a
  reset: about 0.25-0.3 ms a step, drain and monitors included).
- Depth-two dealing spreads each root label's children across shards, so more than 7 workers can
  help. Subtrees can still differ in cost, and the slowest shard sets the run's wall time.

### Checkpoint capacity estimate

The local depth-6 checkpoint run held 6,827 cumulative states in 7,585,319 bytes, or 1,111.08
bytes/state. Its interrupted/resumed directory was 1.1298 times the uninterrupted size. Applying
the measured rejoin growth assumption of 4.3 per depth gives:

| depth | state-equivalents | base size | with 1.1298 resume overhead | one-worker runtime | ideal 8-worker runtime |
|---:|---:|---:|---:|---:|---:|
| 11 | 10.04 million | 11.15 GB (10.39 GiB) | 12.60 GB (11.73 GiB) | 5.36-7.34 h | 0.67-0.92 h |
| 12 | 43.16 million | 47.95 GB (44.66 GiB) | 54.17 GB (50.45 GiB) | 23.05-31.55 h | 2.88-3.94 h |
| 13 | 185.57 million | 206.18 GB (192.02 GiB) | 232.95 GB (216.95 GiB) | 99.13-135.65 h | 12.39-16.96 h |

The formulas are `6,827 × 4.3^(depth - 6)` states and states × 1,111.08 bytes. Runtime divides
state-equivalents by the existing 380-520 one-worker schedules/s measurement; the 8-worker column
then assumes perfect division. These are capacity bounds, not promises: the byte sample is
single-offer F=1 while the growth factor is rejoin, a state expansion is only approximated by one
recorded schedule, replay paths lengthen with depth, filesystem allocation/findings vary, and tile
skew, process and I/O overhead make worker scaling sublinear.

The mature local depth-5 signal checkpoint occupied exactly 3,545,597 bytes and its final atomic
manifest write/rename took 69.56 ms. Frontiers, the seen set and journals were already streamed, so
the signal does not rewrite the estimated directory sizes or duplicate them in memory; there is no
honest linear depth-11-13 write-time extrapolation from that manifest measurement. Expect roughly
the same order of final-manifest latency, subject to filesystem sync/load, while normal traversal
has already paid the data-write cost.

The defaults live in `mesh/scenarios.ts` (`defaults.depth`). A larger box closes deeper: pass
`--depth`, and read the verdict, which says whether the budget let the tree close.

**Fault accounting.** A fault label spends one unit of F: a PC operation's rejection, a frame's
`drop`, and the environment labels (`env:reload:b`, `env:signal-throws:b`, the outage scenario's
`env:ice:<side>:disconnected|failed`, and in every scenario `env:network:<side>`, a network change:
`Mesh.networkChanged()` on that side, as useMesh's network watcher calls it once its 750 ms debounce
fires, listed while that side's Mesh holds a connection to the peer, neither latched nor quiet-gated,
so a change on both phones lands at one instant; the TURN refetch after it and any ICE drop are not
modelled). There is no `dup` label
any more: with the persisted store a dup of an undelivered frame is that frame's `deliver`, and a
delivered frame is no longer deliverable, so it only spent F and branched the tree.

### The outage scenario

`outage` starts from the `steady` anchor (scenarios.ts `from`: every schedule replays its 21-label
warmup first) and adds `env:ice:<side>:disconnected|failed`: one side's current PC moves to that state
and hears both state events. It is a fault, offered at most once per side, and only at a quiet point (no
op, gather, negotiation, statement frame or lane frame waiting) while that side's PC reads connected.
While either PC of a connected pair reads disconnected or failed the pair is down: getStats adds no
frames on either side, lane frames are held (and dropped if a rebuild closes their PC) and no channel opens. The benign network brings
a down pair back only once both descriptions are stable again and a local ufrag has moved on since the
drop (an ICE restart); a rebuild heals through new PC ids, as any first connect. Every one of these
rules keys on a PC reading disconnected or failed, which no other scenario reaches, so their trees are
unchanged (checked leaf for leaf at rejoin-two-offers d = 6, single-offer d = 7, steady and
after-reload d = 5).

**Every heal is a rebuild.** Mesh's ICE restart offer rides the lane while the channel reads open
(mesh.ts onnegotiationneeded, "every renegotiation (media, ICE restart) rides the lane"; the actor's
supervisor restarts ICE only when `laneOpen`). The lane runs over the same ICE transport, so a down pair holds that
offer, the restart never completes, and the supervisor rebuilds. Labels past `steady` from the drop to
a connected pair again (the fair schedule, `mesh/outage.test.ts`): a failed 14, b failed 16, a
disconnected 28, b disconnected 30 (two of them the beats, hb:a and hb:b). The `ice-failed` and `ice-disconnected` anchors start the search
just after the drop.

**Not modelled:** a disconnected PC that mends by itself (so the lane restart never gets its chance),
the far PC noticing the drop (it keeps reading connected), a disconnected-then-failed progression on
one side, and a second drop on the same side.

| run (F = 2, H = 120 s, dedup, 2 workers) | verdict | leaves at the deepest level | time |
|---|---|---|---|
| outage d = 8 | clean, closed | 302 | 4 s |
| outage d = 10 | clean, closed | 1,001 | 13 s |
| outage d = 16 | inconclusive (25-min cap; one shard closed, clean) | 25,085 (that shard) | - |
| ice-failed d = 10 | clean, closed | 341 | 5 s |
| ice-failed d = 14 (a's failed recovery, 13 labels past the anchor on the fair schedule) | clean, closed | 10,308 | 116 s |
| ice-disconnected d = 10 | clean, closed | 97 | 2 s |
| ice-disconnected d = 18 | inconclusive (25-min cap; one shard closed clean) | 8,762 (that shard) | - |

Recovery from a disconnect (27 labels past the drop on the fair schedule, the two beats included) is inside no closed search yet.

### The heartbeat and L1 (#1525)

**`hb:<side>`** is the statement transport's heartbeat (statementTransport.ts `heartbeat`). It is
normal traffic, not a fault, and costs no F. It is offered once 8 s of fake time have passed since that
side's last beat (its session's open, or its last `hb`), only where the signalling is quiet (no op,
gather, negotiation or statement frame waiting; lane frames aside), and only once the peer has heard
the side's current session, or that session's first hello was dropped. A beat:

- delivers the side's hello as onPeerJoined does (`addPeer`, `markSeen`), so the peer's presence stays
  fresh (presenceFreshMs, 45 s), or, when the first hello was dropped, puts a hello back in the store;
- puts the side's last description back in the store (same gen and SDP, a new frame id, wire fate
  `reannounced`) when it was dropped, unless the side's PC reads connected and the description is
  older than FRESH_DESC_MS (`setLinked`). A description the peer already took is deduped by the model.

Not modelled: a lost beat (a later beat is the same), the slower hello of a stable side
(STABLE_HELLO_MS), PEER_TTL_MS's onPeerLeft, and the candidates' re-flush (the controller sends none).
`--no-heartbeat` runs the room without it, to compare.

**L1, eventually steady** (`room.checkLiveness`, `--liveness` or `--liveness-every N`, default off).
At every N-th depth, horizon or quiet leaf of the deepest level (after the leaf check; a shallower level only repeats those), a fair drain of the clock and the
beats, with no new faults and H ignored, must reach a steady pair (both PCs connected and stable, the
channel open, nothing left but the clock, beats and faults) within 90 s of fake time from the leaf
(answerWaitMs 30 s, the stranded re-offer's 30 s, backoffMaxMs 20 s, and a margin). The bound counts
from the leaf, not from the last fault: the search's own prefix is unfair (it may hold a frame while the
clock runs), and fairness starts at the drain. A miss is an L1 finding at the leaf's last label. Its
detail is the stuck shape (each side's actor region, away mark, PC and channel, no times), so one
shape is one finding; the witness's `evidence` holds the fixed point: actor budgets and open
commands, Mesh's connection fields, each side's last beat, the armed timers and the last fault. A
replay of an L1 witness runs the check after its labels. The drain does not stop early on a fixed
point: the supervisor's rules are time comparisons with no timer of their own (the stranded re-offer
fires at yieldedAt + 30 s), so only the bound is sound.

#1562 (`a`'s rejoin offer refused by its own setLocalDescription) is fixed by the actor's connect-by
deadline: every connection has one (connectBy = max(firstHeardAt, connectingSince) + 18 s), and a
connection not up by it is rebuilt as an offerer, whatever everConnected says. `mesh/liveness.test.ts`
reaches the shape with a `scenarioFrom` scenario with that rejection (`custom`) and checks it heals by
a connect-by-deadline rebuild before the controlled PC's ICE timeout (`pc:<id>:ice-timeout-failed`).
L1 has no known gap.

L1 also checks the actor's recovery invariant at every step of its drain, as the D monitor does after
every search step: an open actor whose link is not connected holds the deadline its link recovers by
(connectBy, graceBy, strandedBy or unansweredBy), unless a named exemption holds it (hidden, said away,
the presence gate, a failed PC, an ever-connected link-down that reads connecting again). One function,
`missingRecoveryDeadline` in `lib/state-machines/peer-actor.ts`, serves both.

Measured on the same shared server on 31 Oct 2026 (F = 2, H = 120 s, `--dedup`, 2 workers, the box
shared with other runs):

| run | leaves at the deepest level | L1 |
|---|---|---|
| steady d = 8, with and without the beat | 23,688 both | - |
| after-reload d = 7, with and without the beat | 20,561 both | - |
| mid-glare d = 6 (the anchor sits at t = 22 s, so beats are due), with / without the beat | 24,775 / 23,774 (+4.2 %) | - |
| steady d = 6 `--liveness` | 2,974 | 2,147 leaves checked, all steady; 12 ms and 25 drain labels a leaf |
| after-reload d = 6 `--liveness` | 7,345 | 6,019 checked, all steady, clean |
| after-reload d = 6 `--liveness --no-heartbeat` | 7,345 | 1,055 stuck, 4 L1 findings (the room artefact the beat removes) |

- **The beat barely grows a tree where it is due** (mid-glare, +4.2 % at d = 6, clean, its 1/100 dedup
  check passing), **and not at all from steady or after-reload.** Those two anchors sit at t = 1 s, and a side's first beat is due
  8 s after its session opened, about nine clock steps on, so `hb` enters a search only past d of
  about 10. Where it does, it is at most one label per side per 8 s of fake time, and only at a
  signalling-quiet point. If it grows a deep tree too much, the bound to add is to offer it only when
  it changes something: the peer's presence is older than one beat, or a description or hello was lost.
- **L1 costs about 12 ms a checked leaf** (worst under 100 ms: a stuck leaf runs the full 90 s, about
  110 labels). It is opt-in; `--liveness-every N` samples.

## Reading a report

Each run writes `test-results/explorer/<stamp>-<machine>/` (or `--out`):

- `summary.md`: the verdict line, the number of findings, the known gaps met, and per depth: leaves,
  mean enabled labels, the cut counts and the time.
- `report.json`: the same with every finding (property, labels, step, detail), `source` (the
  scenario, schedules per second, the witness files) and `knownGaps`.
- `witnesses/*.json` (per shard under `shard-<i>/` when sharded): one replayable label list per
  finding. `--replay` re-runs one; `--emit-test` prints a vitest file for `lib/webrtc/`.
- `self-test.json`: each mutant's five checks (below), with its witness under `self-test/witnesses/`.

The cuts: `depth` (the bound), `faults` (a fault label offered after F was spent), `horizon` (only a
timer past H was left), `quiet` (nothing enabled), `seen` (an equal fingerprint was already expanded
with at least as much remaining depth), and `harness` (a quiescence, fingerprint, sampled dedup replay
or label error: that schedule proves nothing, and the depth with one does not count as closed).
With dedup, each level also reports `expanded` (keys stored) and `seen`. A `seen` cut counts as a leaf
for report offsets and still harvests known gaps on its own prefix, but it does not run the sampled
leaf check because its kept twin already did.

**Known gaps** (`mesh/known-gaps.ts`) are differences already filed, each with its issue. A monitor
that matches one reports it as that gap, never as a violation. The verdict line stays
`clean at d = …, F = …, H = … (…)`, and the summary's next lines list each gap met, as
`Known gap #<issue> (<property>, not a violation): <detail>; <n> schedules` (or `<n> distinct states`
when dedup is on). Without dedup, n counts the
deepest level's schedules that met it. With dedup, n counts distinct room fingerprint states instead,
so converged schedules do not inflate the diagnostic. Read such a verdict as clean
except the gaps listed under it; a report never says clean without them. The list is currently empty:
P4, which compared Mesh's copies of the actor's times with the actor's, was retired when Mesh stopped
keeping those copies.

## Deep searches from anchors

A game is hundreds of actor events, and a search from the start closes only about d = 7. Bugs live in
the short window after an unusual moment, so the search also starts from **anchors**: named stable
positions of fair runs, and goes deep from there.

```bash
npm run explore -- --machine peer-actor --anchor network-changed --depth 7    # one anchor, hashed keys
npm run explore -- --machine peer-actor --anchor all --depth 6                # every anchor, one merged report
npm run explore -- --machine peer-actor --anchor all --candidates --depth 3   # phase B over the anchors' union graph
npm run explore -- --machine mesh-pair --scenario after-reload                # one room anchor
npm run explore -- --machine mesh-pair --anchor all                           # every room anchor
```

- **Peer-actor anchors** (`actor/anchors.ts`): each is a prefix of real alphabet keys walked from
  `initialWorlds`, as the fair runs are. The committed fixture `actor/anchors/<name>.json` is that walk's
  world with the commit it was captured at (`sourceSha`). F counts faults **past the anchor**: a prefix
  may spend faults (a reload, a network change), and the world starts the search with the search's own F.
- **Mesh-pair anchors** (`mesh/anchors.ts`): a warmup of real enabled labels on a base scenario, in
  `mesh/anchors/<name>.json`. Every schedule replays the warmup after its reset (as the mutant self-test
  does), the depth counts labels past it, and the room gets the warmup's faults on top of F. A witness
  holds the warmup and its own labels under the base scenario, so `--replay` re-runs it as any other.
- **Refreshing.** `lib/explorer/anchors.test.ts` walks every prefix and replays every warmup again, and
  fails with "refresh anchor <name>" when a fixture no longer matches (a field added or removed, a step
  that changed). Recapture with, from apps/jollity-app,
  `EXPLORER_CAPTURE_ANCHORS=1 npx vitest run --config vitest.explore.config.ts lib/explorer/anchors.test.ts`,
  and commit the fixtures.
- **Several anchors** run one process each, one after the other (a fresh heap each, so one that runs out
  of memory does not take the rest), under `<out>/<anchor>/`, then one merged report: `report.json` and
  `summary.md` over all, and `anchors.md` / `anchors.json` with one row per anchor (closed depth, states,
  cuts, violations, witnesses; for peer-actor also the peak RSS and heap, bytes per state, the growth
  per layer and the projected states and heap of one level deeper). The exit code is the worst of the
  anchors' (4, 1, 2, 3, 0 in that order); a capped anchor is exit 3 at its closed depth.
- **A peer-actor finding** is written to `<out>/witnesses/peer-actor-<anchor>-<n>.json` with its labels
  from the start: the anchor's prefix, then the path. `walk(initial world, labels)` (actor/bfs.ts)
  replays it, with a fault budget that covers the prefix's faults too.
- **`--candidates` with `--anchor`** runs one full-key search per anchor in one process, merges the
  graphs by node key and rebuilds the simplification candidates (`actor/candidates.ts`) over the union; every line's bounds name each anchor
  it was searched from, with that search's depth. Full keys cost far more memory than hashed ones, so
  run it shallower than the deep runs.
- **Memory.** The BFS frontier holds whole worlds, so memory follows the widest layer. Set
  `NODE_OPTIONS=--max-old-space-size=<MB>` and pass `--max-states` above the default 2,000,000, or every
  deep run stops at the cap.

| anchor | from | the position | room anchor |
|---|---|---|---|
| steady-initiator | initiator | connected and steady mid-round: the fair run (statement offer answered, channel open, lane offer answered, frames advancing), then the peer heard | steady |
| steady-answerer | answerer | the same, from the answerer's side | steady |
| round-changed | initiator | just after a round change on a steady link | none (the room has no round label) |
| peer-reloaded-initiator | initiator | just after the peer reloaded (a new session): the connection replaced, about to offer again | after-reload |
| peer-reloaded-answerer | answerer | the same, waiting for the new session's offer | after-reload |
| rejoin-queued-offers | answerer | the peer reloaded, its first new offer is being applied, another can still arrive (#1385's shape) | rejoin-queued-offers |
| away-and-back | initiator | the peer said it was away and came back on the open channel | none (no away label) |
| hidden-and-shown | initiator | this phone hidden more than 8 s and shown again: the kick's sweep has run | none (no visibility label) |
| network-changed | initiator | after a network change: its ICE restart resolved, the link recovering | none (the room's `network-all` is a change on both phones, not one side's restart resolved) |
| camera-off-on | initiator | our camera went off and came back on, the peer's video still advancing | none (no camera label) |
| mid-glare | room only | both phones have an offer in flight: a's first offer waits undelivered, b's supervisor times the link out (about 22 s), rebuilds and offers too; no fault | mid-glare |
| half-open | room only | one side connected, the other negotiating: after b's reload a still reads connected on its old PC, b's new PC has applied a's stored offer | half-open |
| mid-rebuild | room only | a rebuild under way: after b's reload a hears the new session, replaces its connected PC, and the new PC's offer is in flight | mid-rebuild |
| lost-signal | room only | b's answer to a's first offer dropped (one fault), a still in have-local-offer, the clock two ticks on | lost-signal |
| network-all | room only | a network change on both phones at one instant on a steady pair (two faults): each side's repair issued, nothing negotiated yet | network-all |

The room anchors (on `rejoin-two-offers`, whose env labels are `env:reload:b`, the capture and `env:network:<side>`, except `ice-failed` and `ice-disconnected`):
`steady` (the fair scheduler from the start until both links are connected and stable with the channel
open and only the clock and faults are left: 21 labels), `after-reload` (steady, then `env:reload:b`) and
`rejoin-queued-offers` (M1385's warmup, held by its `twoOffersDeliverable` precondition), and four
of the room's own: `mid-glare` (from the start, the clock run until b's supervisor rebuilds, then b's
offer: 32 labels, 24 of them `clock:next`, so about 24 s of H is spent), `half-open` and `mid-rebuild`
(after-reload plus 3 and 4 labels; the benign network connects a matched pair together, so a reload is
the only way one side reads connected while the other negotiates) and `lost-signal` (12 labels, one
drop), and `network-all` (steady, then `env:network:a` and `env:network:b`: 23 labels, two faults, the
abstract room's `network-all` moment on one pair). The room has no label for a round change, an away
mark, the page's visibility, an ICE restart or the camera, so those anchors are actor-only. Its ICE-failure label (`env:ice`) lives
only in the `outage` scenario (below), whose two anchors are `ice-failed` and `ice-disconnected`
(steady, then `env:ice:a:failed` or `env:ice:a:disconnected`: 22 labels, one fault).

### Anchor runs on 29 Oct 2026

On a shared server (16 cores, 62 GB, shared with another deep mesh search), before five actor fields
were removed (#1480; the anchors are recaptured since, so state counts and bytes per state will move).
Peer-actor, hashed keys, F = 1 past each anchor, one process per anchor; bytes per state is the heap
in use at the end of the last layer (no forced GC) over the states, so approximate; the projections
assume the last layer's growth holds.

| anchor | closed d | states | time | peak RSS | bytes/state | d = 7 projected | d = 8 projected |
|---|---|---|---|---|---|---|---|
| steady-initiator | 6 | 1,915,957 | 433 s | 2.4 GB | 1,272 | 15.4 M, 18 GB | 123 M, 146 GB |
| steady-answerer | 6 | 1,657,869 | 414 s | 2.1 GB | 1,301 | 13.0 M, 16 GB | 102 M, 123 GB |
| round-changed | 6 | 1,923,756 | 495 s | 2.4 GB | 1,244 | 15.4 M, 18 GB | 123 M, 142 GB |
| peer-reloaded-initiator | 6 | 527,051 | 108 s | 0.8 GB | 1,375 | 3.6 M, 5 GB | 24 M, 31 GB |
| peer-reloaded-answerer | 6 | 307,900 | 66 s | 0.5 GB | 1,366 | 1.9 M, 2.5 GB | 12 M, 16 GB |
| rejoin-queued-offers | 6 | 578,471 | 118 s | 0.8 GB | 1,321 | 3.8 M, 5 GB | 25 M, 30 GB |
| away-and-back | 6 | 1,931,947 | 557 s | 2.5 GB | 1,262 | 15.6 M, 18 GB | 126 M, 148 GB |
| hidden-and-shown | 6 | 2,145,185 | 755 s | 2.9 GB | 1,328 | 17.7 M, 22 GB | 145 M, 180 GB |
| network-changed | 6 | 3,033,744 | 982 s | 4.0 GB | 1,323 | 26.4 M, 33 GB | 229 M, 282 GB |
| camera-off-on | 6 | 1,858,187 | 659 s | 2.4 GB | 1,257 | 14.8 M, 17 GB | 117 M, 137 GB |

All ten clean at d = 6 (exit 0); new states grow x6.3-8.7 per layer. d = 7 fits this box for every
anchor (network-changed needs about 33 GB of heap); d = 8 fits only the reload and rejoin anchors
(16-31 GB) and needs 120-280 GB for the others. The full-key union for `--candidates` at d = 5 over all
ten anchors: 1,746,480 states, 3,554,654 edges, 6.4 GB RSS, 20 minutes, no invariant violations.

Mesh-pair (before the old decision path was removed: `--flag both`), d = 8, F = 2 past each anchor, H = 120 s, 7 workers (1.5 GB each; 6 GB for after-reload):

| anchor | exit | closed d | leaves at d = 8 | finding |
|---|---|---|---|---|
| steady | 0 | 8 | 153,660 | none |
| rejoin-queued-offers | 1 | 8 | 444,285 | before #1500: P1b on both flags and two P4 variants on flag on (below) |
| rejoin-queued-offers, after #1500 (7 x 6 GB) | 0 | 8 | 445,188 | none, both flags, 22 min; known gap #1458 (stranded-offer-refused: actor never in 127,221 schedules, actor earlier in 928), flag on. The proof that #1500 holds |
| after-reload | 0 | 8 | 539,656 | none; known gap #1458 in 106,314 schedules (flag on). At 1.5 GB per worker two shards ran out of heap; at 6 GB it ran in 38 min |

**The rejoin-queued-offers finding** (unmutated code, both flags, no fault past the warmup): M1385's
warmup, then `wire:a>b:wire-3:deliver`, `wire:a>b:wire-5:deliver`, `clock:next`, `clock:next`,
`pc:b/2:srd:resolve`, `pc:b/2:srd:resolve` gives P1b, "b/2 resolved offers from a/1 and a/2". It is 16
labels long; the self-test's unmutated check (3) searches the same warmup only to 14. Flag on also
reports P4 `lastAttemptAt` disagreements on the replace causes offer-refused-rejoin and
stranded-offer-refused, which known-gaps.ts does not match (#1458 matches only its own wording). Each
replayed with `--replay` (exit 1). P1b is #1499 (fixed by #1500); the P4 pair is #1458 at its second site
(peer-actor.ts:930) and at the original site on a later attempt. known-gaps.ts listed all three as
`exact` entries (the whole P4 difference, the whole P1b detail). #1499's entry was removed when #1500
merged, and the rerun above is clean without it. The mutant self-test and a mutant witness's replay
judge with no known gaps (`knownGaps: false`), so a gap that shares a mutant's wording (as #1499's
shared M1385's) cannot blind it.

## The abstract multi-phone room

`room/` searches three phones at once. It is built on the pure actor, not on Mesh: each phone holds one half per peer, a
real `ActorWorld` stepped by the real `stepPeerActor`, plus the phone's one runner FIFO; the room owns
the clock and the fault budget. Remote facts are caused, not free: a description arrives only when
the other phone's actor published it (per-pair statement slots and lane frames), a peer is heard only
when its hello is read, a reload reaches a peer only through the new session on its hello, and a link
comes up only when both current connections hold each other's current descriptions. Every caused
fact is built by the actor alphabet's own entry; when the entry refuses a fact the transport says is
real, the room builds Mesh's event itself and counts an **inclusion gap**. Frames carry the sender's
connection (session and epoch), and each receiving half keeps the connection its PC accepted, the offer
it is answering and the connections the peer left: Mesh's newSessionOver after #1500. The room
re-implements two pieces of Mesh effect code: newSessionOver, and `meshStatement` (model.ts), onRtc's
own steps for a statement description the alphabet refuses. Keep both in step with mesh.ts.

Statement frames also carry the transport's generation, as `statementTransport.ts` does: an offer mints
`${sid}.${offers}` (the room keeps the offering phone, its session and its offer count), and an answer
echoes the gen of the offer it answers. Each half keeps the transport's outgoing gen toward its peer
(its last offer's, or the one it last answered), cleared by a reload and when it admits the peer's new
session (resetNegotiation). An answer whose gen is not that outgoing gen is read and dropped before Mesh,
as `dispatchDirected` does: it admits the sender's session and nothing else, with no markSeen and no
onRtc. So newSessionOver and meshStatement only ever see answers that pass the gate, as in Mesh. Before
this gate the room delivered a reloaded page its peer's stored answer to the old page's offer, the
"answer with our local offer on no wire" inclusion gap (65,283 hits on the reload run at d = 5); with it
that class reads 0, and the reload run at d = 5 holds 586,390 states (663,043 before).

```bash
# from apps/jollity-app; skipped unless ROOM_RUN is set
ROOM_RUN=reload ROOM_DEPTH=4 ROOM_MAX_STATES=30000000 ROOM_OUT=/tmp/room-d4 \
  NODE_OPTIONS=--max-old-space-size=8192 \
  npx vitest run --config vitest.explore.config.ts lib/explorer/room/room.explore.ts
NODE_OPTIONS=--max-old-space-size=4096 npx vitest run --config vitest.explore.config.ts lib/explorer/room/room.test.ts
```

- **Runs:** `reload` (steady-3 from the fair scheduler, then p2's reload) or `network-all` (steady-3,
  then a network change on every phone at one instant). F counts faults past that moment. Knobs:
  `ROOM_FAULTS`, `ROOM_HEAP_STOP_MB` (default 7000: a clean stop before an out-of-memory kill),
  `ROOM_INCLUSION_EVERY` (default 100), `ROOM_PROBE_EVERY` (default 1000). Each finished layer is
  appended to `<out>/layers.jsonl`; `<out>/summary.json` holds the rest, with every finding's labels
  from the start (`walkRoom(initialRoom(3, 99), labels)` replays one).
- **Key:** each half is `canonical()` after per-field saturation (each time field saturates at its own
  largest threshold); a pair's key text (both halves, the room-side extras, the transport
  between them, every id and session relative) is interned by a 128-bit hash; the room key is ten
  UTF-16 code units of interned ids and faultsLeft. No symmetry reduction: the full room has none.
- **Frontier:** no world is kept. A node is rebuilt by replaying its labels from the anchor, with the
  previous path cached, so a visited state costs its packed key and two typed-array slots.
- **Checked:** peer.definition's invariants on every actor step; RP1/RP2 (a label changes only the
  halves it names), RP3 (phone consistency at quiet states), RP4 (roles; no statement offer from an
  answerer without its leave), RP6 (one connection applies descriptions from two remote connections),
  RP7 (with no fault past p2's reload, a pair without p2 never restarts or rebuilds, stats-driven heals
  apart), RP10 (sampled: the fair continuation with no faults brings every pair back to steady within
  60 steps per pair or 90 s); and the inclusion check, sampled: each half's sub-step must be the
  actor explorer's own successor from the projected world.
- **Not modelled:** the bundle, candidates, the offer counter's ordering gates (the
  last-adopted offer, one delivery per gen; only a gen's identity is kept, for the answer gate), the heartbeat (a hello
  is re-readable at any time instead), SESSION_SILENT_MS; the phone labels hide/show, camera, round,
  roster and standby; ICE beyond "up when matched" (an ICE restart always works; a network change
  breaks no link by itself); the channel closing alone; superseded lane offers (a test-only hook).
- **The codec guard (#559)** is modelled: each phone's engine is RTX-safe or not, fixed at its start
  (`initialRoom`'s `rtxUnsafe`, or `ROOM_RTX_UNSAFE=0,1`; default all safe). On an unsafe phone a pending
  lane offer may take `h:<i>><j>:codec-guard-rtx` (a choice, not a fault: whether the offer carried RTX
  is the browser's), and the room settles the guard's rollback, its stripped offer and then the guarded
  offer in Mesh's order, with one lane frame. `room/codec-guard-mesh.test.ts` replays a guard trace on
  real Mesh (`ExploreRoomOptions.rtxOffers`), with a safe-engine control.
  `model.ts` lists every actor key as half-local, caused or dropped (`HALF_LOCAL`, `CAUSED`, `DROPPED`).
- **A finding is abstract and unconfirmed** until real Mesh confirms it. The room's one finding so far needs
  only two phones: after a reload, a refused rejoin statement offer leaves the pair down for good (RP10),
  #1562. The actor's connectBy heals it in the room, so `room/mesh-confirm.test.ts` now checks the archived finding no
  longer projects onto a pair.

### Confirming a finding on real Mesh

`room/to-mesh.ts` takes a room finding and confirms it on the two-phone mesh-pair room with no hand edits. A room run does this for every
finding: `summary.json` gives each one a `confirm` field and the run `confirmCounts` (`ROOM_CONFIRM=0`
skips it). The steps:

1. **Project.** An n-phone finding is replayed in a 2-phone room with only its failing pair's labels (the
   pairs RP10's detail names, or RP6's phone pair). A label no longer enabled is skipped unless it is a
   fault. If no pair still shows the property, the verdict is `abstract-3`.
2. **Skeleton.** The projected faults in order, each with its mesh-pair counterpart (the fault table in
   `counterpart`) and the shape (`actor/shape.ts`) of the last event its half accepted before it, sweeps
   and stats left out. Room phone `lo` of the pair is `a` (the initiator), `hi` is `b`.
3. **Start.** mesh-pair's `after-reload` anchor when the first fault is `ph:1:reload`, else `steady`. A
   network change `ph:k:network` is `env:network:<side>`. On Mesh the `after-reload` anchor still has
   the pre-reload offer of a in flight and in the room it does not, so a refutation over it reads as a
   translator defect.
4. **Scenario.** `scenarioFrom()` (`mesh/scenarios.ts`): the anchor's scenario plus exactly the rejections
   and env labels the skeleton needs, passed as `exploreRoom`'s `custom`. `SCENARIOS` is never changed.
5. **Drive.** The fair scheduler; a fault is taken when its counterpart is enabled and its side's last
   accepted event has the recorded shape. After a completion rejection Mesh must report the abstract
   site and reason, or the skeleton was not realised (`unconfirmed`).
6. **Judge** once the link is steady and settled, or after 200 fair clock steps past the last fault: RP10
   is `steadyLink`, RP6 is a P1b violation. A control run from the same anchor with no fault must reach the
   first fault's moment (its counterpart enabled and the recorded shape last accepted) and must not show
   the property.

| Verdict | Meaning |
|---|---|
| `confirmed:mesh-pair` | Mesh shows the property and the control does not |
| `refuted` | the skeleton was realised and Mesh does not show it. `model defect` when every accepted-event shape each room half saw before the last fault appears in order among those its Mesh side accepted from the anchor to that fault (Mesh may accept more in between), `translator defect` otherwise, with `why` and `prefix` naming the side and the first shape Mesh never accepted. A gap in the model or the translator to record, never an issue against the app |
| `not-confirmable` | a fault with no mesh-pair counterpart yet (`ph:0:reload`, a wire drop until #1525, a restartIce rejection, an ICE drop, a rejection Mesh classes otherwise); `why` names it |
| `abstract-3` | projected onto its pairs, the finding needs the third phone |
| `unconfirmed` | no mesh judge for the property yet (only RP10 and RP6 have one), the witness does not replay, the skeleton was not realised, or the control fails too |

`room/to-mesh.test.ts` holds the pipeline's own proofs, with an actor mutant planted under both the room
and Mesh's runner (one `vi.mock` of `peer-actor`). Since the connect-by deadline the #1562 skeleton heals,
so the proofs that need it also plant an everConnected gate on connectBy (the mutation probe "keep the
everConnected gate on connectBy"):
- **mutant runs on Mesh:** a rejected hard-SDP statement offer that wedges the actor makes the room stuck
  when phone 0 hears phone 1's new session and its replacement connection's offer is then refused
  (the clean room recovers there). Mesh with the mutant stays down, the test checks that it decides
  otherwise than the real actor under Mesh's runner, and the identical plan on clean Mesh recovers;
- **refuted:** "exclude timeout-away from supervision" in the room only, with b's PC refusing the rejoin offer as a virgin PC: the
  room says the pair stays down, real Mesh recovers, and the pipeline names it a translator defect: on Mesh,
  b refuses the pre-reload offer of a before a hears the new session. Every supervisor mutant the room catches on that
  schedule is refuted with the mutant on Mesh as well;
- **not-confirmable:** a lost frame (`w:*:drop`): mesh-pair sends no presence hellos after the first
  (#1525), so its supervisor's presence-gated re-offer never fires there and a drop never recovers;
  a `network-all` witness with a rejected restart
  choice names `choice:0:rejected`; **abstract-3:** #1562's finding read as pair 0-2's;
- **network-all:** a witness's anchor (`ph:k:network` on every phone) projects onto its pair as
  `env:network:a` then `env:network:b` from mesh-pair's `steady`, and the control sees that moment at the
  anchor itself.
`room/findings/1562.json` is the reload run's #1562 finding; when `room/model.ts` changes and it no
longer replays, recapture it from a `ROOM_RUN=reload ROOM_DEPTH=3 ROOM_PROBE_EVERY=1` run's
`summary.json`.

### The room as a tiled map on disk

`room/tiled.ts` runs the same search with the visited set and the frontier on disk, so a run is bounded
by the disk, not the heap. The state space is cut into T tiles (default 1024 for a new run) by
the state's 128-bit id (`stateIdOf` in key.ts: hash128 of the pair hashes, the phone texts and
faultsLeft; pair identity already rests on hash128, so this is one more layer of the same assumption).
Per tile: one file of explored ids per depth, and an inbox per depth and writer of `(id, path)` records,
where the path is the position of each label in its parent's `candidateLabels()` (two bytes a step). A
worker process takes a tile, loads its explored set, drops every inbox record already explored, keeps
the least path per new id (the in-memory BFS's first-found path: its frontier is in exactly that order,
so the room expanded for an id is the same room), rebuilds each new state by replaying its path, runs
the same checks and sends every child to its own tile's inbox for the next depth. Depths run one at a
time with a barrier between them, so the layers are bfs.ts's.

```bash
# from apps/jollity-app; re-running the same command on the same --out resumes
npx tsx lib/explorer/room/tiled-main.ts --run network-all --depth 9 --out /path/to/run --workers 4 --tiles 256
```

- **Commit and resume.** A tile's children are appended to its writer's files, then one journal line
  records that writer's file lengths and the tile's counts: that line is the commit. A worker that dies
  is cut back to its last line and respawned, and its tile is done again; a killed run restarts from the
  files (the finished depths' markers, then each writer's journal). A tile at depth d reads only the
  explored files below d and writes its own whole, so doing a tile twice changes nothing.
- **Extend.** A finished run given a deeper `--depth` on the same `--out` continues from its bound: the
  bound's new states were kept as each tile's frontier file, an extension stage (`d00Nx` in the journal
  and progress) expands them into the next depth's inbox, and the next depths run over the same explored
  sets, so no depth is computed twice. A run resumes or extends only with the bounds it started with and
  the same key format: meta.json holds key.ts `ROOM_KEY_FORMAT` and the anchor's state id, and anything
  else is refused (start a new `--out`). Bump `ROOM_KEY_FORMAT` whenever a key text changes.
- **Samples.** bfs.ts samples RP10 and the inclusion check by discovery order, which a tiled run cannot
  see. `ROOM_SAMPLING=key` (bfs.ts `sampling: "key"`) picks them by state id instead, as tiled.ts does;
  with it the two agree on every count (`tiled.test.ts`, and the runs below).
- **Output.** `<out>/progress.jsonl`, one line per depth: `states`, `added`, `distinctPairs`, tile sizes,
  phase time, peak worker RSS and heap, disk, and `edgeReached`: a depth that adds no state means the
  reachable set is closed, the strict answer to "are we done". `spreadToNext` says how one tile's children spread
  over the next depth's tiles (mean distinct child tiles per source tile, and the share landing in the
  source's own tile index: about 1/T, since tiles are a hash). `<out>/summary.json` holds the rest.

## The mutant self-test

Each mutant (`mutants/<id>.json`) re-introduces a fixed bug as hunks on its real runtime path in
`lib/webrtc/mesh.ts` (ML1: `lib/state-machines/peer-actor.ts`). The loader writes the mutated text to a gitignored sibling copy, prepends a
hit counter to each replaced statement, resets the module graph and mocks the target onto the copy.
A `find` that does not occur exactly once is refused with "refresh mutant <id>" (exit 2).

A **gating** mutant counts as found only when all five checks pass:

1. **Precondition.** The warmup (real enabled labels) replays on the unmutated room, and the named
   predicate in `mutants/preconditions.ts` holds after it.
2. **Hunk hit**, in two parts, counted past the warmup: (2a) the violating
   schedule ran at least one hunk, and (2b) every hunk ran in some schedule of the mutant's search.
   One violating schedule cannot run every hunk of these mutants: M1374s's hunks are
   the catch and the normal return of one effect, and M1385's P1b trips at the second SRD, before
   `b`'s answer reaches its second hunk. Since #1500 the M1385 mutants carry a third hunk that undoes
   that fix's guard too (newSessionOver reading the answering entry's session): without it the
   mutated code still rebuilds for the second session's offer, and the self-test went blind. `self-test.json` keeps both counts per hunk
   (`hits.witness`, `hits.search`).
3. **Fixed clean.** The witness's labels on the unmutated code trip none of its `mustTrip`
   properties, and neither does the same warmup-seeded search with no mutant, at the spec's bounds
   (`fixedSearchLeaves`). The unmutated code may stop taking the witness's labels earlier (M1385's
   barrier holds `a/2`'s offer, so the second SRD is never enabled); that is recorded as info.
4. **Mutated red.** The search, enumerating from the warmup within the spec's bounds, finds a
   `mustTrip` violation. `bounds.depth` is the whole schedule's length, warmup included.
5. **Replay.** The witness replays to the same violation.

The mutants:

| mutant | gating | scenario | warmup ends | must trip |
|---|---|---|---|---|
| M1385-on | yes | rejoin-two-offers | the same | P1b or P1 |
| M1374s | yes | single-offer | `b` has an open send-answer | P2 |
| M1385b | no | rejoin-two-offers | the same as M1385 | P1 |
| ML1 | yes | rejoin-two-offers | the after-reload anchor (`b` just reloaded) | L1 |

ML1 is the liveness mutant (target `lib/state-machines/peer-actor.ts`): the actor's common connection
replacement helper advances nothing and emits no `replace-connection` command. The reload, the
controlled-PC ICE timeout and connect-by recovery can all decide to replace, but none can reach Mesh,
so the pair never heals. No safety monitor sees it (P1, P1b and P2 stay quiet); L1 catches it from
the after-reload anchor. Its spec allows no fault past the anchor, so check 3's unmutated search stays
L1-clean. Disabling the stranded re-offer instead is masked: the
heartbeat re-announces a lost rejoin offer or answer within a beat, so the 30 s yield and the
stranded re-offer never run in that tree (5,719 leaves, one fault past the anchor, L1 clean at every leaf).

M1385b is reported only: its known red path needs an injected grant and an injected `restartIce`
(mesh/monitors/monitors.test.ts), which no real label gives. A reported-only mutant never changes the
exit code. It is promoted to gating in the PR that first finds it from a real prefix.

## Adding a scenario

1. Name it in `ScenarioName` (mesh/room.ts) and add it to `SCENARIOS` (mesh/scenarios.ts): its `env`
   labels (and `CAPTURE` for the transport's read-then-deliver copy), its `rejections` (op, class)
   pairs, a `setup` for a fixed prefix of real labels, and its `defaults` (F, H and a depth measured to
   close within the default budget).
2. Add it to spec.ts's `SCENARIO_NAMES` if a mutant will use it.
3. Show in mesh/room.test.ts that its labels are reachable, and in mesh/monitors/monitors.test.ts that
   every monitor is quiet on its happy paths.
4. Run it with `--depth` rising until the budget stops it, and write the depth that closes into its
   defaults and the table above.

When adding a monitor, set `closed: true` only when its verdict is determined by the room fingerprint
and projected per-side histories; put the one-line reason beside the declaration. Set it false when
it reads the global label path, the last label kind or any fact outside the key. The false declaration
intentionally makes `--dedup` refuse the run until the key or monitor design makes trace closure true.

## Adding a mutant

1. Write `mutants/<id>.json` (spec.ts validates it): the hunks (`find` text exactly once in the
   target, checked at `contextCommit`), the warmup of real enabled labels, a precondition name, the
   scenario, bounds, the properties it must trip and `gating`.
2. Add its precondition to `mutants/preconditions.ts` if none fits. It reads the harness's own logs
   and the enabled labels, never a Mesh verdict.
3. Add the id to `SLICE1_MUTANTS` and a test in `mutants/self-test.test.ts`.
4. A mutant whose precondition needs injected state is a defensive fixture: `gating: false`.

For adding another state machine (an adapter), see `machines/README.md`.
