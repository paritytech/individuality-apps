// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { execFileSync, execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUNDLE_SOURCES, changedFiles, classify, matches, readBundleSources } from "./changes.mjs"

describe("the bundle list", () => {
  it("reads one path per line, dropping comments and blank lines", () => {
    expect(readBundleSources("# a comment\napp/\n\n  next.config.ts  \n")).toEqual(["app/", "next.config.ts"])
  })

  it("lists every jollity package, so a new one is hashed and classified too", () => {
    const jollity = readdirSync(new URL("../../packages/", import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("jollity-"))
      .map((d) => `packages/${d.name}/`)
    expect(jollity.length).toBeGreaterThan(0)
    for (const p of jollity) expect(BUNDLE_SOURCES, p).toContain(p)
  })

  it("names only paths that exist, so the deploy hash cannot silently drop one", () => {
    for (const p of BUNDLE_SOURCES) expect(existsSync(new URL(`../../${p}`, import.meta.url)), p).toBe(true)
  })

  it("a directory entry matches what it holds, a file entry only itself", () => {
    expect(matches(["app/"], "app/page.tsx")).toBe(true)
    expect(matches(["app/"], "apps/x.ts")).toBe(false)
    expect(matches(["package.json"], "package.json")).toBe(true)
    expect(matches(["package.json"], "apps/jollity-worker/package.json")).toBe(false)
  })
})

describe("classify", () => {
  it("scripts, docs and Humanity skip the preview", () => {
    expect(classify(["scripts/dev-host.mjs", "docs/a.md", "README.md", "apps/humanity-app/src/main.ts"])).toEqual({ deploy: false })
  })

  it("an app change deploys", () => {
    for (const f of ["apps/jollity-app/app/page.tsx", "apps/jollity-worker/src/card.ts", "packages/jollity-game-chain/src/game/constants.ts", "deploy/bulletin-deploy.config.ts", "package-lock.json"]) {
      expect(classify(["docs/a.md", f]), f).toEqual({ deploy: true })
    }
  })

  it("an explorer-only change skips, and one mixed with shipped code deploys", () => {
    expect(classify(["apps/jollity-app/lib/explorer/core/search.ts", "scripts/explore.mts"])).toEqual({ deploy: false })
    expect(classify(["apps/jollity-app/lib/explorer/core/search.ts", "apps/jollity-app/app/page.tsx"])).toEqual({ deploy: true })
  })

  it("a change to the deploy machinery deploys", () => {
    for (const f of [".github/workflows/deploy.yml", "scripts/ci/determine-domain.sh", "scripts/ci/merge-version-gist.mjs", "scripts/ci/deploy-matrix.mjs", "scripts/ci/deploy-comment.mjs", "scripts/ci/changes.mjs", "scripts/ci/bundle-sources.txt"]) {
      expect(classify([f]), f).toEqual({ deploy: true })
    }
  })

  it("a path nobody listed skips", () => {
    expect(classify(["something/new.txt"])).toEqual({ deploy: false })
  })

  it("no list at all deploys", () => {
    expect(classify(["", "  "])).toEqual({ deploy: true })
  })

  it("a rename out of the app counts as an app change", () => {
    const repo = mkdtempSync(join(tmpdir(), "changes-git-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    git("config", "commit.gpgsign", "false")
    mkdirSync(join(repo, "apps", "jollity-app", "app"), { recursive: true })
    writeFileSync(join(repo, "apps", "jollity-app", "app", "page.tsx"), "export default function Page() { return null }\n".repeat(20))
    git("add", ".")
    git("commit", "-qm", "one")
    mkdirSync(join(repo, "docs"))
    git("mv", "apps/jollity-app/app/page.tsx", "docs/page.tsx")
    git("commit", "-qm", "two")
    const files = changedFiles("HEAD^1", "HEAD", repo).filter(Boolean)
    expect(files.sort()).toEqual(["apps/jollity-app/app/page.tsx", "docs/page.tsx"])
    expect(classify(files)).toEqual({ deploy: true })
  })
})

describe("the cache-hash step and the classifier read one list", () => {
  const root = join(__dirname, "../..")
  const wf = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8")
  const LIST_CMD = "git ls-files -s -- $(grep -v -e '^#' -e '^$' scripts/ci/bundle-sources.txt)"

  it("the hash step reads bundle-sources.txt and names no path of its own", () => {
    expect(wf).toContain(LIST_CMD)
  })

  it("the hash step lists exactly the classifier's files", () => {
    const viaStep = execSync(LIST_CMD, { cwd: root, shell: "/bin/bash", encoding: "utf8" })
    const viaClassifier = execFileSync("git", ["ls-files", "-s", "--", ...BUNDLE_SOURCES], { cwd: root, encoding: "utf8" })
    expect(viaStep.length).toBeGreaterThan(0)
    expect(viaStep).toBe(viaClassifier)
  })
})

describe("workflow artifacts", () => {
  it("every upload in a deploy or release workflow is kept for 14 days", () => {
    const root = join(__dirname, "../..")
    for (const name of ["deploy.yml", "release.yml"]) {
      const workflow = readFileSync(join(root, ".github/workflows", name), "utf8")
      const uploads = workflow.match(/uses: actions\/upload-artifact@v\d+/g) ?? []
      const retentions = [...workflow.matchAll(/retention-days:\s*(\d+)/g)].map((match) => Number(match[1]))
      expect(retentions, name).toEqual(Array(uploads.length).fill(14))
    }
  })
})
