// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A *flow* is one thing a person (or the worker on their behalf) is trying to
 * get done end to end — claim a username, finish Membership, register for
 * today's draw — reported to Sentry as one transaction with one trace, so a
 * failure three host calls and a chain read deep is still filed under the
 * story it broke, and its duration is the duration the person waited.
 *
 * Inside a flow:
 *  - `stage(name)` opens the next sequential child span and closes the one
 *    before it. The flow modules already narrate stages for the debug panel
 *    (`onStage`), so this is the same narration, timed.
 *  - `step(name, fn)` is a nested child span around one awaited call, for
 *    the places where stages overlap or fan out.
 *  - Host calls (`host-call-log.ts`), chain connects and reads
 *    (`connection.ts`, `chain-read.ts`) and transaction submissions
 *    (`transaction-submission.ts`) attach themselves to the current stage
 *    through `childSpan`, so a flow needs no code at those sites.
 *
 * Two ways to hold one. `runFlow` wraps one async function: the flow is the
 * call. `openFlow` hands the lifecycle to the caller for a story no single
 * `await` encloses — the card load runs from the script start through three
 * react-query hooks to a render commit — and the caller `finish`es it.
 *
 * The parent for those children is an explicit register, not the SDK's
 * active span: in a browser the active span is a scope stack with no async
 * context, which is right for one sequential flow and wrong as soon as a
 * stage span should be the parent. One register means two flows in flight
 * at once (the automatic Membership registration and a Daily Dollar
 * registration can overlap) file their host calls under whichever started
 * last. The child's own name says what it was; the flow it is under may be
 * the neighbour's. Accepted: the alternative is threading a span through
 * every host call signature.
 *
 * A flow's result decides its status: the caller classifies the return value
 * with `outcome`, and a thrown error is classified by its `code` (every
 * typed error in Humanity carries one) or its name. Only the status and
 * `flow.outcome` attribute are set here; the *event* for a failure comes from
 * the error-level log the flow module already writes (`sentry-sink.ts`), so
 * one failure is one issue, filed inside this trace.
 *
 * Without a DSN every call here is the SDK's no-op: `fn` runs exactly as it
 * would unwrapped.
 */
import { startInactiveSpan, startNewTrace, type Span } from "@sentry/browser";
import type { SpanStatus } from "@sentry/core";

/** Every user story this product reports. Add here first; the catalogue in
 *  `apps/humanity-app/docs/telemetry.md` is the reviewable list. */
export type FlowName =
  | "chain.connect"
  | "card.load"
  /** The same wait from the person's tap in Pocket (`card-load.ts`). */
  | "pocket.open"
  | "membership.promotion"
  | "username.claim"
  | "username.dotns"
  | "username.reservation-cleanup"
  | "daily-dollar.registration"
  | "daily-dollar.claim"
  | "coinage.top-up"
  | "pocket.render"
  /** The debug panel's hand-run probe: two stages, nothing read. */
  | "debug.probe";

export type FlowAttributes = Record<string, string | number | boolean>;

export interface FlowOutcome {
  /** Short, low-cardinality: `"registered"`, `"not-ready"`, `"refused"`. */
  readonly kind: string;
  /** False marks the transaction failed. A legitimate stop (`"not-ready"`)
   *  is `true`: the flow did its job, which was to find out. */
  readonly ok: boolean;
}

export interface FlowRun {
  /** Close the open stage, open the next. `name` must be stable text —
   *  pass `"sign"`, never `"sign for 5Fxx…"`. `startTime` (epoch seconds)
   *  backdates a stage that was already under way when the code that
   *  names it first ran — the boot, from the script start. */
  stage(name: string, startTime?: number): void;
  /** A nested timed span around one awaited call. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Attach more attributes to the flow once they are known. */
  set(attributes: FlowAttributes): void;
}

/**
 * A flow the caller finishes. Every call after the first `finish` is
 * ignored, so the hooks that narrate the card load need not agree on who
 * is last; the first terminal event wins.
 */
export interface OpenFlow extends FlowRun {
  finish(outcome: FlowOutcome): void;
  /** Finish as a thrown error would: failed, kind from its `code` or name. */
  fail(error: unknown): void;
  readonly finished: boolean;
}

export interface OpenFlowOptions {
  readonly attributes?: FlowAttributes;
  /** Seconds since the epoch; default now. `performance.timeOrigin / 1000`
   *  dates the flow from the script start, so the boot is inside it. */
  readonly startTime?: number;
  /** Do not take the register: children keep attaching to the flow that
   *  already has it. For a second transaction timing the same wait. */
  readonly detached?: boolean;
}

export interface RunFlowOptions<T> {
  readonly attributes?: FlowAttributes;
  /** Classify a returned value. Default: every return is `ok`. */
  readonly outcome?: (result: T) => FlowOutcome;
}

