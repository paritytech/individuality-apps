# The prize draw's wheel scene

These files are the prize draw's coin-and-slit wheel scene. **They are the code you
edit**: nothing generates them or copies over them.

- The files are written in a plain-JavaScript style of their own, and lint skips this folder
  (`eslint.config.mjs`). No type checker or linter reads them, so test a change on the
  prize-draw screen.
- Changes made for this app are marked with `JOLLITY:` comments. Mark new ones the same way.
- The CSS (`styles.css`, `tokens.css`) is scoped under `#app`.
- `../mount.ts` is the typed bridge from the app into this scene.
- The disc in the middle is wholly the page's ground: its edge's curve runs exactly 1 → 0 (#32).
