# Diagram sources

The diagrams in [`../architecture.md`](../architecture.md). Three of them are
generated: each `journey-*.py` describes one sequence diagram top to bottom
and prints its SVG.

| File | What it is |
| :-- | :-- |
| `sequence.py` | The layout engine: lifelines, calls, returns, what the user sees, self-calls and `alt`/`opt`/`loop` fragments, laid out on a fixed step so a new message never collides with the next. `python3 sequence.py` prints a small sample. |
| `journey.py` | Fragments that nest inside each other, inset by depth, on top of `sequence.py`. |
| `journey-register-chat.py` | Registering from the chat. |
| `journey-notifications.py` | The game reminder and the notices the chat books. |
| `journey-player-process.py` | The payoff: the prize draw, the chest and the hand-off. |

They use the Python 3 standard library only: no packages to install.

## Regenerate a diagram

From the repository root, after changing its source:

```bash
python3 docs/assets/<name>.py > docs/assets/<name>.svg
```

Commit the source and the SVG together. Each source's docstring names the
code it draws, so check the diagram against that code when it changes.

`architecture.svg`, `journey-shuffle.svg` and `journey-reporting.svg` were
drawn by hand and have no source: edit the SVG
itself.
