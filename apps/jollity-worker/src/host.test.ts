// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests the doorway in host.ts against a mocked `@parity/product-sdk-host`.
 *
 * Cards render through `onCustomMessageRenderingRequest` of the chat manager.
 * The chain and
 * account calls pass through what the worker asks for, and so do the signing
 * calls the sign-up from the chat makes.
 */
import type { HostConnectionStatus } from "@parity/product-sdk-host"
import { ConnectionResetError, SubscriptionError, VersionedHostChatSetRoomFooterRequest } from "@parity/truapi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cardCopy } from "./card"
import { INTRO } from "./card/intro"
import type { ActionListener, RenderRequest, RoomFooter } from "./host"

const connection = vi.hoisted(() => ({ listeners: new Set<(status: HostConnectionStatus) => void>() }))

const reportedFailures = vi.hoisted(() => vi.fn())

vi.mock("./telemetry", async (importOriginal) => {
  const telemetry = await importOriginal<typeof import("./telemetry")>()
  return {
    ...telemetry,
    chatFailure: (...failure: Parameters<typeof telemetry.chatFailure>) => {
      reportedFailures(...failure)
      telemetry.chatFailure(...failure)
    },
  }
})

vi.mock("@parity/product-sdk-host", () => {
  class ChainNotSupportedError extends Error {}
  return {
    asProductId: (value: string) => value,
    ChainNotSupportedError,
    deriveEntropy: vi.fn(),
    findRingVrfKeyHandle: vi.fn(),
    getAccountsProvider: vi.fn(),
    getChatManager: vi.fn(),
    fromHex: (hex: string) => {
      if (hex.length % 2 !== 0) throw new Error(`unpadded hex of length ${hex.length - 2}`)
      return Uint8Array.from(hex.slice(2).match(/../g) ?? [], (byte) => parseInt(byte, 16))
    },
    formatHostError: (error: unknown) => {
      const tagged = error as { tag?: string; value?: { value?: { tag?: string } } } | null
      return tagged?.tag === "Domain" && tagged.value?.value?.tag ? tagged.value.value.tag : String(error)
    },
    getHostChainInfo: vi.fn(),
    getHostLocalStorage: vi.fn(),
    getHostProvider: vi.fn(),
    getNotificationManager: vi.fn(),
    getPaymentManager: vi.fn(),
    getRendererManager: vi.fn(),
    getTruApi: vi.fn(),
    navigateTo: vi.fn(),
    requestDevicePermission: vi.fn(),
    subscribeConnectionStatus: (listener: (status: HostConnectionStatus) => void) => {
      connection.listeners.add(listener)
      return () => connection.listeners.delete(listener)
    },
    toHex: (bytes: Uint8Array) => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  }
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const emitConnectionStatus = (status: HostConnectionStatus) => [...connection.listeners].forEach((listener) => listener(status))

const connectionReset = () => new SubscriptionError("TrUAPI host connection interrupted", { cause: new ConnectionResetError() })

interface PressObserver {
  next(action: RendererPress): void
  error?(reason: unknown): void
  complete?(): void
}

type ActionSubscribe = () => {
  subscribe(observer: PressObserver): { unsubscribe(): void }
}

interface RendererPress {
  context: { tag: string; value: { messageId?: string; roomId?: string; messageType?: string } }
  actionId: string
  payload: string
}

function sdkCardActions(actionSubscribe: ActionSubscribe) {
  const listeners = new Map<string, Set<ActionListener>>()
  let subscription: { unsubscribe(): void } | undefined
  return (messageId: string, listener: ActionListener) => {
    const forMessage = listeners.get(messageId) ?? new Set()
    forMessage.add(listener)
    listeners.set(messageId, forMessage)
    subscription ??= actionSubscribe().subscribe({
      next: ({ context, actionId, payload }) => {
        if (context.tag !== "ChatMessage") return
        const data = payload === "0x" ? undefined : Uint8Array.from(payload.slice(2).match(/../g) ?? [], (byte) => parseInt(byte, 16))
        for (const each of listeners.get(context.value.messageId!) ?? []) each(actionId, data)
      },
    })
    return () => {
      forMessage.delete(listener)
      if (forMessage.size === 0) listeners.delete(messageId)
      if (listeners.size > 0) return
      subscription?.unsubscribe()
      subscription = undefined
    }
  }
}

function fakeChatManager(actionSubscribe?: ActionSubscribe) {
  let handler: ((request: unknown) => { subscribe(observer: { next?(node: unknown): void }): { unsubscribe(): void } }) | undefined
  const unregister = vi.fn()
  const cardActions = actionSubscribe && sdkCardActions(actionSubscribe)
  return {
    registerRoom: vi.fn().mockResolvedValue("New"),
    registerBot: vi.fn().mockResolvedValue("New"),
    sendMessage: vi.fn().mockResolvedValue({ messageId: "m1" }),
    subscribeChatList: vi.fn(),
    subscribeAction: vi.fn(),
    onCustomMessageRenderingRequest: vi.fn((requestHandler: typeof handler) => {
      handler = requestHandler
      return { unsubscribe: unregister }
    }),
    render: (request: { messageId: string; [field: string]: unknown }) =>
      handler!(cardActions ? { subscribeActions: (listener: ActionListener) => cardActions(request.messageId, listener), ...request } : request),
    unregister,
  }
}

function latestSubscriberActions() {
  let subscriber: PressObserver | undefined
  const stopActions = vi.fn()
  const actionSubscribe = vi.fn(() => ({
    subscribe: (observer: PressObserver) => {
      subscriber = observer
      return {
        unsubscribe: () => {
          stopActions()
          if (subscriber === observer) subscriber = undefined
        },
      }
    },
  }))
  const takeSubscriber = () => {
    const ending = subscriber
    subscriber = undefined
    return ending
  }
  const end = (reason: unknown) => takeSubscriber()?.error?.(reason)
  const complete = () => takeSubscriber()?.complete?.()
  return { actionSubscribe, stopActions, end, complete, press: (action: RendererPress) => subscriber?.next(action) }
}

async function hostWithFakeChat() {
  const sdk = await import("@parity/product-sdk-host")
  const manager = fakeChatManager()
  const { actionSubscribe, stopActions, end, complete, press } = latestSubscriberActions()
  vi.mocked(sdk.getChatManager).mockResolvedValue(manager as never)
  vi.mocked(sdk.getRendererManager).mockResolvedValue(null as never)
  vi.mocked(sdk.getTruApi).mockResolvedValue({ renderer: { actionSubscribe } } as never)
  const { createWorkerHost } = await import("./host")
  return { manager, actionSubscribe, stopActions, end, complete, press, host: createWorkerHost() }
}

async function footerAnswer(chat: Record<string, unknown> | null, footer: RoomFooter = "Empty") {
  const sdk = await import("@parity/product-sdk-host")
  vi.mocked(sdk.getTruApi).mockResolvedValue((chat ? { chat } : null) as never)
  const { createWorkerHost } = await import("./host")
  return createWorkerHost().chat.setRoomFooter("jollity", footer)
}

const answered = (error?: unknown) => Promise.resolve({ isOk: () => error === undefined, error })

const DOCKED: RoomFooter = { card: { messageType: "jollity.gamecard", payload: Uint8Array.of(1, 2) } }

/** The setRoomFooter of the installed client up to its encoding, which is what throws on a footer it does not know. */
function installedSetRoomFooter() {
  return vi.fn((request: VersionedHostChatSetRoomFooterRequest["value"]) => {
    VersionedHostChatSetRoomFooterRequest.enc({ tag: "V2", value: request })
    return answered()
  })
}

type FooterDraw = (
  request: { context: { tag: string; value: unknown }; payload: string },
  send: (node: unknown) => void,
) => (() => void) | void

async function hostWithFooterRenderer() {
  const sdk = await import("@parity/product-sdk-host")
  let draw: FooterDraw | undefined
  const unregister = vi.fn()
  const renderer = {
    draw: vi.fn((_tag: string, handler: FooterDraw) => {
      draw = handler
      return { unsubscribe: unregister }
    }),
  }
  const { actionSubscribe, stopActions, press } = latestSubscriberActions()
  const manager = fakeChatManager(actionSubscribe)
  vi.mocked(sdk.getChatManager).mockResolvedValue(manager as never)
  vi.mocked(sdk.getRendererManager).mockResolvedValue(renderer as never)
  vi.mocked(sdk.getTruApi).mockResolvedValue({ renderer: { actionSubscribe } } as never)
  const { createWorkerHost } = await import("./host")
  return {
    host: createWorkerHost(),
    manager,
    renderer,
    unregister,
    stopActions,
    actionSubscribe,
    draw: (send: (node: unknown) => void = () => {}) =>
      draw!({ context: { tag: "ChatRoomFooter", value: { roomId: "jollity", messageType: "jollity.gamecard" } }, payload: "0x0102" }, send),
    press,
  }
}

const footerPress = (value: { roomId: string; messageType: string }, payload = "0x") => ({
  context: { tag: "ChatRoomFooter", value },
  actionId: "jollity.register",
  payload,
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  connection.listeners.clear()
})

describe("card rendering works", () => {
  it("draws each card through the chat manager and scopes its presses to it", async () => {
    // Given
    const { manager, host, press } = await hostWithFakeChat()
    const pressed = vi.fn()
    const next = vi.fn()
    const subscribeActions = vi.fn()
    let drawn: RenderRequest | undefined
    host.renderer.onRender((request, send, onAction) => {
      drawn = request
      send({ tag: "Nil" })
      onAction(pressed)
    })
    await flush()

    // When
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1), subscribeActions }).subscribe({ next })
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.register", payload: "0x01" })
    press({ context: { tag: "ChatMessage", value: { messageId: "m2" } }, actionId: "jollity.register", payload: "0x" })
    press({ context: { tag: "ChatRoomFooter", value: { roomId: "jollity", messageType: "jollity.gamecard" } }, actionId: "jollity.register", payload: "0x" })

    // Then
    expect(drawn).toEqual({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) })
    expect(next).toHaveBeenCalledWith({ tag: "Nil" })
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(pressed).toHaveBeenCalledWith("jollity.register", Uint8Array.of(1))
    expect(subscribeActions).not.toHaveBeenCalled()
  })

  it("tears a card down when its subscription ends", async () => {
    // Given
    const { manager, host } = await hostWithFakeChat()
    const teardown = vi.fn()
    host.renderer.onRender(() => teardown)
    await flush()
    const subscription = manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})

    // When
    subscription.unsubscribe()

    // Then
    expect(teardown).toHaveBeenCalledOnce()
  })

  it("stops the presses of a message card when the host takes it down, and keeps listening for the others", async () => {
    // Given
    const { manager, host, press, actionSubscribe, stopActions } = await hostWithFakeChat()
    const listeners: Record<string, ActionListener> = { m1: vi.fn(), m2: vi.fn() }
    host.renderer.onRender((request, _send, onAction) => onAction(listeners[request.messageId]!))
    await flush()
    const first = manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})
    manager.render({ messageId: "m2", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})

    // When
    first.unsubscribe()
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x" })
    press({ context: { tag: "ChatMessage", value: { messageId: "m2" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(listeners.m1).not.toHaveBeenCalled()
    expect(listeners.m2).toHaveBeenCalledWith("jollity.stash", undefined)
    expect(actionSubscribe).toHaveBeenCalledTimes(1)
    expect(stopActions).not.toHaveBeenCalled()
  })

  it("unregisters from the chat manager and stops listening for presses when the worker stops rendering", async () => {
    // Given
    const { manager, host, stopActions } = await hostWithFakeChat()
    const stopRendering = host.renderer.onRender(() => {})
    await flush()

    // When
    stopRendering()

    // Then
    expect(manager.unregister).toHaveBeenCalledOnce()
    expect(stopActions).toHaveBeenCalledOnce()
  })

  it("gives a press to a later draw of a message card after the earlier draw is torn down", async () => {
    // Given
    const { manager, host, press } = await hostWithFakeChat()
    const listeners = [vi.fn(), vi.fn()]
    let draws = 0
    host.renderer.onRender((_request, _send, onAction) => onAction(listeners[draws++]!))
    await flush()
    const earlier = manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})

    // When
    earlier.unsubscribe()
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(listeners[0]).not.toHaveBeenCalled()
    expect(listeners[1]).toHaveBeenCalledOnce()
  })

  it("listens for presses again after the link to the host comes back", async () => {
    // Given
    const { manager, host, press, end, actionSubscribe } = await hostWithFakeChat()
    const pressed = vi.fn()
    host.renderer.onRender((_request, _send, onAction) => onAction(pressed))
    await flush()
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})

    // When
    end(connectionReset())
    emitConnectionStatus("connected")
    const beforeTheLinkDropped = actionSubscribe.mock.calls.length
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connected")
    end(connectionReset())
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connected")
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(beforeTheLinkDropped).toBe(1)
    expect(actionSubscribe).toHaveBeenCalledTimes(3)
    expect(pressed).toHaveBeenCalledWith("jollity.stash", undefined)
  })
})

