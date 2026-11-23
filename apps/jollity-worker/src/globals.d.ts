// Build-time defines that scripts/build.mjs bakes in. Its header explains why
// PRODUCT_DOTNS is mandatory.
declare const __PRODUCT_DOTNS__: string
declare const __BOT_ICON__: string
declare const __ROOM_ICON__: string
declare const __SENTRY_DSN__: string
declare const __SENTRY_DSN_TEST__: string
declare const __CHAT_RELEASE__: string
/** Whether this build posts the Daily Dollar scratch card the worker draws (scratch-worker.ts): "worker" or "none". */
declare const __DD_SCRATCH__: "worker" | "none"
