// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadNetemProfiles, loadProfiles } from "./profile"

const script = join(dirname(fileURLToPath(import.meta.url)), "netem.sh")
const argsFor = (name: string) => execFileSync("bash", [script, "profile-args", name], { encoding: "utf8" }).trim()

describe("netem.sh", () => {
  it("emits machine-readable lifecycle markers only after each change is in force or restored", () => {
    const source = readFileSync(script, "utf8")
    expect(source).toContain("lifecycle() { printf 'E2E_NETEM_PHASE\\t%s\\t%s\\n' \"$1\" \"$2\"; }")
    for (const verb of ["spike", "blackout", "outage", "udp-cut", "video-stall", "host-chain-cut", "host-chain-hang"]) {
      expect(source, `${verb} active`).toContain(`lifecycle active ${verb}`)
      expect(source, `${verb} restored`).toContain(`lifecycle restored ${verb}`)
    }
    for (const verb of ["apply", "swap", "custom", "block-udp", "allow-udp"]) {
      expect(source, `${verb} active`).toContain(`lifecycle active ${verb}`)
      expect(source, `${verb} has no false restore`).not.toContain(`lifecycle restored ${verb}`)
    }
    expect(source).toContain("lifecycle restored clear")
    expect(source).not.toContain("lifecycle active clear")
    expect(source).toMatch(/blackout_off\n\s+prove_chain_off "blackout" "\$BLACKOUT_CHAIN" OUTPUT INPUT\n\s+lifecycle restored blackout/)
    expect(source).toMatch(/outage_off\n\s+prove_chain_off "outage" "\$OUTAGE_CHAIN" OUTPUT INPUT\n\s+lifecycle restored outage/)
    expect(source).toMatch(/udp_cut_off\n\s+prove_chain_off "udp-cut" "\$UDPCUT_CHAIN" OUTPUT INPUT\n\s+lifecycle restored udp-cut/)
    expect(source).toMatch(/video_stall_off\n\s+prove_chain_off "video-stall" "\$STALL_CHAIN" OUTPUT INPUT\n\s+lifecycle restored video-stall/)
    expect(source.match(/host_chain_rules_off\n\s+prove_host_chain_rules_off\n\s+lifecycle restored host-chain-/g)).toHaveLength(2)
    expect(source).toMatch(/prove_host_chain_rules_off\n\s+say "cleared"\n\s+lifecycle restored clear/)
  })
  it("waits for the xtables lock on every IPv4 and IPv6 firewall call", () => {
    const source = readFileSync(script, "utf8")
    const calls = [...source.matchAll(/\$SUDO ip6?tables\b[^\n;]*/g)].map(([call]) => call)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).toMatch(/^\$SUDO ip6?tables -w\b/)
    expect(source).toContain('$SUDO "$family" -w -C "$@"')
  })
  it("retains labelled raw qdisc byte and packet counters without resetting them", () => {
    const source = readFileSync(script, "utf8")
    expect(source).toContain('qdisc snapshot label=$1 profile=$profile')
    expect(source).toContain('tc -s qdisc show dev "$dev"')
  })
  it("builds tc arguments from netem-profiles.json, the one source of truth", () => {
    for (const [name, p] of Object.entries(loadNetemProfiles())) {
      const want = ["delay", `${p.delayMs}ms`]
      if (p.jitterMs > 0) want.push(`${p.jitterMs}ms`)
      if (p.lossPct > 0) want.push("loss", `${p.lossPct}%`)
      if (p.rateMbit > 0) want.push("rate", `${p.rateMbit}mbit`)
      expect(argsFor(name)).toBe(want.join(" "))
    }
  })
  it("matches the numbers in the design", () => {
    expect(argsFor("wifi")).toBe("delay 10ms")
    expect(argsFor("lte-good")).toBe("delay 50ms 10ms loss 0.1% rate 20mbit")
    expect(argsFor("lte-poor")).toBe("delay 150ms 40ms loss 2% rate 2mbit")
  })
  // Each profile name costs one bash spawn (~0.1 s idle, seconds on a loaded runner), so ask once per DISTINCT name, and give the
  // loop headroom: vitest's 5 s default timed this out 100 times in 400 runs under 8 parallel loops (#634).
  it("knows every network profile any bot profile asks for", () => {
    const names = new Set<string>()
    for (const p of loadProfiles()) {
      names.add(p.network.profile)
      if (p.network.switchTo) names.add(p.network.switchTo)
    }
    for (const name of names) expect(() => argsFor(name), name).not.toThrow()
  }, 60_000)
  it("rejects an unknown profile with the known names", () => {
    const r = spawnSync("bash", [script, "profile-args", "5g"], { encoding: "utf8" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/unknown profile 5g; known: wifi, lte-good, lte-poor/)
  })
  it.runIf(process.platform !== "linux")("refuses to apply off Linux", () => {
    const r = spawnSync("bash", [script, "apply", "wifi"], { encoding: "utf8" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Linux-only/)
  })
})

describe("netem.sh restored-marker proof", () => {
  it("treats a missing hook in a deleted chain as absent when iptables reports status 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "netem-deleted-chain-stub-"))
    const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    stub("uname", "echo Linux")
    stub("sudo", 'shift; exec "$@"')
    stub("ip", 'echo "1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.2"')
    stub("tc", "exit 0")
    stub("iptables", 'case "$*" in *"-C "*) exit 2;; esac; exit 0')
    stub("ip6tables", 'case "$*" in *"-C "*) exit 2;; esac; exit 0')
    const result = spawnSync("bash", [script, "clear"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETEM_STATE_FILE: join(dir, "state") },
    })
    const output = result.stdout + result.stderr
    rmSync(dir, { recursive: true, force: true })
    expect(result.status, output).toBe(0)
    expect(output).toContain("E2E_NETEM_PHASE\trestored\tclear")
  })

  it("does not claim a video stall is restored when its hooks cannot be removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "netem-restore-stub-"))
    const flag = join(dir, "stall-installed")
    const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    stub("uname", "echo Linux")
    stub("sudo", 'shift; exec "$@"')
    stub("sleep", "exit 0")
    stub("tc", "exit 0")
    stub("iptables", `
case "$*" in
  *"-I OUTPUT"*) touch ${flag}; exit 0;;
  *"-D OUTPUT"*) exit 1;;
  *"-C OUTPUT"*) [ -f ${flag} ]; exit $?;;
  *"-L E2E_VIDEO_STALL"*) echo "1 0 DROP all -- anywhere anywhere"; exit 0;;
esac
exit 0`)
    const result = spawnSync("bash", [script, "video-stall", "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETEM_STATE_FILE: join(dir, "state") },
    })
    const output = result.stdout + result.stderr
    rmSync(dir, { recursive: true, force: true })
    expect(result.status, output).not.toBe(0)
    expect(output).toMatch(/video-stall.*still installed/i)
    expect(output).not.toContain("E2E_NETEM_PHASE\trestored\tvideo-stall")
  })

  it("fails closed when firewall-rule inspection itself errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "netem-inspection-error-stub-"))
    const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    stub("uname", "echo Linux")
    stub("sudo", 'shift; exec "$@"')
    stub("sleep", "exit 0")
    stub("tc", "exit 0")
    stub("iptables", `
case "$*" in
  *"-C "*) exit 4;;
  *"-L E2E_VIDEO_STALL"*) echo "1 0 DROP all -- anywhere anywhere"; exit 0;;
esac
exit 0`)
    const result = spawnSync("bash", [script, "video-stall", "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETEM_STATE_FILE: join(dir, "state") },
    })
    const output = result.stdout + result.stderr
    rmSync(dir, { recursive: true, force: true })
    expect(result.status, output).not.toBe(0)
    expect(output).toMatch(/inspection.*failed|cannot inspect/i)
    expect(output).not.toContain("E2E_NETEM_PHASE\trestored\tvideo-stall")
  })

  it("fails closed when traffic-control inspection itself errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "netem-qdisc-inspection-error-stub-"))
    const shows = join(dir, "shows")
    const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    stub("uname", "echo Linux")
    stub("sudo", 'shift; exec "$@"')
    stub("sleep", "exit 0")
    stub("ip", 'echo "1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.2"')
    stub("tc", `
case "$*" in
  *"qdisc show"*) n=$(( $(cat ${shows} 2>/dev/null || echo 0) + 1 )); echo $n > ${shows}; [ $n -eq 1 ] && exit 1 || exit 4;;
esac
exit 0`)
    const result = spawnSync("bash", [script, "spike", "1", "10", "0", "0", "0"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETEM_STATE_FILE: join(dir, "state") },
    })
    const output = result.stdout + result.stderr
    rmSync(dir, { recursive: true, force: true })
    expect(result.status, output).not.toBe(0)
    expect(output).toMatch(/inspection.*failed|cannot inspect/i)
    expect(output).not.toContain("E2E_NETEM_PHASE\trestored\tspike")
  })

  it("does not claim clear restored while the IPv6 UDP block persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "netem-clear-ipv6-stub-"))
    const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    stub("uname", "echo Linux")
    stub("sudo", 'shift; exec "$@"')
    stub("ip", 'echo "1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.2"')
    stub("tc", "exit 0")
    stub("iptables", 'case "$*" in *"-C "*) exit 1;; esac; exit 0')
    stub("ip6tables", `
case "$*" in
  *"-D OUTPUT -p udp ! -o lo -j DROP"*) exit 1;;
  *"-C OUTPUT -p udp ! -o lo -j DROP"*) exit 0;;
  *"-C "*) exit 1;;
esac
exit 0`)
    const result = spawnSync("bash", [script, "clear"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETEM_STATE_FILE: join(dir, "state") },
    })
    const output = result.stdout + result.stderr
    rmSync(dir, { recursive: true, force: true })
    expect(result.status, output).not.toBe(0)
    expect(output).toMatch(/IPv6 UDP block.*still installed/i)
    expect(output).not.toContain("E2E_NETEM_PHASE\trestored\tclear")
  })
})

