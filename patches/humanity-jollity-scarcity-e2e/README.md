# Return-control observation patch

This is the already-vendored lab helper adaptation, now recorded with its missing manifest.
It adds an optional trusted-control observer; the product apps and runtime packages are unchanged.
`manifest.json` pins the upstream base, patch digest, source and destination digests, purpose and retirement condition.
The vendored copy is tracked in `apps/humanity-app/lab/flows/UPSTREAM.json`.
Verify the patch digest. The destination digest is the vendored file as it is now: this observer plus
the other adaptations its `UPSTREAM.json` row lists (for `results.ts`, the collecting-chest follow-up from #1822 and the long-wait wait for Jollity's chest state machine),
so applying the patch alone to the pinned source gives only the observer's part.