export interface ChildSpanEnd {
  (outcome: { ok: boolean; detail?: string }, attributes?: FlowAttributes): void;
}

const STATUS_OK: SpanStatus = { code: 1 };
const STATUS_ERROR = (message: string): SpanStatus => ({ code: 2, message });

/** The span new children attach to: the open stage, else the flow root,
 *  else nothing (no flow in flight). */
let parent: Span | null = null;

/**
 * Open a child span under the flow in flight, for the instrumented seams
 * that see every host call and every transaction. Outside a flow it opens
 * nothing: a background refetch is not a story, and an orphan span would be
 * reported as a transaction of its own.
 */
export function childSpan(op: string, name: string, attributes?: FlowAttributes): ChildSpanEnd {
  return childOf(parent, op, name, attributes);
}

function childOf(parentSpan: Span | null, op: string, name: string, attributes?: FlowAttributes): ChildSpanEnd {
  if (parentSpan == null) return () => {};
  const span = startInactiveSpan({ op, name, attributes, parentSpan });
  return ({ ok, detail }, more) => {
    if (more != null) span.setAttributes(more);
    // The serialised status only keeps a known status word, so the detail
    // rides along as an attribute where a reader can see it.
    if (!ok && detail != null) span.setAttribute("error.detail", detail);
    span.setStatus(ok ? STATUS_OK : STATUS_ERROR(detail ?? "error"));
    span.end();
  };
}

/** A thrown error's low-cardinality kind: its `code` when it carries one
 *  (`UsernameUpgradeError`, `RegisterDrawsError`, …), else its class. */
export function errorKind(error: unknown): string {
  if (error != null && typeof error === "object") {
    if ("code" in error && typeof error.code === "string" && error.code !== "") return error.code;
    if (error instanceof Error && error.name !== "") return error.name;
  }
  return "unknown";
}

/**
 * Open the flow `name` as a fresh trace and hand its lifecycle to the caller.
 * Children opened through `childSpan` attach to it until `finish`, or until
 * a flow opened later takes the register (see the module comment).
 */
export function openFlow(
  name: FlowName,
  { attributes = {}, startTime, detached = false }: OpenFlowOptions = {},
): OpenFlow {
  return startNewTrace(() => {
    const root = startInactiveSpan({
      name,
      op: "flow",
      forceTransaction: true,
      attributes,
      ...(startTime == null ? {} : { startTime }),
    });
    const enclosing = parent;
    let stage: Span | null = null;
    let finished = false;
    const closeStage = (): void => {
      stage?.end();
      stage = null;
      if (!detached) parent = root;
    };
    const flow: OpenFlow = {
      get finished() {
        return finished;
      },
      stage(stageName, stageStart) {
        if (finished) return;
        closeStage();
        stage = startInactiveSpan({
          name: stageName,
          op: "flow.stage",
          parentSpan: root,
          ...(stageStart == null ? {} : { startTime: stageStart }),
        });
        if (!detached) parent = stage;
      },
      async step(stepName, run) {
        const stepParent = detached ? (stage ?? root) : parent;
        const end = childOf(finished ? null : stepParent, "flow.step", stepName);
        try {
          const value = await run();
          end({ ok: true });
          return value;
        } catch (error) {
          end({ ok: false, detail: errorKind(error) });
          throw error;
        }
      },
      set(more) {
        if (!finished) root.setAttributes(more);
      },
      finish(result) {
        if (finished) return;
        finished = true;
        closeStage();
        root.setAttribute("flow.outcome", result.kind);
        // A read the caller abandoned (react-query re-keying a query, a
        // deadline the caller set) or a page put away mid-load is cancelled,
        // not broken.
        root.setStatus(
          result.ok
            ? STATUS_OK
            : STATUS_ERROR(
                result.kind === "AbortError" || result.kind === "abandoned"
                  ? "cancelled"
                  : result.kind,
              ),
        );
        root.end();
        // Hand the register back only if no flow opened after this one.
        if (parent === root) parent = enclosing;
      },
      fail(error) {
        flow.finish({ kind: errorKind(error), ok: false });
      },
    };
    if (!detached) parent = root;
    return flow;
  });
}

/**
 * Run `fn` as the flow `name`: a fresh trace, one transaction, children for
 * its stages. Returns or throws exactly what `fn` does.
 */
export async function runFlow<T>(
  name: FlowName,
  fn: (flow: FlowRun) => Promise<T>,
  { attributes = {}, outcome = () => ({ kind: "ok", ok: true }) }: RunFlowOptions<T> = {},
): Promise<T> {
  const flow = openFlow(name, { attributes });
  try {
    const result = await fn(flow);
    flow.finish(outcome(result));
    return result;
  } catch (error) {
    flow.fail(error);
    throw error;
  }
}
