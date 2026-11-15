// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useSyncExternalStore } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { claimDotnsName } from "@features/card/chain/claim-dotns-name.ts";
import {
  DOTNS_NAME_CLAIM_MUTATION_KEY,
  dotnsClaimSubject,
  dotnsGatewayNamesKey,
  lastDotnsClaimGate,
} from "@features/card/hooks/use-dotns-name-claim.ts";
import {
  clearDotnsNameClaim,
  readDotnsNameClaim,
  subscribeDotnsNameClaim,
} from "@features/card/storage/dotns-name-claim-store.ts";
import { readDotnsGatewayNames } from "@humanity/shared/chain/dotns-gateway/read-names.ts";
import { errorText } from "./debug-format.ts";
import type { DebugPageInput } from "./debug-view.ts";

const TITLE = "Register dotNS name (DotnsGateway.register_name)";

export function DebugDotnsName({ card }: { card: DebugPageInput["card"] }) {
  const queryClient = useQueryClient();
  const [, setRecordVersion] = useState(0);
  const recordVersion = useSyncExternalStore(
    subscribeDotnsNameClaim,
    () => Date.now(),
    () => 0,
  );
  const inFlight = useIsMutating({ mutationKey: DOTNS_NAME_CLAIM_MUTATION_KEY }) > 0;
  const { owner, fullUsername } = dotnsClaimSubject(card, true);
  const [label, setLabel] = useState("");
  const gateway = useQuery({
    queryKey: dotnsGatewayNamesKey(owner ?? ""),
    queryFn: () => readDotnsGatewayNames(owner ?? ""),
    enabled: owner != null,
    retry: false,
  });
  const run = useMutation({
    mutationKey: DOTNS_NAME_CLAIM_MUTATION_KEY,
    mutationFn: (target: { owner: string; label: string }) =>
      claimDotnsName({ ...target, source: "manual" }),
    onSettled: () => {
      setRecordVersion((version) => version + 1);
      if (owner != null) void queryClient.invalidateQueries({ queryKey: dotnsGatewayNamesKey(owner) });
    },
  });
  const record = owner == null ? null : readDotnsNameClaim(owner);
  const gate = lastDotnsClaimGate();
  const target = label.trim() || fullUsername || "";

  return (
    <div className="debug-mutation" data-testid="debug-dotns-name" data-record-version={recordVersion}>
      <h3>{TITLE}</h3>
      <p className="debug-note">
        Mints the full username in dotNS on Asset Hub and links it to the lite one, the half of
        the claim People&apos;s `register_person` does not do. Runs the automatic path&apos;s attempt
        now, ignoring the retry backoff. The account must be a full person whose ring root Asset Hub
        has imported.
      </p>
      <p className="debug-note">
        auto gate: {gate == null ? "not evaluated yet" : `${gate.kind} — ${gate.detail}`}
      </p>
      <p className="debug-note">
        gateway (Asset Hub):{" "}
        {owner == null
          ? "no card"
          : gateway.isPending
            ? "reading…"
            : gateway.error != null
              ? errorText(gateway.error)
              : `lite ${gateway.data.lite ?? "—"} · full ${gateway.data.full ?? "—"} · alias ${gateway.data.aliasRegistered ? "registered" : "none"}`}
      </p>
      <p className="debug-note">
        People full username: {fullUsername ?? "—"} · record:{" "}
        {owner == null ? "no card" : record == null ? "none" : JSON.stringify(record)}
      </p>
      <label className="debug-note">
        label{" "}
        <input
          type="text"
          value={label}
          placeholder={fullUsername ?? "lowercase letters"}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="debug-chip"
        disabled={owner == null || target === "" || inFlight}
        onClick={() => {
          if (owner != null) run.mutate({ owner, label: target });
        }}
      >
        Register dotNS name
      </button>
      {owner != null && record != null && (
        <button
          type="button"
          className="debug-chip"
          disabled={inFlight}
          onClick={() => {
            clearDotnsNameClaim(owner);
            setRecordVersion((version) => version + 1);
          }}
        >
          Clear record
        </button>
      )}
      <p className="debug-note">
        {run.isPending
          ? "running…"
          : run.error != null
            ? errorText(run.error)
            : run.data != null
              ? JSON.stringify(run.data)
              : ""}
      </p>
    </div>
  );
}
