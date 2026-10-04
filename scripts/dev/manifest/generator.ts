/**
 * The manifest generator: which contributes blocks package.json takes from the sources, and the one render both the
 * CLI's modes and the hook's staging run go through. A new generated block registers in `regenerateManifest`'s block
 * record and nowhere else.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Generator } from "../staging";
import { renderConfiguration } from "./configuration";
import { applyContributes, type ManifestRegeneration } from "./write";

export const MANIFEST_PATH = "package.json";

export interface RegeneratedManifest extends ManifestRegeneration {
	/** The manifest text as read from `root`, for the modes that compare or report instead of writing. */
	readonly current: string;
}

export function regenerateManifest(root: string): RegeneratedManifest {
	const current = fs.readFileSync(path.join(root, MANIFEST_PATH), "utf8");
	return { current, ...applyContributes(current, { configuration: renderConfiguration() }) };
}

export const MANIFEST_GENERATOR = {
	label: "manifest",
	outputs: [MANIFEST_PATH],
	render: (root: string) => [{ relativePath: MANIFEST_PATH, next: regenerateManifest(root).next }],
} satisfies Generator;
