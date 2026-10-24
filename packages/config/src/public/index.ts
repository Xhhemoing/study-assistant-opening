// Client-safe entry: `@aistudy/config/public`. Never re-export server config here.
export * from "./capabilities";
export * from "./senseweave";
export { computeBuildConfigDigest } from "./build-config.mjs";
