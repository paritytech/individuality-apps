// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * An image, loaded: the one way the app loads a picture it draws into a
 * canvas or uploads to the GPU.
 *
 * `crossOrigin: "anonymous"` for any picture whose pixels are read back
 * (`getImageData`, `texImage2D`): a tainted image throws there. It must be
 * set before `src`, which is why callers never build the element themselves.
 * `decode` waits for the decoder too, so the first draw does not.
 */
export function loadImage(
  src: string,
  { crossOrigin, decode = false }: { crossOrigin?: "anonymous"; decode?: boolean } = {},
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (crossOrigin) img.crossOrigin = crossOrigin
    img.decoding = "async"
    img.onload = () => {
      if (decode && img.decode) img.decode().then(() => resolve(img), () => resolve(img))
      else resolve(img)
    }
    img.onerror = () => reject(new Error(`image failed: ${src.slice(0, 80)}`))
    img.src = src
  })
}
