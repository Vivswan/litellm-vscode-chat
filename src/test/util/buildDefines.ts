/**
 * The build-time constants scripts/dev/bundle.mts defines for the shipped bundles, set as globals for the two
 * runners that load the source unbundled: bun through bunfig.toml's preload, the extension host through every
 * label's mocha.require in .vscode-test.mjs. Each value is read from the manifest field the bundle reads, so a
 * test sees what the build ships and never a spelling of its own.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./repoRoot";

const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
	repository: { url: string };
};

(globalThis as Record<string, unknown>).__LITELLM_REPOSITORY_URL__ = manifest.repository.url;
