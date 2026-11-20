# Cross-app runner and reports

`cross-app-ci.mts` plans runs, builds and verifies commit-keyed static app
outputs, runs one named scenario, cleans up owned root state, or summarizes
sanitized datasets. `cross-app-report.mts` renders the existing HTML and Markdown
timing report without posting it. Both scripts run from the repository root.

The workflow and local commands use the same entry points. Run the private
workspace's unit checks with `npm run lab:check`; see [../README.md](../README.md)
for commands, port ownership, measured timing boundaries and 14-day retention.