describe("card rendering fails", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("registers no renderer and listens for no presses when rendering stopped before the host arrived", async () => {
    // Given
    const { manager, host, actionSubscribe } = await hostWithFakeChat()

    // When
    const stopRendering = host.renderer.onRender(() => {})
    stopRendering()
    await flush()

    // Then
    expect(manager.onCustomMessageRenderingRequest).not.toHaveBeenCalled()
    expect(actionSubscribe).not.toHaveBeenCalled()
  })

  it("reports the presses ending for another reason than a reset of the link, and listens no more", async () => {
    // Given
    const reported = vi.spyOn(console, "error").mockImplementation(() => {})
    const { host, end, actionSubscribe } = await hostWithFakeChat()
    host.renderer.onRender(() => {})
    await flush()

    const denied = new SubscriptionError("Subscription interrupted", { cause: new Error("Denied") })

    // When
    end(denied)
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connected")

    // Then
    expect(actionSubscribe).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("presses of cards"), denied)
    expect(reportedFailures).toHaveBeenCalledExactlyOnceWith("host-call-failed", "renderer-actions", {
      error: expect.stringMatching(/SubscriptionError: Subscription interrupted.*Error: Denied/),
    })
  })

  it("reports the presses ending with no reason, and listens no more", async () => {
    // Given
    const reported = vi.spyOn(console, "error").mockImplementation(() => {})
    const { host, complete, actionSubscribe } = await hostWithFakeChat()
    host.renderer.onRender(() => {})
    await flush()

    // When
    complete()
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connected")

    // Then
    expect(actionSubscribe).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledOnce()
    expect(reportedFailures).toHaveBeenCalledExactlyOnceWith("host-call-failed", "renderer-actions", expect.anything())
  })

  it("reports a card that throws on a press, and keeps the presses of the other cards", async () => {
    // Given
    const reported = vi.spyOn(console, "error").mockImplementation(() => {})
    const { manager, host, press, actionSubscribe } = await hostWithFakeChat()
    const broken = new Error("handler broke")
    const listeners: Record<string, ActionListener> = {
      m1: vi.fn(() => {
        throw broken
      }),
      m2: vi.fn(),
    }
    host.renderer.onRender((request, _send, onAction) => onAction(listeners[request.messageId]!))
    await flush()
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})
    manager.render({ messageId: "m2", messageType: "jollity.gamecard", payload: Uint8Array.of(2) }).subscribe({})

    // When
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x" })
    press({ context: { tag: "ChatMessage", value: { messageId: "m2" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(listeners.m2).toHaveBeenCalledExactlyOnceWith("jollity.stash", undefined)
    expect(actionSubscribe).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("failed on a press"), broken)
    expect(reportedFailures).toHaveBeenCalledExactlyOnceWith("host-call-failed", "card-press", {
      error: expect.stringContaining("handler broke"),
    })
  })

  it("reports a docked card that throws on a press, and keeps the presses of the message cards", async () => {
    // Given
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { host, manager, draw, press, actionSubscribe } = await hostWithFooterRenderer()
    const listeners: Record<string, ActionListener> = {
      "footer:jollity": vi.fn(() => {
        throw new Error("docked handler broke")
      }),
      m2: vi.fn(),
    }
    host.renderer.onRender((request, _send, onAction) => onAction(listeners[request.messageId]!))
    await flush()
    draw()
    manager.render({ messageId: "m2", messageType: "jollity.gamecard", payload: Uint8Array.of(2) }).subscribe({})

    // When
    press(footerPress({ roomId: "jollity", messageType: "jollity.gamecard" }))
    press({ context: { tag: "ChatMessage", value: { messageId: "m2" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(listeners.m2).toHaveBeenCalledExactlyOnceWith("jollity.stash", undefined)
    expect(actionSubscribe).toHaveBeenCalledOnce()
    expect(reportedFailures).toHaveBeenCalledExactlyOnceWith("host-call-failed", "card-press", {
      error: expect.stringContaining("docked handler broke"),
    })
  })

  it("reports a press whose payload is not hex, and keeps the presses that follow", async () => {
    // Given
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { manager, host, press, actionSubscribe } = await hostWithFakeChat()
    const pressed = vi.fn()
    host.renderer.onRender((_request, _send, onAction) => onAction(pressed))
    await flush()
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})

    // When
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x0" })
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x01" })

    // Then
    expect(pressed).toHaveBeenCalledExactlyOnceWith("jollity.stash", Uint8Array.of(1))
    expect(actionSubscribe).toHaveBeenCalledOnce()
    expect(reportedFailures).toHaveBeenCalledExactlyOnceWith("host-call-failed", "card-press", {
      error: expect.stringContaining("unpadded hex"),
    })
  })

  it("reports the presses failing to open again after the link to the host comes back", async () => {
    // Given
    const reported = vi.spyOn(console, "error").mockImplementation(() => {})
    const { host, end, actionSubscribe } = await hostWithFakeChat()
    host.renderer.onRender(() => {})
    await flush()
    const refused = new Error("actionSubscribe refused")
    actionSubscribe.mockImplementationOnce(() => {
      throw refused
    })

    // When
    end(connectionReset())
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connected")
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connected")

    // Then
    expect(actionSubscribe).toHaveBeenCalledTimes(2)
    expect(reported).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("presses of cards"), refused)
    expect(reportedFailures).toHaveBeenCalledExactlyOnceWith("host-call-failed", "renderer-actions", {
      error: expect.stringContaining("actionSubscribe refused"),
    })
  })

  it("does not listen again after the worker stops rendering while the link is down", async () => {
    // Given
    const { host, end, actionSubscribe } = await hostWithFakeChat()
    const stopRendering = host.renderer.onRender(() => {})
    await flush()
    end(connectionReset())

    // When
    stopRendering()
    emitConnectionStatus("disconnected")
    emitConnectionStatus("connected")

    // Then
    expect(actionSubscribe).toHaveBeenCalledOnce()
  })
})

