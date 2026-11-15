# State-machine test framework

The framework runs a pure reducer and an independent reference model through
the same event sequence. Every step compares normalized observations and runs
every named invariant. Fast-check supplies shrinking and reproduction through
`SM_SEED` and optional `SM_PATH`; ordinary runs use a fixed default seed.

Each machine provides five things:

1. a reducer adapter and an independent model adapter;
2. one typed event-sequence arbitrary;
3. a complete typed state × event matrix;
4. named invariants linked to the governing spec clause;
5. typed deterministic witnesses and a named regression corpus.

The deterministic witnesses run before generated properties. Every transition
or explicit no-op outcome must be witnessed. Declarations are validated on
every step, and coverage is recorded as state × event × observed outcome.
Observing an impossible cell, an undeclared state/event pair, a declaration
mismatch, a model mismatch, or an invariant failure fails the suite. The
runner writes JSON to `test-results/state-machines/` and prints a compact
coverage table plus generated-sequence length statistics.

## Template

```ts
const definition: MachineDefinition<
  RealState,
  ModelState,
  Event,
  RealOutput,
  ModelOutput,
  Observation,
  StateKey,
  EventKey
> = {
  name: "outbox",
  initialReal,
  initialModel,
  initialArbitrary,
  realStep,
  modelStep,
  classifyRealStep,
  observeReal,
  observeModel,
  realStateKey,
  modelStateKey,
  eventKey,
  transitionTable,
  witnesses,
  regressions,
  invariants,
  sequenceArbitrary,
  numRuns: 300,
}
```

Run the suite with `npm run test:state-machines`. Reproduce a shrunk failure
with `SM_SEED=<seed> SM_PATH=<path> npm run test:state-machines` using the seed
and path printed by fast-check.

The focused `payoff-machine.test.ts` tests stay beside the definition for
readable edge cases. A generator for whole game sessions (a few hundred steps
per sequence: roughly 300 ticks, 24 boundary events and up to 60 taps) is not
part of this suite.
