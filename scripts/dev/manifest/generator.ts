/**
 * The manifest generator: every contributes block of package.json rendered from the sources, and the one render the
 * CLI's modes go through. A new generated block registers in `renderContributes` (contributions.ts) and nowhere else.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { renderContributes } from "./contributions";
import { applyContributes, type ManifestRegeneration } from "./write";

export const MANIFEST_PATH = "package.json";

export interface RegeneratedManifest extends ManifestRegeneration {
	/** The manifest text as read from `root`, for the modes that compare or report instead of writing. */
	readonly current: string;
}

export function regenerateManifest(root: string): RegeneratedManifest {
	const current = fs.readFileSync(path.join(root, MANIFEST_PATH), "utf8");
	return { current, ...applyContributes(current, renderContributes()) };
}
