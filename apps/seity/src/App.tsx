// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One screen: who you are, your avatar as hosts show it, and a picker to
 * publish a new one or take it down. Every step of a publish is listed as it
 * runs, so the screen doubles as a trace of the recipe.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { TxStatus } from "@parity/product-sdk-tx";

import { network, PRODUCT_ID } from "./config.ts";
import { readImage, type ImageCheck } from "./profile/image.ts";
import { resolveOwner, type OwnerLookup } from "./profile/owner.ts";
import { publishAvatar, STEP_LABELS, type PublishOutcome, type PublishStep } from "./profile/publish.ts";
import { readAvatar, type AvatarRead } from "./profile/read.ts";

type Picked = Extract<ImageCheck, { ok: true }> & { readonly previewUrl: string };

export function App() {
  const [owner, setOwner] = useState<OwnerLookup | null>(null);
  const [avatar, setAvatar] = useState<AvatarRead | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [steps, setSteps] = useState<PublishStep[]>([]);
  const [txStatus, setTxStatus] = useState<TxStatus | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void resolveOwner().then(setOwner);
  }, []);

  const label = owner?.ok ? owner.owner.label : null;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!label) return;
    const next = await readAvatar(label, signal);
    if (signal?.aborted) return;
    // A failed read keeps what is on screen; only the other two answers replace it.
    setAvatar((previous) => (next.kind === "stale" && previous?.kind === "found" ? previous : next));
  }, [label]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch((error: unknown) =>
      setAvatar({ kind: "stale", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => controller.abort();
  }, [refresh]);

  const avatarUrl = useObjectUrl(avatar?.kind === "found" ? avatar.image : null);

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (picked) URL.revokeObjectURL(picked.previewUrl);
    setPicked(null);
    setPickError(null);
    if (!file) return;
    const checked = await readImage(file);
    if (!checked.ok) {
      setPickError(checked.message);
      return;
    }
    const previewUrl = URL.createObjectURL(new Blob([checked.bytes as BlobPart], { type: file.type }));
    setPicked({ ...checked, previewUrl });
  }

  async function run(image: Picked | null) {
    if (!owner?.ok) return;
    setBusy(true);
    setSteps([]);
    setTxStatus(null);
    setStage(null);
    setOutcome(null);
    try {
      const result = await publishAvatar({
        owner: owner.owner,
        image,
        onStep: (step) => setSteps((done) => [...done, step]),
        onTxStatus: setTxStatus,
        onStage: setStage,
      });
      setOutcome(result);
      if (result.ok) {
        if (picked) URL.revokeObjectURL(picked.previewUrl);
        setPicked(null);
        await refresh();
      }
    } catch (error) {
      setOutcome({ ok: false, step: "read", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  if (owner == null) return <Shell><p className="muted">Asking the host who you are…</p></Shell>;
  if (!owner.ok) return <Shell><p className="error">{owner.message}</p></Shell>;

  const hasAvatar = avatar?.kind === "found";

  return (
    <Shell>
      <section className="card">
        <div className="avatar" aria-label="Current avatar">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{owner.owner.label[0]?.toUpperCase()}</span>}
        </div>
        <div>
          <h2>{owner.owner.label}.{network.dotnsSuffix}</h2>
          <p className="muted mono" title="Your identity account: it holds your usernames and signs the write">
            {owner.owner.address} ({PRODUCT_ID}/0)
          </p>
          <p className="muted">{describe(avatar)}</p>
        </div>
      </section>

      <section className="actions">
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={onPick} />
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
          Choose an image
        </button>
        {picked && (
          <span className="picked">
            <img src={picked.previewUrl} alt="" /> {picked.format}, {Math.round(picked.bytes.length / 1024)} KiB
          </span>
        )}
        <button type="button" className="primary" disabled={busy || !picked} onClick={() => void run(picked)}>
          Publish avatar
        </button>
        <button type="button" disabled={busy || !hasAvatar} onClick={() => void run(null)}>
          Remove avatar
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </section>
      {pickError && <p className="error">{pickError}</p>}

      {(steps.length > 0 || outcome) && (
        <section>
          <h3>Publish trace</h3>
          <ol className="steps">
            {steps.map((step, i) => {
              const failed = outcome && !outcome.ok && outcome.step === step && i === steps.length - 1;
              const running = !outcome && i === steps.length - 1;
              return (
                <li key={step} className={failed ? "failed" : running ? "running" : "done"}>
                  {STEP_LABELS[step]}
                  {step === "submit" && txStatus ? ` (${txStatus})` : ""}
                  {step === "fund" && running && stage ? `: ${stage}` : ""}
                </li>
              );
            })}
          </ol>
          {outcome?.ok && <p className="ok">{outcome.cleared ? "Avatar removed." : "Avatar published."}</p>}
          {outcome && !outcome.ok && <p className="error">{outcome.message}</p>}
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <h1>Seity</h1>
      <p className="muted">Your avatar, published under your name for every host to show.</p>
      {children}
    </main>
  );
}

function describe(avatar: AvatarRead | null): string {
  switch (avatar?.kind) {
    case undefined:
      return "Reading your profile…";
    case "none":
      return "No avatar published.";
    case "stale":
      return `Could not read your profile: ${avatar.message}`;
    case "found":
      return avatar.image ? `Avatar ${avatar.image.format}, ${short(avatar.cid)}` : `Avatar ${short(avatar.cid)}; the host has no bytes for it right now.`;
  }
}

const short = (cid: string) => `${cid.slice(0, 10)}…${cid.slice(-6)}`;

/** An object URL for the loaded bytes, revoked when they change. Keyed by CID so a re-read of the same avatar keeps its URL. */
function useObjectUrl(image: { cid: string; bytes: Uint8Array; mimeType: string } | null): string | null {
  const cid = image?.cid ?? null;
  const url = useMemo(
    () => (image ? URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.mimeType })) : null),
    // Deliberately keyed on the CID alone: it identifies the bytes.
    [cid],
  );
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}