describe("card posting works", () => {
  it("posts a card as a Custom message with a hex payload and its alt", async () => {
    // Given
    const { manager, host } = await hostWithFakeChat()

    // When
    await host.chat.postMessage("jollity", "jollity.gamecard", Uint8Array.of(0xab, 0x01), cardCopy.GAME_CARD_ALT)

    // Then
    expect(manager.sendMessage).toHaveBeenCalledWith(
      "jollity",
      { tag: "Custom", value: { messageType: "jollity.gamecard", payload: "0xab01" } },
      { alt: cardCopy.GAME_CARD_ALT },
    )
  })

  it("posts one message at a time, in the order asked, even when the host is slow to answer the first", async () => {
    // Given
    const { manager, host } = await hostWithFakeChat()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstAnswer = new Promise<void>((resolve) => (releaseFirst = resolve))
    manager.sendMessage.mockImplementation(async (_room: string, content: { tag: string; value: { text?: string; messageType?: string } }) => {
      order.push(content.value.text ?? content.value.messageType!)
      if (order.length === 1) await firstAnswer
      return { messageId: `m${order.length}` }
    })

    // When
    const first = host.chat.postText("jollity", "rule 1")
    const second = host.chat.postMessage("jollity", "jollity.gamecard", Uint8Array.of(1), "card")
    const third = host.chat.postText("jollity", "rule 2")
    await vi.waitFor(() => expect(order).toEqual(["rule 1"]))

    // Then
    releaseFirst()
    await Promise.all([first, second, third])
    expect(order).toEqual(["rule 1", "jollity.gamecard", "rule 2"])
  })

  it("lets later posts through once a post fails", async () => {
    // Given
    const { manager, host } = await hostWithFakeChat()
    manager.sendMessage.mockRejectedValueOnce(new Error("host gone"))

    // When
    const failed = host.chat.postText("jollity", "lost").catch((error: Error) => error.message)
    await host.chat.postText("jollity", "next")

    // Then
    expect(await failed).toContain("host gone")
    expect(manager.sendMessage).toHaveBeenCalledTimes(2)
  })
})

