// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Screen surface and ambient light (screen/ambient), laid out as a
 *  responsive page: the host draws the device frame, status bar and top bar. */
import type { CSSProperties, ReactNode } from "react";

import { useCardFaceHidden } from "@shared/hooks/card-face.ts";

export interface ScreenProps {
  className?: string;
  /** A full-screen surface that wants the whole screen: under an open Pocket
   *  card, the card's face is moved away while it is up (see `card-face.ts`). */
  hideCardFace?: boolean;
  children: ReactNode;
}

export function Screen({ className = "", hideCardFace = false, children }: ScreenProps) {
  useCardFaceHidden(hideCardFace);
  return <div className={"screen" + (className ? " " + className : "")}>{children}</div>;
}

export function Ambient({ color }: { color: string }) {
  const style = { "--ambient-c": color } as CSSProperties;
  return <div className="ambient" style={style} />;
}
