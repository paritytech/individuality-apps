// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared machinery for the architecture rules. No rule talks to the filesystem:
// the allowlist and the "allowed here" paths both arrive as rule options, so
// the tests can exercise the exact code path the real config uses.
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The repo root, resolved from THIS file's location. `process.cwd()` is
 * wherever eslint was launched from — a worktree, an editor, a CI job — so a
 * path relative to it is not the path the allowlist means. This file sits two
 * levels under the root (tools/eslint-plugin-architecture/lib.mjs).
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))

/**
 * `context.filename` as the repo-relative, posix-spelled path the options use.
 * A relative filename is taken as already repo-relative (that is how the tests
 * write their fixtures); an absolute one is resolved against the real root.
 */
export function repoPath(filename) {
  const absolute = isAbsolute(filename) ? filename : resolve(REPO_ROOT, filename)
  return relative(REPO_ROOT, absolute).split(sep).join("/")
}

/** Glob match with `**` (any depth) and `*` (one segment). Small on purpose. */
export function matchesGlob(file, pattern) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
  return new RegExp(`^${re}$`).test(file)
}

/**
 * An allowlist entry is `{ rule, file, text, reason }` — keyed on the LINE'S
 * TEXT, never its number. A number churns on every edit above it and says
 * nothing about what is tolerated; the text says exactly which line stands.
 * `text` must appear on the offending line, so the exemption covers that line
 * and only that line — if the line is edited away, the violation surfaces
 * again. The allowlist fails closed, never open.
 */
export function isAllowed(context, allowlist, ruleId, node) {
  const file = repoPath(context.filename)
  const line = context.sourceCode.getLines()[node.loc.start.line - 1] ?? ""
  return allowlist.some(
    (e) => e.rule === ruleId && e.file === file && line.includes(e.text),
  )
}

/** Report `node` unless an allowlist entry still covers it. */
export function report(context, ruleId, allowlist, node, messageId, data) {
  if (isAllowed(context, allowlist, ruleId, node)) return
  context.report({ node, messageId, data })
}

/**
 * Entries for THIS file whose `text` appears nowhere in it any more: the code
 * moved on, so the exemption is dead weight. Every rule reports these at
 * `Program:exit`, so a stale entry fails the build instead of sitting in the
 * list looking load-bearing.
 */
export function staleAllowlist(context, allowlist, ruleId) {
  const file = repoPath(context.filename)
  const lines = context.sourceCode.getLines()
  return allowlist.filter(
    (e) => e.rule === ruleId && e.file === file && !lines.some((l) => l.includes(e.text)),
  )
}

/**
 * True when an import declaration imports at least one VALUE (not just types).
 * A side-effect import (`import "x"`) and an empty `import {} from "x"` both
 * pull the module in, so they count as value imports: the bundle gets it.
 */
export function hasValueSpecifier(node) {
  if (node.importKind === "type") return false
  if (node.specifiers.length === 0) return true
  return node.specifiers.some((s) => s.importKind !== "type")
}

/** True when `source` is exactly `pkg`, or a subpath of it unless `exact`. */
export function isFrom(source, pkg, exact) {
  if (source === pkg) return true
  return !exact && source.startsWith(`${pkg}/`)
}

/**
 * `create` body for "this import belongs only in these files" rules.
 *
 * Every form that loads a module is guarded, not just the static declaration:
 * `import()`, `export … from`, `export * from` and `require()` reach the same
 * package and were invisible before.
 *
 * `exact` matches the package name alone — the barrel — and leaves its
 * subpaths alone; rule 2 wants the opposite of that for @jollity/game-chain.
 * `typesOnly` reports type imports too; the default lets them through, since
 * they are erased at compile.
 *
 * A rule may name several scopes with `pkgs` instead of one `pkg`, each with
 * its own `exact` / `typesOnly`: polkadot-api and @polkadot-api/* are the same
 * escape hatch, but a type import of a helpers package is free.
 *
 * `normalize(source, file)` rewrites a specifier before it is matched, so a
 * rule about the app's own modules can see `../lib/x` as the `@/lib/x` it is.
 */
export function importGuard(context, options) {
  const { ruleId, messageId } = options
  const { allow = [], allowlist = [] } = context.options[0] ?? {}
  const pkgs = options.pkgs ?? [
    { pkg: options.pkg, exact: options.exact, typesOnly: options.typesOnly },
  ]
  const file = repoPath(context.filename)
  const allowed = allow.some((p) => matchesGlob(file, p))

  /** The scope `source` falls in, if any. */
  const scopeOf = (source) => {
    if (typeof source !== "string") return undefined
    const spec = options.normalize ? options.normalize(source, file) : source
    return pkgs.find((p) => isFrom(spec, p.pkg, p.exact))
  }

  /** Report `node` — an import of `source` — unless it is a type-only import
   *  the scope lets through. */
  const check = (node, source, value) => {
    if (allowed) return
    const scope = scopeOf(source)
    if (!scope) return
    if (!scope.typesOnly && !value) return
    report(context, ruleId, allowlist, node, messageId, { pkg: source })
  }

  return {
    ImportDeclaration(node) {
      if (typeof node.source.value !== "string") return
      check(node, node.source.value, hasValueSpecifier(node))
    },
    ImportExpression(node) {
      if (node.source.type !== "Literal" || typeof node.source.value !== "string") return
      // A dynamic import always loads the module, so it is a value import.
      check(node, node.source.value, true)
    },
    ExportNamedDeclaration(node) {
      if (!node.source || typeof node.source.value !== "string") return
      check(node, node.source.value, node.exportKind !== "type")
    },
    ExportAllDeclaration(node) {
      if (!node.source || typeof node.source.value !== "string") return
      check(node, node.source.value, node.exportKind !== "type")
    },
    CallExpression(node) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") return
      const [arg] = node.arguments
      if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") return
      check(node, arg.value, true)
    },
    "Program:exit"(node) {
      for (const e of staleAllowlist(context, allowlist, ruleId))
        context.report({ node, messageId: "staleAllowlist", data: { file: e.file, text: e.text } })
    },
  }
}
