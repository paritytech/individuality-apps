# Machine adapters: the checklist

The explorer searches the app's other state machines through one contract, `MachineAdapter` in
`contract.ts`. `exploreMachine` (explore-machine.ts) does a breadth-first search from the
adapter's normal initial states to a depth bound. `npm run explore -- --machine <name>` runs every machine
listed in `registry.ts`. A run is bounded evidence, never a proof: it reports the depth, and says whether
the frontier closed.

A machine that already has a framework definition (`lib/state-machines/<name>.definition.ts`) gets its
adapter from `fromDefinition`. `report-outbox.adapter.ts` is the worked example. Follow it step by step:

1. **One adapter file, `<name>.adapter.ts`.** Call `fromDefinition(<name>MachineDefinition, { traceMonitor })`.
   Do not edit the definition, `from-definition.ts` or `explore-machine.ts`. If a test fails because of
   one of those files, report it and stop.
2. **Find every invariant that reads `trace`.** In the definition's `invariants`, any `check` that
   destructures `trace` reads the whole history. Each one either:
   - is named in the monitor's `covers`, with a monitor that keeps exactly what the invariant reads; or
   - is listed in `excluded` with a reason, and then it is skipped and the report prints the reason.
3. **Write the monitor in the style of the existing adapters.** It needs `initial`, `step(m, entry)`, `key(m)` and
   `covers`.
   - `entry` is the framework's `TraceEntry`: `entry.real.commands`, `entry.real.state`, `entry.eventKey`.
   - Keep counters saturating (`Math.min(2, …)`), so the key stays small.
   - Equal keys must mean equal verdicts for every covered invariant, now and after any common suffix.
     Annotate the monitor's type (`initial: {…} as MyMonitor`, `step: (m: MyMonitor, entry) => …`) so it
     typechecks against the generic `fromDefinition`.
4. **One test file, `<name>.adapter.test.ts`**, with these tests:
   - **starts only from the normal start state.** `initial()` has one entry, labelled `start`, and it is
     the app's start value.
   - **enables the N event keys.** The sorted `enabledEvents` equal the transition table's row keys.
   - **explores to depth 8 with no violation.** `violations` is `[]`, and `frontierClosed ||
     depthCompleted === 8`.
   - **catches a planted bug.** `plantStaleReal(adapter, "<an event that changes the start state>")`
     gives at least one violation.
   - **the monitor covers the trace invariants.** `traceMonitor.covers` lists them, and `excluded` is
     empty unless step 2 listed one.
   - **is registered.** `MACHINES["<name>"]` is the adapter.
5. **One registry line** in `registry.ts`: `"<name>": <name>Adapter,` plus its import.
6. **Run it.**
   - `cd apps/jollity-app && npx vitest run --config vitest.explore.config.ts lib/explorer/machines/<name>.adapter.test.ts`
   - Then `npm run explore -- --machine <name> --depth 12`. Paste its verdict line (in `summary.md`,
     `clean at d = 12, …` or `inconclusive …`) into the PR body.

## What fromDefinition builds

- **The state** is the lockstep pair `{ real, model }`. Its visited key is the stable JSON of the whole
  pair plus the monitor's key.
- **The alphabet** is the row keys of the transition table at the start state. Representative event values
  come from the definition's own `realStep` and `modelStep`, which map each key to a concrete event.
- **`check`** runs the state-machine framework's `checkStep` (`lib/state-machines/framework`) on the edge the search actually took. The state keys must agree, the
  pair must be declared and match its declaration, the observations must agree, and every invariant that
  is not excluded must hold.
- **`initial()`** is `[{ label: "start", state: { real: initialReal(), model: initialModel() } }]`.
  `initialArbitrary` is never read: its states may be ones the app cannot reach.
- **The unreached cells** are the declared state × event pairs that the search never tried from a
  reached state. A long list is normal, because the flag matrix declares combinations the normal start
  never reaches.

## What a violation means

A violation is a finding about the definition or about the app, and either one is worth knowing. A
declaration mismatch can show that a state key is too coarse: one key held two behaviours. That happened
to report-outbox, whose countdown key now carries the restart bit.
- **Report it with the trace the report prints.** Never filter an event out of `enabledEvents`, catch a
  mismatch in the adapter, or list a declaration problem in `excluded`. `excluded` is for trace
  invariants only.
