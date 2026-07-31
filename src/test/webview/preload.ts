/**
 * Preload for the bun-test webview suite (wired via bunfig.toml). Registers
 * the happy-dom globals and installs the acquireVsCodeApi stub before any
 * test module loads: vscodeApi.ts calls acquireVsCodeApi() at module top
 * level, so a component import without the stub is an import-time crash. The
 * harness is imported dynamically so the DOM registration above runs first
 * (static imports would hoist past it).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const { installAcquireVsCodeApi } = await import("./harness");
installAcquireVsCodeApi();
