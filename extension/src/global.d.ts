// esbuild's `define` (see build.mjs) substitutes process.env.NODE_ENV with a
// literal string at bundle time — this is browser code, there's no real
// `process` global at runtime beyond what gets inlined. A minimal ambient
// type for just this, rather than pulling all of @types/node into a
// browser-extension typecheck.
declare const process: { env: { NODE_ENV?: string } };