describe("alt text the host accepts", () => {
  // The host rejects control and bidirectional characters in `alt`
  // ("alt must not contain control or bidirectional characters").
  // Mirrors is_display_unsafe in host-rust-core truapi/src/platform.rs.
  const HOST_REJECTS = /[\u0000-\u001F\u007F-\u009F\u200B\u061C\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u

  it("collapses newlines and strips control and bidi characters from the alt", async () => {
    // Given
    const { manager, host } = await hostWithFakeChat()

    // When
    await host.chat.postMessage("jollity", "t", Uint8Array.of(1), "a\nb\t c\u0000d\u202Ee\u007Ff")

    // Then
    const options = manager.sendMessage.mock.calls[0]![2] as { alt: string }
    expect(options.alt).toBe("a b cdef")
  })

  it.each([
    ["a zero-width space", "a\u200Bb"],
    ["a byte order mark", "a\uFEFFb"],
    ["a tag character", "a\u{E0041}b\u{E007F}"],
    ["a paragraph separator", "a\u2029b"],
  ])("removes %s", async (_name, alt) => {
    // Given
    const { manager, host } = await hostWithFakeChat()

    // When
    await host.chat.postMessage("jollity", "t", Uint8Array.of(1), alt)

    // Then
    const sent = (manager.sendMessage.mock.calls[0]![2] as { alt: string }).alt
    expect(sent).not.toMatch(HOST_REJECTS)
    expect(sent.startsWith("a")).toBe(true)
  })

  it("sends every intro rule's text as an alt without a character the host rejects", async () => {
    // Given
    const { manager, host } = await hostWithFakeChat()

    // When
    for (const rule of INTRO) await host.chat.postMessage("jollity", "t", Uint8Array.of(1), rule.text)

    // Then
    for (const call of manager.sendMessage.mock.calls) {
      expect((call[2] as { alt: string }).alt).not.toMatch(HOST_REJECTS)
    }
  })
})

describe("the room footer works", () => {
  it.each(["Empty", "TextInput"] as const)("asks truapi for the %s footer of the room by its plain name", async (footer) => {
    // Given
    const setRoomFooter = installedSetRoomFooter()

    // When
    const outcome = await footerAnswer({ setRoomFooter }, footer)

    // Then
    expect(setRoomFooter).toHaveBeenCalledTimes(1)
    expect(setRoomFooter).toHaveBeenCalledWith({ roomId: "jollity", footer })
    expect(outcome).toBe("set")
  })

  it("docks a card as the Card footer of truapi", async () => {
    // Given
    const setRoomFooter = installedSetRoomFooter()

    // When
    const outcome = await footerAnswer({ setRoomFooter }, DOCKED)

    // Then
    expect(setRoomFooter).toHaveBeenCalledTimes(1)
    expect(setRoomFooter).toHaveBeenCalledWith({
      roomId: "jollity",
      footer: { tag: "Card", value: { messageType: "jollity.gamecard", payload: "0x0102" } },
    })
    expect(outcome).toBe("set")
  })

  it("draws a docked card through the handler of the worker and scopes its presses to it", async () => {
    // Given
    const { host, draw, press, renderer } = await hostWithFooterRenderer()
    const pressed = vi.fn()
    const next = vi.fn()
    let drawn: RenderRequest | undefined
    host.renderer.onRender((request, send, onAction) => {
      drawn = request
      send({ tag: "Nil" })
      onAction(pressed)
    })
    await flush()

    // When
    draw(next)
    press(footerPress({ roomId: "jollity", messageType: "jollity.gamecard" }, "0x01"))
    press(footerPress({ roomId: "jollity", messageType: "jollity.other" }))
    press(footerPress({ roomId: "elsewhere", messageType: "jollity.gamecard" }))
    press({ context: { tag: "ChatMessage", value: { roomId: "jollity", messageType: "jollity.gamecard" } }, actionId: "jollity.register", payload: "0x" })
    press({ context: { tag: "Other", value: { roomId: "jollity", messageType: "jollity.gamecard" } }, actionId: "jollity.register", payload: "0x" })

    // Then
    expect(renderer.draw).toHaveBeenCalledWith("ChatRoomFooter", expect.any(Function))
    expect(drawn).toEqual({ messageId: "footer:jollity", messageType: "jollity.gamecard", payload: Uint8Array.of(1, 2) })
    expect(next).toHaveBeenCalledWith({ tag: "Nil" })
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(pressed).toHaveBeenCalledWith("jollity.register", Uint8Array.of(1))
  })

  it("gives a press only to the latest draw of the footer", async () => {
    // Given
    const { host, draw, press } = await hostWithFooterRenderer()
    const listeners = [vi.fn(), vi.fn()]
    let draws = 0
    host.renderer.onRender((_request, _send, onAction) => onAction(listeners[draws++]!))
    await flush()

    // When
    draw()
    draw()
    press(footerPress({ roomId: "jollity", messageType: "jollity.gamecard" }))

    // Then
    expect(listeners[0]).not.toHaveBeenCalled()
    expect(listeners[1]).toHaveBeenCalledWith("jollity.register", undefined)
  })

  it("keeps the presses of the latest draw of the footer when an earlier draw is torn down", async () => {
    // Given
    const { host, draw, press } = await hostWithFooterRenderer()
    const listeners = [vi.fn(), vi.fn()]
    let draws = 0
    host.renderer.onRender((_request, _send, onAction) => onAction(listeners[draws++]!))
    await flush()
    const tearEarlierDown = draw()
    draw()

    // When
    tearEarlierDown?.()
    press(footerPress({ roomId: "jollity", messageType: "jollity.gamecard" }))

    // Then
    expect(listeners[0]).not.toHaveBeenCalled()
    expect(listeners[1]).toHaveBeenCalledOnce()
  })

  it("keeps the presses of the docked card after a message card is drawn", async () => {
    // Given
    const { host, manager, draw, press, actionSubscribe } = await hostWithFooterRenderer()
    const listeners: Record<string, ActionListener> = { "footer:jollity": vi.fn(), m1: vi.fn() }
    host.renderer.onRender((request, _send, onAction) => onAction(listeners[request.messageId]!))
    await flush()

    // When
    draw()
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})
    press({ context: { tag: "ChatRoomFooter", value: { roomId: "jollity", messageType: "jollity.gamecard" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(listeners["footer:jollity"]).toHaveBeenCalledWith("jollity.stash", undefined)
    expect(listeners.m1).not.toHaveBeenCalled()
    expect(actionSubscribe).toHaveBeenCalledTimes(1)
  })

  it("keeps the presses of a message card after the docked card is drawn", async () => {
    // Given
    const { host, manager, draw, press, actionSubscribe } = await hostWithFooterRenderer()
    const listeners: Record<string, ActionListener> = { "footer:jollity": vi.fn(), m1: vi.fn() }
    host.renderer.onRender((request, _send, onAction) => onAction(listeners[request.messageId]!))
    await flush()

    // When
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})
    draw()
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(listeners.m1).toHaveBeenCalledWith("jollity.stash", undefined)
    expect(listeners["footer:jollity"]).not.toHaveBeenCalled()
    expect(actionSubscribe).toHaveBeenCalledTimes(1)
  })

  it("stops the presses of a docked card when the host takes it down, and keeps listening for the others", async () => {
    // Given
    const { host, manager, draw, press, actionSubscribe, stopActions } = await hostWithFooterRenderer()
    const listeners: Record<string, ActionListener> = { "footer:jollity": vi.fn(), m1: vi.fn() }
    host.renderer.onRender((request, _send, onAction) => onAction(listeners[request.messageId]!))
    await flush()
    manager.render({ messageId: "m1", messageType: "jollity.gamecard", payload: Uint8Array.of(1) }).subscribe({})

    // When
    const teardown = draw()
    teardown?.()
    press(footerPress({ roomId: "jollity", messageType: "jollity.gamecard" }))
    press({ context: { tag: "ChatMessage", value: { messageId: "m1" } }, actionId: "jollity.stash", payload: "0x" })

    // Then
    expect(listeners["footer:jollity"]).not.toHaveBeenCalled()
    expect(listeners.m1).toHaveBeenCalledWith("jollity.stash", undefined)
    expect(actionSubscribe).toHaveBeenCalledTimes(1)
    expect(stopActions).not.toHaveBeenCalled()
  })

  it("stops drawing docked cards when the worker unsubscribes", async () => {
    // Given
    const { host, unregister } = await hostWithFooterRenderer()
    const unsubscribe = host.renderer.onRender(() => {})
    await flush()

    // When
    unsubscribe()

    // Then
    expect(unregister).toHaveBeenCalled()
  })
})

describe("a device permission works", () => {
  it.each([true, false])("passes on the answer %s of the host", async (granted) => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.requestDevicePermission).mockResolvedValue({ ok: true, value: granted } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const answer = await createWorkerHost().permissions.requestDevice("Camera")

    // Then
    expect(answer).toBe(granted)
  })
})

