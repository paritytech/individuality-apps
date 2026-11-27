# Root lab checks

`check.mts` verifies the root package pin, private workspace, host locks and
vendored digests, then runs the lab plan checks. It
also dry-runs all five root selections, including their Cucumber child process,
so CommonJS/ESM loading and feature bindings are checked without starting a fork.
Reports stay in ignored root `.product-lab/root-check-plans/` state.

Run `npm run lab:check` at the repository root. This script uses the caller's
cache and flake-log environment; see [../README.md](../README.md). It exposes no
server or ports and never prepares tooling or downloads a bundle.
