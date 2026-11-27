# Shared lab helpers

These TypeScript modules serve Humanity scenarios and flows, Jollity's opening
and cross-app journeys. Chain plans, owned-target checks, fresh-copy and network
policies, host cleanup, app launch declarations and watched browser reads move
here unchanged. `paths.ts` anchors filesystem paths to the repository; product
session callbacks retain the app roots their commands use. Host locks remain in
the product openings: Humanity's (also read by the cross-app lab) pins CLI 0.31.0,
Jollity's still pins 0.27.0.

`upstream/` is the shared vendored dependency tree. Its source revisions,
adaptations and destination digests remain in Humanity's `lab/flows/UPSTREAM.json`.
The shared browser/network code opens only loopback routes; caller-owned session
and fork ports are unchanged. No process, cache or chain starts on import.

Humanity's existing flow/scenario tests exercise these exports; cross-app tests
live in `../cross-app/tests`. Run the commands in [../README.md](../README.md).

`name-funding.ts` funds the local PGAS name-link deposit for either lab, verifies the Asset Hub
root and issuer, and validates the inner `sudo_as` outcome. The caller passes its actor label, journal
name and optional receipt file; cross-app's `funding.ts` passes its own. `transactions.ts` holds the
receipt observer and writer both labs use; cross-app keeps a re-export at its old path.

`post-game.ts` owns the Jollity chest observation and results walk shared by the existing
flow/cross-app journey and Jollity scenarios. Humanity retains a re-export for compatibility.
Its browser read is inline so the browser-body guard can audit it. No gestures changed.

`ci-bundle.ts` pins one verified Paseo archive for either workflow and installs that exact
manifest into each leg's prepared Engine. Humanity's CI script re-exports its existing API;
its cache keys, classifiers and tests remain its own. Jollity's CI script uses the shared API.
Imports start no downloads. Bundle pin/install tests remain in Humanity's scenario test suite.