describe("a device permission fails", () => {
  it("answers undefined on an err Result, which is no answer of the player", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.requestDevicePermission).mockResolvedValue({ ok: false, error: new Error("host gone") } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const answer = await createWorkerHost().permissions.requestDevice("Camera")

    // Then
    expect(answer).toBeUndefined()
  })
})

describe("host identity works", () => {
  it("reads the native app name and version from truapi", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getTruApi).mockResolvedValue({
      system: {
        info: () => answered(undefined).then((result) => ({ ...result, value: { platform: "ios", name: "Polkadot Mobile", version: "1.4.2" } })),
      },
    } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const result = await createWorkerHost().hostInfo!()

    // Then
    expect(result).toEqual({ info: { name: "Polkadot Mobile", version: "1.4.2", platform: "ios" }, failed: false })
  })

  it("keeps the platform and the truapi release the host embeds, which decide whether Register is a slide", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getTruApi).mockResolvedValue({
      system: {
        info: () =>
          answered(undefined).then((result) => ({
            ...result,
            value: { platform: "Android", name: "Polkadot", version: "2.0.1", truapiVersion: "0.32.0" },
          })),
      },
    } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const result = await createWorkerHost().hostInfo!()

    // Then
    expect(result).toEqual({
      info: { name: "Polkadot", version: "2.0.1", platform: "Android", truapiVersion: "0.32.0" },
      failed: false,
    })
  })

  it("reports a host older than truapi 0.27 by a fixed version", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getTruApi).mockResolvedValueOnce({
      system: { info: () => Promise.reject(new RangeError("Offset is outside the bounds of the DataView")) },
    } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const result = await createWorkerHost().hostInfo!()

    // Then
    expect(result).toEqual({ info: { name: "", version: "older than truapi 0.27" }, failed: false })
  })

  it("marks an unavailable or rejected identity read without throwing", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const { createWorkerHost } = await import("./host")
    vi.mocked(sdk.getTruApi).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("gone"))

    // When / Then
    await expect(createWorkerHost().hostInfo!()).resolves.toEqual({ info: null, failed: false })
    await expect(createWorkerHost().hostInfo!()).resolves.toEqual({ info: null, failed: true })
  })

  it("bounds a host discovery that never answers and clears its deadline", async () => {
    // Given
    vi.useFakeTimers()
    try {
      const sdk = await import("@parity/product-sdk-host")
      vi.mocked(sdk.getTruApi).mockImplementationOnce(() => new Promise(() => {}))
      const { createWorkerHost } = await import("./host")

      // When
      const result = createWorkerHost().hostInfo!()
      await vi.advanceTimersByTimeAsync(1_000)

      // Then
      await expect(result).resolves.toEqual({ info: null, failed: true })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the room footer fails", () => {
  it("answers unsupported with no truapi client or when the host answers unsupported", async () => {
    // Given
    const refusing = { setRoomFooter: () => answered({ tag: "Unsupported" }) }

    // When
    const outcomes = [await footerAnswer(null), await footerAnswer(refusing)]

    // Then
    expect(outcomes).toEqual(["unsupported", "unsupported"])
  })

  it("names a room the product did not create, and never throws", async () => {
    // Given
    const unknown = { setRoomFooter: () => answered({ tag: "Domain", value: { tag: "V2", value: { tag: "UnknownRoom" } } }) }
    const throwing = { setRoomFooter: () => Promise.reject(new Error("gone")) }

    // When
    const outcomes = [await footerAnswer(unknown), await footerAnswer(throwing)]

    // Then
    expect(outcomes).toEqual(["unknown-room", "failed"])
  })

  it("answers failed on any other error of the domain", async () => {
    // Given
    const unknown = { setRoomFooter: () => answered({ tag: "Domain", value: { tag: "V2", value: { tag: "Unknown", value: { reason: "gone" } } } }) }

    // When
    const outcome = await footerAnswer(unknown)

    // Then
    expect(outcome).toBe("failed")
  })
})

describe("chain and account lookup works", () => {
  it("asks for the product account at the index it is given", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const getProductAccount = vi.fn(() => ({
      match: (ok: (account: { publicKey: Uint8Array }) => unknown) => ok({ publicKey: Uint8Array.of(9) }),
    }))
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ getProductAccount } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const publicKey = await createWorkerHost().productAccount("dim2.paseo", 1)

    // Then
    expect(publicKey).toEqual(Uint8Array.of(9))
    expect(getProductAccount).toHaveBeenCalledWith("dim2.paseo", 1)
  })

  it("takes the People genesis from discovery", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostChainInfo).mockResolvedValueOnce({ chains: { People: "0x01" } } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const genesis = await createWorkerHost().peopleGenesis()

    // Then
    expect(genesis).toBe("0x01")
  })
})

describe("Asset Hub discovery works", () => {
  it("takes the Asset Hub genesis from discovery", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostChainInfo).mockResolvedValueOnce({ chains: { AssetHub: "0x02" } } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const genesis = await createWorkerHost().assetHubGenesis()

    // Then
    expect(genesis).toBe("0x02")
    expect(sdk.getHostChainInfo).toHaveBeenCalledWith(["AssetHub"])
  })

  it("takes no Asset Hub genesis when discovery fails", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostChainInfo).mockRejectedValueOnce(new Error("no handler"))
    const { createWorkerHost } = await import("./host")

    // When
    const genesis = await createWorkerHost().assetHubGenesis()

    // Then
    expect(genesis).toBeNull()
  })

  it("takes no Asset Hub genesis when discovery never answers", async () => {
    // Given
    vi.useFakeTimers()
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostChainInfo).mockReturnValueOnce(new Promise(() => {}) as never)
    const { createWorkerHost } = await import("./host")

    // When
    const pending = createWorkerHost().assetHubGenesis()
    await vi.advanceTimersByTimeAsync(5_000)
    const genesis = await pending
    vi.useRealTimers()

    // Then
    expect(genesis).toBeNull()
  })
})

