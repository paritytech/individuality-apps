// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadArchive } from "../../scripts/lab/scenarios-ci.mts";

describe("bounded bundle download retries", () => {
  let dir: string;
  let attemptFiles: string[];
  const bytes = Buffer.from("complete archive bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const url = "https://example.invalid/bundle?token=private-test-value";
  const wait = vi.fn(async (_ms: number) => {});
  const attemptFile = () => {
    const [directory] = readdirSync(dir);
    expect(directory).toMatch(/^bundle-attempts-/);
    const files = readdirSync(join(dir, directory!));
    expect(files).toHaveLength(1);
    const file = join(dir, directory!, files[0]!);
    expect(statSync(file).size).toBe(0);
    for (const previous of attemptFiles) expect(existsSync(previous)).toBe(false);
    expect(attemptFiles).not.toContain(file);
    attemptFiles.push(file);
    return file;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archive-retries-"));
    attemptFiles = [];
    wait.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  it.each(["network error", "timeout", "HTTP 429", "HTTP 503", "interrupted stream"])("restarts a %s with fresh bytes and succeeds on attempt 2", async (failure) => {
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attemptFile();
      if (attemptFiles.length === 2) return new Response(bytes);
      if (failure === "network error") throw new TypeError(`fetch failed: ${url}`);
      if (failure === "timeout") throw new DOMException(`timeout: ${url}`, "TimeoutError");
      if (failure === "interrupted stream") {
        let reads = 0;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          if (reads++ === 0) controller.enqueue(Buffer.from("partial archive"));
          else controller.error(new TypeError(`terminated: ${url}`));
        } }));
      }
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: failure === "HTTP 429" ? 429 : 503 });
    });
    await downloadArchive(url, join(dir, "bundle.tar.gz"), digest, fetchImpl, wait);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(dir, "bundle.tar.gz"))).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(["bundle.tar.gz"]);
    for (const file of attemptFiles) expect(existsSync(file)).toBe(false);
    expect(wait.mock.calls).toEqual([[2_000]]);
    expect(vi.mocked(console.log).mock.calls).toEqual([[`Bundle download retry 2/3: ${failure === "interrupted stream" ? "network error" : failure}`]]);
    if (failure.startsWith("HTTP")) expect(cancelled).toBe(true);
  });
  it("@negative-control stops after 3 transient failures with the last HTTP reason and no temporary files", async () => {
    const statuses = [500, 502, 503];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attemptFile();
      return new Response("try again", { status: statuses[attemptFiles.length - 1]! });
    });
    await expect(downloadArchive(url, join(dir, "bundle.tar.gz"), digest, fetchImpl, wait)).rejects.toThrow("The bundle download answered 503");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[2_000], [2_000]]);
    expect(vi.mocked(console.log).mock.calls).toEqual([["Bundle download retry 2/3: HTTP 500"], ["Bundle download retry 3/3: HTTP 502"]]);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("returns the last transport error after 3 attempts", async () => {
    const errors = [new TypeError("first disconnect"), new DOMException("second timeout", "TimeoutError"), new TypeError("last disconnect")];
    const fetchImpl = vi.fn<typeof fetch>(async () => { attemptFile(); throw errors[attemptFiles.length - 1]; });
    await expect(downloadArchive(url, join(dir, "bundle.tar.gz"), digest, fetchImpl, wait)).rejects.toBe(errors[2]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(readdirSync(dir)).toEqual([]);
  });
  it.each([400, 401, 403, 404, 410, 422, 499])("@negative-control refuses HTTP %i after exactly 1 attempt", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { attemptFile(); return new Response("refused", { status }); });
    await expect(downloadArchive(url, join(dir, "bundle.tar.gz"), digest, fetchImpl, wait)).rejects.toThrow(`The bundle download answered ${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("@negative-control refuses a digest mismatch after exactly 1 attempt with no temporary files", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { attemptFile(); return new Response("changed bytes"); });
    await expect(downloadArchive(url, join(dir, "bundle.tar.gz"), digest, fetchImpl, wait)).rejects.toThrow("The published bundle changed during the download; re-run");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("does not retry an unclassified error", async () => {
    const error = new Error("unexpected failure");
    const fetchImpl = vi.fn<typeof fetch>(async () => { attemptFile(); throw error; });
    await expect(downloadArchive(url, join(dir, "bundle.tar.gz"), digest, fetchImpl, wait)).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("does not overwrite an existing destination or retry a filesystem error", async () => {
    writeFileSync(join(dir, "bundle.tar.gz"), "existing archive");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(bytes));
    await expect(downloadArchive(url, join(dir, "bundle.tar.gz"), digest, fetchImpl, wait)).rejects.toMatchObject({ code: "EEXIST" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "bundle.tar.gz"), "utf8")).toBe("existing archive");
    expect(readdirSync(dir)).toEqual(["bundle.tar.gz"]);
  });
});