// THE OUTAGE MUST PROVE IT CUT: run cmd_outage against stub binaries (uname, sudo, iptables, curl, getent, sleep) in a temp PATH.
// The iptables stub raises a flag when the outage chain is hooked into OUTPUT; the curl stub fails while the flag is up, unless
// the scenario says the target keeps answering (a cut that cut nothing) or never answers.
describe("netem.sh outage verdicts", () => {
  const run = (scenario: "good" | "still-answers" | "never-answers" | "no-return") => {
    const dir = mkdtempSync(join(tmpdir(), "netem-stub-"))
    const flag = join(dir, "cut")
    const count = join(dir, "curls")
    const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    stub("uname", 'echo Linux')
    stub("sudo", 'shift; exec "$@"')
    stub("sleep", "exit 0")
    stub("getent", 'case "$1" in ahostsv4) echo "203.0.113.5 STREAM host";; esac; exit 0')
    stub("ip6tables", 'case "$*" in *"-C "*) exit 1;; esac; exit 0')
    stub("tc", "exit 0")
    // an -I OUTPUT hooks the chain in (flag up); a -D OUTPUT unhooks it (flag down)
    stub("iptables", `case "$*" in *"-C OUTPUT"*) [ -f ${flag} ]; exit $?;; *"-C INPUT"*) exit 1;; *"-I OUTPUT"*) touch ${flag};; *"-D OUTPUT"*) rm -f ${flag};; esac; exit 0`)
    // the n-th probe is before(1), during(2), after(3)
    stub("curl", `n=$(( $(cat ${count} 2>/dev/null || echo 0) + 1 )); echo $n > ${count}
case "${scenario}" in
  good) [ -f ${flag} ] && exit 7 || { echo -n 200; exit 0; };;
  still-answers) echo -n 200; exit 0;;
  never-answers) exit 7;;
  no-return) [ -f ${flag} ] && exit 7; [ $n -ge 3 ] && exit 7; echo -n 200; exit 0;;
esac`)
    const r = spawnSync("bash", [script, "outage", "target.example", "10"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETEM_STATE_FILE: join(dir, "state") } })
    const left = existsSync(flag)
    rmSync(dir, { recursive: true, force: true })
    return { status: r.status, out: r.stdout + r.stderr, left }
  }
  it("passes when the target answers, is cut, and answers again; the rules are gone", () => {
    const r = run("good")
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain("E2E_NETEM_PHASE\tactive\toutage")
    expect(r.out).toContain("E2E_NETEM_PHASE\trestored\toutage")
    expect(r.out.indexOf("E2E_NETEM_PHASE\tactive\toutage")).toBeLessThan(r.out.indexOf("probe (during)"))
    expect(r.out.indexOf("E2E_NETEM_PHASE\trestored\toutage")).toBeLessThan(r.out.indexOf("probe (after)"))
    expect(r.out).toMatch(/probe \(before\).*REACHED/)
    expect(r.out).toMatch(/probe \(during\).*UNREACHABLE/)
    expect(r.out).toMatch(/proven: answered before, cut during, answered after/)
    expect(r.left).toBe(false)
  })
  it("FAILS when the target still answers during the outage (the rules cut nothing)", () => {
    const r = run("still-answers")
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/NOT PROVEN.*STILL ANSWERED during the outage/)
    expect(r.left).toBe(false)
  })
  it("FAILS when the target never answered, so a cut cannot be shown", () => {
    const r = run("never-answers")
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/did not answer BEFORE/)
  })
  it("FAILS when the target does not answer again afterwards", () => {
    const r = run("no-return")
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/did not answer again after/)
  })
})