describe("chain and account lookup fails", () => {
  it("takes no People genesis when discovery fails", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostChainInfo).mockRejectedValueOnce(new Error("no handler"))
    const { createWorkerHost } = await import("./host")

    // When
    const genesis = await createWorkerHost().peopleGenesis()

    // Then
    expect(genesis).toBeNull()
  })

  it("takes no People genesis when discovery never answers", async () => {
    // Given
    vi.useFakeTimers()
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostChainInfo).mockReturnValueOnce(new Promise(() => {}) as never)
    const { createWorkerHost } = await import("./host")

    // When
    const pending = createWorkerHost().peopleGenesis()
    await vi.advanceTimersByTimeAsync(5_000)
    const genesis = await pending
    vi.useRealTimers()

    // Then
    expect(genesis).toBeNull()
  })

  it("answers null for a chain the host does not serve", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostProvider).mockRejectedValueOnce(new sdk.ChainNotSupportedError("nope" as never))
    const { createWorkerHost } = await import("./host")

    // When
    const provider = await createWorkerHost().chainProvider("0x02")

    // Then
    expect(provider).toBeNull()
  })
})

const TOP_UP_ID = `0x${"ab".repeat(32)}` as const
const topUpRefusal = (tag: string) =>
  new Error(`payment topUp failed: ${tag}`, { cause: { tag: "Domain", value: { tag: "V2", value: { tag } } } })

async function topUpWith(payments: unknown) {
  const sdk = await import("@parity/product-sdk-host")
  vi.mocked(sdk.getPaymentManager).mockResolvedValue(payments as never)
  const { createWorkerHost } = await import("./host")
  return createWorkerHost()
}

describe("prize top-up works", () => {
  it("tops up from the product account at the index under the id", async () => {
    const topUp = vi.fn(async () => {})
    const host = await topUpWith({ topUp })

    const outcome = await host.topUp(1, 60_000_000n, TOP_UP_ID)

    expect(outcome).toBe("sent")
    expect(topUp).toHaveBeenCalledWith({
      id: TOP_UP_ID,
      amount: 60_000_000n,
      source: { tag: "ProductAccount", value: { derivationIndex: { tag: "Index", value: 1 } } },
    })
  })
})

describe("prize top-up fails", () => {
  it("answers no-host outside a host", async () => {
    const host = await topUpWith(null)

    expect(await host.topUp(1, 1n, TOP_UP_ID)).toBe("no-host")
  })

  it("answers refused when the host cannot hand over its payments", async () => {
    const host = await topUpWith(null)
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getPaymentManager).mockRejectedValueOnce(new Error("no client"))

    expect(await host.topUp(1, 1n, TOP_UP_ID)).toBe("refused")
  })

  it("names the refusals of the host", async () => {
    const host = await topUpWith({
      topUp: vi
        .fn()
        .mockRejectedValueOnce(topUpRefusal("AlreadyExists"))
        .mockRejectedValueOnce(topUpRefusal("SourceBusy"))
        .mockRejectedValueOnce(topUpRefusal("InvalidSource")),
    })

    expect(await host.topUp(1, 1n, TOP_UP_ID)).toBe("already-sent")
    expect(await host.topUp(1, 1n, TOP_UP_ID)).toBe("busy")
    expect(await host.topUp(1, 1n, TOP_UP_ID)).toBe("refused")
  })

  it("answers timeout when the host never answers", async () => {
    vi.useFakeTimers()
    const host = await topUpWith({ topUp: () => new Promise(() => {}) })

    const pending = host.topUp(1, 1n, TOP_UP_ID)
    await vi.advanceTimersByTimeAsync(10_100)
    const outcome = await pending
    vi.useRealTimers()

    expect(outcome).toBe("timeout")
  })
})

/** A ResultAsync of the SDK that holds `value`, or the error when `failed`. */
const answer = (value: unknown, failed = false) => ({
  match: (ok: (value: unknown) => unknown, err: (error: unknown) => unknown) => (failed ? err(value) : ok(value)),
})

const INPUTS = {
  owner: "peopl.paseo",
  context: { productId: "peopl.paseo", index: 0 },
  ring: { chainId: "0x01" as const, junctions: [{ tag: "CollectionId" as const, value: "0x02" as const }] },
}
/** the people-lite ring the sign-up asks the host about, and the people ring a member proves a draw in */
const LITE = { key: "lite" as const, owner: "peopl.paseo", ring: INPUTS.ring }
const MEMBER = { key: "full" as const, owner: "peopl.paseo", ring: INPUTS.ring }

