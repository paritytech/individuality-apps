// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The logger the Daily Dollar modules were written against in Humanity:
 * `{name}` placeholders filled from a properties object. Lines go to the
 * console, which the host collects, under one tag per module.
 */
type Properties = Record<string, unknown>

function format(template: string, properties: Properties = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(key in properties)) return match
    const value = properties[key]
    if (value instanceof Error) return value.message
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
  })
}

export function loggerFor(...scope: string[]) {
  const tag = `[jollity-chat:${scope.join(":")}]`
  return {
    debug: (template: string, properties?: Properties) => console.debug(tag, format(template, properties)),
    info: (template: string, properties?: Properties) => console.log(tag, format(template, properties)),
    warning: (template: string, properties?: Properties) => console.warn(tag, format(template, properties)),
    error: (template: string, properties?: Properties) => console.error(tag, format(template, properties)),
  }
}
