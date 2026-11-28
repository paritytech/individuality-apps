// Build-time defines that scripts/build.mjs bakes in. Its header explains why
// PRODUCT_DOTNS is mandatory.
declare const __PRODUCT_DOTNS__: string
declare const __BOT_ICON__: string
declare const __ROOM_ICON__: string
declare const __SENTRY_DSN__: string
declare const __SENTRY_DSN_TEST__: string
declare const __CHAT_RELEASE__: string
/** How the worker slider follows the finger (src/gesture-slider.ts): "host-driven" or "every-move". */
declare const __GESTURE_MODE__: "host-driven" | "every-move"