describe("account signing works", () => {
  it("hands over the signer of the product account it is asked for", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const account = { dotNsIdentifier: "dim2.paseo", derivationIndex: 1, publicKey: Uint8Array.of(9) }
    const getProductAccountSigner = vi.fn(() => "the signer")
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ getProductAccount: vi.fn(() => answer(account)), getProductAccountSigner } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const signer = await createWorkerHost().accounts.signer("dim2.paseo", 1)

    // Then
    expect(signer).toBe("the signer")
    expect(getProductAccountSigner).toHaveBeenCalledWith(account)
  })

  it("signs a draw ticket with the product account it is asked for", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const signature = { preOutput: Uint8Array.of(1), proof: Uint8Array.of(2) }
    const signVrf = vi.fn(() => answer(signature))
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ signVrf } as never)
    const { createWorkerHost } = await import("./host")
    const items = [{ label: Uint8Array.of(3), value: Uint8Array.of(4) }]

    // When
    const signed = await createWorkerHost().accounts.signVrf("dim2.paseo", 1)(Uint8Array.of(5), items)

    // Then
    expect(signed).toEqual(signature)
    expect(signVrf).toHaveBeenCalledWith({ dotNsIdentifier: "dim2.paseo", derivationIndex: 1 }, Uint8Array.of(5), items)
  })

  it("finds the lite key under the ring shape the host holds it in, and proves in the context of the inputs", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const createRingVRFProof = vi.fn(() => answer("the proof"))
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ listRingVrfKeys: vi.fn(() => answer(["a key"])), createRingVRFProof } as never)
    vi.mocked(sdk.findRingVrfKeyHandle).mockImplementation((_keys, ring) =>
      (ring.junctions[0]?.tag === "PalletInstance" ? "the handle" : undefined) as never,
    )
    const { createWorkerHost } = await import("./host")
    const host = createWorkerHost()

    // When
    const keys = host.accounts.personhood()
    const holds = await keys.holds(LITE)
    const proof = await keys.prove(LITE, { productId: "peopl.paseo", suffix: { tag: "Index", value: 0 } }, Uint8Array.of(7))

    // Then
    expect(holds).toBe(true)
    expect(proof).toBe("the proof")
    expect(createRingVRFProof).toHaveBeenCalledWith(
      "the handle",
      { productId: "peopl.paseo", suffix: { tag: "Index", value: 0 } },
      { chainId: "0x01", junctions: [{ tag: "PalletInstance", value: 67 }, ...INPUTS.ring.junctions] },
      Uint8Array.of(7),
    )
  })

  it("proves a member's draw with the people-ring key, in the draw's own context, looking the key up once", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const listRingVrfKeys = vi.fn(() => answer(["a key"]))
    const createRingVRFProof = vi.fn(() => answer("the proof"))
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ listRingVrfKeys, createRingVRFProof } as never)
    vi.mocked(sdk.findRingVrfKeyHandle).mockImplementation((_keys, ring) =>
      (ring.junctions[0]?.tag === "PalletInstance" ? "the handle" : undefined) as never,
    )
    const { createWorkerHost } = await import("./host")
    const keys = createWorkerHost().accounts.personhood()
    const context = (event: string) => ({ productId: "dim2.paseo", suffix: { tag: "Raw" as const, value: event } })

    // When
    const first = await keys.prove(MEMBER, context("0x0a"), Uint8Array.of(7))
    const second = await keys.prove(MEMBER, context("0x0b"), Uint8Array.of(8))

    // Then
    expect([first, second]).toEqual(["the proof", "the proof"])
    const ring = { chainId: "0x01", junctions: [{ tag: "PalletInstance", value: 67 }, ...INPUTS.ring.junctions] }
    expect(createRingVRFProof).toHaveBeenNthCalledWith(1, "the handle", context("0x0a"), ring, Uint8Array.of(7))
    expect(createRingVRFProof).toHaveBeenNthCalledWith(2, "the handle", context("0x0b"), ring, Uint8Array.of(8))
    expect(listRingVrfKeys).toHaveBeenCalledWith("peopl.paseo")
    expect(listRingVrfKeys).toHaveBeenCalledTimes(1)
  })

  it("derives entropy from the key it is given", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.deriveEntropy).mockResolvedValue({ ok: true, value: Uint8Array.of(8) } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const entropy = await createWorkerHost().entropy(Uint8Array.of(1))

    // Then
    expect(entropy).toEqual(Uint8Array.of(8))
    expect(sdk.deriveEntropy).toHaveBeenCalledWith(Uint8Array.of(1))
  })
})

describe("account signing fails", () => {
  it("hands over no signer from a host with no accounts, and no lite key to a person it holds none for", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getAccountsProvider).mockResolvedValueOnce(null)
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ listRingVrfKeys: vi.fn(() => answer([])) } as never)
    vi.mocked(sdk.findRingVrfKeyHandle).mockReturnValue(undefined)
    const { createWorkerHost } = await import("./host")
    const host = createWorkerHost()

    // When
    const signer = await host.accounts.signer("dim2.paseo", 1)
    const holds = await host.accounts.personhood().holds(LITE)

    // Then
    expect([signer, holds]).toEqual([null, false])
  })

  it("rejects when the host cannot list the lite keys, rather than take the person for nobody", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ listRingVrfKeys: vi.fn(() => answer("Denied", true)) } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const listing = createWorkerHost().accounts.personhood().holds(LITE)

    // Then
    await expect(listing).rejects.toThrow("the host could not list the keys of peopl.paseo: Denied")
  })

  it("rejects a member's draw proof without a key or refused, and looks the key up again after a lookup that failed", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const listRingVrfKeys = vi.fn().mockReturnValueOnce(answer([])).mockReturnValue(answer(["a key"]))
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ listRingVrfKeys, createRingVRFProof: vi.fn(() => answer("Rejected", true)) } as never)
    vi.mocked(sdk.findRingVrfKeyHandle).mockImplementation((keys) => (keys.length ? "the handle" : undefined) as never)
    const { createWorkerHost } = await import("./host")
    const keys = createWorkerHost().accounts.personhood()
    const context = { productId: "dim2.paseo", suffix: { tag: "Raw" as const, value: "0x0a" } }

    // When
    const keyless = keys.prove(MEMBER, context, Uint8Array.of(7))
    await expect(keyless).rejects.toThrow("no peopl.paseo key for the people ring on this host")
    const refused = keys.prove(MEMBER, context, Uint8Array.of(7))

    // Then
    await expect(refused).rejects.toThrow("the host refused the draw proof: Rejected")
    expect(listRingVrfKeys).toHaveBeenCalledTimes(2)
  })

  it("rejects a draw ticket or a lite proof the host refuses", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({
      signVrf: vi.fn(() => answer("Rejected", true)),
      listRingVrfKeys: vi.fn(() => answer(["a key"])),
      createRingVRFProof: vi.fn(() => answer("Rejected", true)),
    } as never)
    vi.mocked(sdk.findRingVrfKeyHandle).mockReturnValue("the handle" as never)
    const { createWorkerHost } = await import("./host")
    const host = createWorkerHost()

    // When
    const ticket = host.accounts.signVrf("dim2.paseo", 1)(Uint8Array.of(5), [])
    const proof = host.accounts.personhood().prove(LITE, { productId: "peopl.paseo", suffix: { tag: "Index", value: 0 } }, Uint8Array.of(7))

    // Then
    await expect(ticket).rejects.toThrow("the host refused the draw ticket: Rejected")
    await expect(proof).rejects.toThrow("the host refused the lite proof: Rejected")
  })

  it("bounds every host call of the sign-up that never answers, and names it", async () => {
    // Given: a host that drops its answers, as product-sdk-host does for a call truapi rejects
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const sdk = await import("@parity/product-sdk-host")
      const never = () => new Promise(() => {})
      vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ signVrf: vi.fn(never), listRingVrfKeys: vi.fn(never), createRingVRFProof: vi.fn(never) } as never)
      vi.mocked(sdk.findRingVrfKeyHandle).mockReturnValue("the handle" as never)
      const { createWorkerHost } = await import("./host")
      const { rejectionDetails } = await import("./telemetry")
      const host = createWorkerHost()
      const settle = (call: Promise<unknown>) => call.then(() => "answered", (reason: unknown) => reason)

      // When
      const calls = [
        settle(host.accounts.signVrf("dim2.paseo", 1)(Uint8Array.of(5), [])),
        settle(host.accounts.personhood().holds(LITE)),
        settle(host.accounts.personhood().prove(LITE, { productId: "peopl.paseo", suffix: { tag: "Index", value: 0 } }, Uint8Array.of(7))),
        settle(host.accounts.personhood().prove(MEMBER, { productId: "dim2.paseo", suffix: { tag: "Raw", value: "0x0a" } }, Uint8Array.of(7))),
      ]
      await vi.advanceTimersByTimeAsync(30_000)

      // Then
      const named = (await Promise.all(calls)).map((reason) => rejectionDetails(reason).tags["host.call"])
      expect(named).toEqual(["accounts.signVrf", "accounts.liteKey", "accounts.liteProof", "accounts.memberDrawProof"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("derives no entropy when the host refuses", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.deriveEntropy).mockResolvedValue({ ok: false, error: "Denied" } as never)
    const { createWorkerHost } = await import("./host")

    // When
    const entropy = await createWorkerHost().entropy(Uint8Array.of(1))

    // Then
    expect(entropy).toBeNull()
  })
})

