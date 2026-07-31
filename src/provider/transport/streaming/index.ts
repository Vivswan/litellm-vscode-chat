/**
 * The streaming transport: StreamProcessor turns a raw SSE response body into
 * host response parts under the pinned log-and-skip leniency contract. sse.ts
 * frames the byte stream into data payloads, processor.ts owns every parsing
 * and emission decision, media.ts decodes generated image/audio payloads,
 * thinking.ts extracts reasoning content, and usage.ts sanitizes the usage
 * trailer. This index is the import surface.
 */

export type { ToolCallIdSource } from "./processor";
export { StreamProcessor } from "./processor";
