# Jollity lab

`opening/` retains the source-only new-person and reload lab. Its config stays
at `../lab.opening.config.ts`, and its tests stay at `../tests/lab`. Host route
validation and cleanup use the root lab's shared helpers; the host lock remains
0.27.0. `scenarios/` adds the Jollity-only B1-B6 plan through the root selector
`jollity-scenarios`, with transaction setup and explicit pending capabilities. See
[the scenario guide](scenarios/README.md).

From the repository root, run `npm run jollity:lab:check` for offline checks or
`PRODUCT_LAB_LAB=jollity-opening npm run lab` to launch the opening. See
[the root lab guide](../../../lab/README.md) for setup, ports and cache rules and
[opening/README.md](opening/README.md) for this lab's exports and provenance.