describe("host call telemetry", () => {
  it("keeps the original error and names the owned doorway call", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const error = new TypeError("host:19 rejected wire method 4")
    vi.mocked(sdk.getHostLocalStorage).mockResolvedValue({ readJSON: vi.fn().mockRejectedValue(error) } as never)
    const { createWorkerHost } = await import("./host")
    const { rejectionDetails } = await import("./telemetry")

    // When
    const rejected = await createWorkerHost().storage.readJSON("game").catch((reason) => reason)

    // Then
    expect(rejected).toBe(error)
    expect(rejectionDetails(rejected)).toMatchObject({
      tags: {
        "error.class": "TypeError",
        "host.call": "storage.readJSON",
        "host.request_id": "19",
        "host.wire_method": "4",
      },
      context: { host_call: "storage.readJSON" },
    })
  })
})

describe("the TURN pass works", () => {
  const GENESIS = `0x${"ab".repeat(32)}`
  const result = (value: unknown, failed = false) => ({
    isErr: () => failed,
    isOk: () => !failed,
    value,
    error: value,
    match: (ok: (value: unknown) => unknown, err: (error: unknown) => unknown) => (failed ? err(value) : ok(value)),
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("proves at the stamp it is given, redeems the proof and returns the pass", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-host")
    const createRingVRFProof = vi.fn(() => result({ proof: Uint8Array.of(1, 2), ringIndex: 5, ringRevision: 6 }))
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ listRingVrfKeys: vi.fn(() => result(["a key"])), createRingVRFProof } as never)
    vi.mocked(sdk.findRingVrfKeyHandle).mockReturnValue("the handle" as never)
    vi.mocked(sdk.getHostChainInfo).mockResolvedValue({ chains: { People: GENESIS } } as never)
    const fetch = vi.fn(async () => ({
      status: 201,
      json: async () => ({ servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800 }),
    }))
    vi.stubGlobal("fetch", fetch)
    const { createWorkerHost } = await import("./host")
    const before = Date.now()

    // When
    const outcome = await createWorkerHost().turnPass({ productId: "dim2.testnet", account: Uint8Array.of(7), issuer: "https://issuer.example", timestamp: 1_790_000_000 })

    // Then
    expect(outcome).toEqual({
      pass: { turn: [{ urls: "turn:relay.example:3478", username: "u", credential: "p" }], expiresAtWallMs: expect.any(Number) },
    })
    expect((outcome as { pass: { expiresAtWallMs: number } }).pass.expiresAtWallMs).toBeGreaterThanOrEqual(before + 1_795_000)
    expect(fetch).toHaveBeenCalledWith("https://issuer.example/api/v1/turn/issue-with-proof", expect.objectContaining({ method: "POST" }))
    const calls = fetch.mock.calls as unknown as [string, { body: string }][]
    expect(JSON.parse(calls[0]![1].body)).toMatchObject({ productId: "dim2.testnet", proof: "0x0102", ringIndex: 5, ringRevision: 6, timestamp: 1_790_000_000 })
  })
})

describe("the TURN pass fails", () => {
  const GENESIS = `0x${"ab".repeat(32)}`
  const NOT_ALLOWLISTED = { tag: "Domain", value: { tag: "V1", value: { tag: "NotAllowlisted" } } }
  const result = (value: unknown, failed = false) => ({
    isErr: () => failed,
    isOk: () => !failed,
    value,
    error: value,
    match: (ok: (value: unknown) => unknown, err: (error: unknown) => unknown) => (failed ? err(value) : ok(value)),
  })

  async function hostProving(createRingVRFProof: () => unknown, answer: () => Promise<unknown>) {
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getAccountsProvider).mockResolvedValue({ listRingVrfKeys: vi.fn(() => result(["a key"])), createRingVRFProof } as never)
    vi.mocked(sdk.findRingVrfKeyHandle).mockReturnValue("the handle" as never)
    vi.mocked(sdk.getHostChainInfo).mockResolvedValue({ chains: { People: GENESIS } } as never)
    const fetch = vi.fn(answer)
    vi.stubGlobal("fetch", fetch)
    const { createWorkerHost } = await import("./host")
    return { host: createWorkerHost(), fetch }
  }

  const proved = () => result({ proof: Uint8Array.of(1), ringIndex: 0, ringRevision: 0 })
  const INPUT = { productId: "dim2.testnet", account: Uint8Array.of(7), issuer: "https://issuer.example", timestamp: 1_790_000_000 }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("names a grant that does not allow the product, and asks no issuer", async () => {
    // Given
    const { host, fetch } = await hostProving(() => result(NOT_ALLOWLISTED, true), async () => ({}))

    // When
    const outcome = await host.turnPass(INPUT)

    // Then
    expect(outcome).toMatchObject({ stage: "proof", cause: "grant-missing" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("names the refusal of the issuer by its status", async () => {
    // Given
    const { host } = await hostProving(proved, async () => ({ status: 429, json: async () => ({}), text: async () => '{"error":"redemption limit reached"}' }))

    // When
    const outcome = await host.turnPass(INPUT)

    // Then
    expect(outcome).toEqual({ stage: "issue", cause: "redemption-limit", status: 429, reason: "redemption limit reached" })
  })

  it("names a proof the host never gives as a timeout", async () => {
    // Given
    vi.useFakeTimers()
    // a host's ResultAsync that never settles
    const { host, fetch } = await hostProving(() => ({ match: () => new Promise(() => {}) }), async () => ({}))

    // When
    const outcome = host.turnPass(INPUT)
    await vi.advanceTimersByTimeAsync(5_000)

    // Then
    await expect(outcome).resolves.toMatchObject({ stage: "proof", cause: "timeout" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("names a host with no People genesis", async () => {
    // Given
    const { host } = await hostProving(proved, async () => ({}))
    const sdk = await import("@parity/product-sdk-host")
    vi.mocked(sdk.getHostChainInfo).mockResolvedValue({ chains: {} } as never)

    // When
    const outcome = await host.turnPass(INPUT)

    // Then
    expect(outcome).toMatchObject({ stage: "proof", cause: "no-chain-info" })
  })
})

it("uses explicit local hashes for chain providers and TURN proofs without discovery", async () => {
  const { localEnv } = await import("../../../packages/jollity-protocol/src/local-network.fixture")
  for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value)
  try {
    const sdk = await import("@parity/product-sdk-host")
    const { createWorkerHost } = await import("./host")
    const host = createWorkerHost()
    expect(await host.peopleGenesis()).toBe(localEnv.NEXT_PUBLIC_PEOPLE_GENESIS)
    expect(await host.assetHubGenesis()).toBe(localEnv.NEXT_PUBLIC_ASSET_HUB_GENESIS)
    expect(sdk.getHostChainInfo).not.toHaveBeenCalled()
    await host.chainProvider((await host.peopleGenesis())!)
    expect(sdk.getHostProvider).toHaveBeenCalledWith(localEnv.NEXT_PUBLIC_PEOPLE_GENESIS)
  } finally {
    vi.unstubAllEnvs()
  }
})
