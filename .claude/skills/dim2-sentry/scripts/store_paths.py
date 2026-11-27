#!/usr/bin/env python3
"""Where the local DIM2 telemetry store lives. Stdlib only.

The store is one folder per game under <root>/<network>/g<N>/, local only and
git-ignored. Root: $DIM2_TELEMETRY_STORE if set, else
<main checkout>/docs-internal/telemetry-store.

The main checkout is found with `git rev-parse --path-format=absolute --git-common-dir`,
NOT --show-toplevel: a worktree's toplevel is the worktree, and every worktree must
share the ONE store at the main checkout.

Temp and old folders start with a dot (.tmp-g<N>-<pid>-<epoch>, .old-g<N>-<epoch>) so
the store's `g*` glob never matches them.

One writer at a time per game: concurrent dumps of the same game are not supported.
"""
import functools
import json
import os
import shutil
import subprocess
import time

NETWORK = "paseo"

# Only the A4 recovery cases look at these; the glob must not match the real g<N> folders.
TMP_PREFIX = ".tmp-g"
OLD_PREFIX = ".old-g"
STALE_TMP_SECONDS = 3600


@functools.lru_cache(maxsize=None)
def main_checkout():
    """The main checkout's root, from any worktree of it. Constant for the process, so cached."""
    here = os.path.dirname(os.path.abspath(__file__))
    common = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=here, capture_output=True, text=True, check=True).stdout.strip()
    # --git-common-dir is <main checkout>/.git for both the main checkout and any worktree of it,
    # so the checkout root is its parent.
    return os.path.dirname(os.path.abspath(common))


def store_root():
    """The store root: the env var (read live), else <main checkout>/docs-internal/telemetry-store."""
    env = os.environ.get("DIM2_TELEMETRY_STORE")
    if env:
        return os.path.abspath(env)
    return os.path.join(main_checkout(), "docs-internal", "telemetry-store")


def usernames_path():
    """The shared account-to-username map, beside the per-network telemetry store."""
    return os.path.join(store_root(), "usernames.json")


def game_logs_root():
    """The shared main-checkout game-log root, independent of the current worktree."""
    return os.path.join(main_checkout(), "docs-internal", "game-logs")


def _root(root):
    return os.path.abspath(root) if root else store_root()


def game_dir(game, network=NETWORK, root=None):
    return os.path.join(_root(root), network, "g%d" % int(game))


def tmp_dir(game, network=NETWORK, root=None):
    return os.path.join(_root(root), network, "%s%d-%d-%d" % (TMP_PREFIX, int(game), os.getpid(), int(time.time())))


def old_dir(game, network=NETWORK, root=None):
    return os.path.join(_root(root), network, "%s%d-%d" % (OLD_PREFIX, int(game), int(time.time())))


def _hidden_dirs(parent, prefix, game):
    """The sorted names of the <prefix><N>-* folders inside parent for this game."""
    if not os.path.isdir(parent):
        return []
    want = "%s%d-" % (prefix, int(game))
    return sorted(name for name in os.listdir(parent)
                  if name.startswith(want) and os.path.isdir(os.path.join(parent, name)))


def _epoch_suffix(name):
    """The trailing epoch of a .tmp/.old folder name, or -1 when it is not numeric."""
    tail = name.rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else -1


def recover(game, network=NETWORK, root=None):
    """Run at the start of every dump. Returns the actions taken, each a line to print.

    - g<N> missing and a .old-g<N>-* present: rename the newest (largest epoch) back to g<N>;
    - .tmp-g<N>-* older than 1 h (age from the epoch in its name): delete it;
    - .old-g<N>-* while g<N> exists: delete it.
    """
    base = os.path.join(_root(root), network)
    final = game_dir(game, network, root)
    actions = []

    olds = sorted(_hidden_dirs(base, OLD_PREFIX, game), key=_epoch_suffix)
    if not os.path.exists(final) and olds:
        newest = olds[-1]
        os.rename(os.path.join(base, newest), final)
        actions.append("restored %s -> g%d" % (newest, int(game)))
        olds = olds[:-1]

    for name in _hidden_dirs(base, TMP_PREFIX, game):
        age = time.time() - _epoch_suffix(name)
        if age > STALE_TMP_SECONDS:
            try:
                shutil.rmtree(os.path.join(base, name))
            except FileNotFoundError:
                continue  # vanished between listing and removing
            actions.append("deleted stale tmp %s (age %ds)" % (name, int(age)))

    if os.path.exists(final):
        for name in olds:
            try:
                shutil.rmtree(os.path.join(base, name))
            except FileNotFoundError:
                continue
            actions.append("deleted old %s (g%d exists)" % (name, int(game)))

    return actions


def write_json(path, obj):
    """A JSON file in the store's one house style: indent=1, ensure_ascii=False, trailing newline.

    Stdlib only, so pyarrow-free scripts can import it. store_write re-exports it.
    """
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
