/**
 * The streaming transport's import surface: StreamProcessor turns a raw SSE
 * response body into host response parts under the pinned log-and-skip
 * leniency contract, with processor.ts owning every parsing and emission
 * decision.
 */

export type { ToolCallIdSource } from "./processor";
export { StreamProcessor } from "./processor";
