/**
 * Replaces generated blocks inside package.json without disturbing anything else: the file is parsed whole, each block
 * is assigned onto its existing contributes key (assignment keeps the key's position), and the result is serialized the
 * way the repository formats the manifest (tabs, trailing newline). Drift is reported per block so a stale manifest
 * names its cause, and compares serialized text, so a reordered key inside a block counts: the key order is part of
 * what the generator owns.
 */
interface Manifest {
	readonly contributes: Record<string, unknown>;
}

export interface ManifestRegeneration {
	readonly next: string;
	readonly drifted: readonly string[];
}

/** Tab-indented with a trailing newline: the formatting the repository's package.json uses. */
export function serializeManifest(manifest: unknown): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

export function applyContributes(
	manifestText: string,
	blocks: Readonly<Record<string, unknown>>
): ManifestRegeneration {
	const manifest = JSON.parse(manifestText) as Manifest;
	if (manifest.contributes === undefined || manifest.contributes === null || typeof manifest.contributes !== "object") {
		throw new Error("package.json has no contributes object");
	}
	const drifted: string[] = [];
	for (const [key, block] of Object.entries(blocks)) {
		if (!Object.hasOwn(manifest.contributes, key)) {
			throw new Error(`package.json contributes no ${key} block to regenerate`);
		}
		if (JSON.stringify(manifest.contributes[key]) !== JSON.stringify(block)) {
			drifted.push(key);
		}
		manifest.contributes[key] = block;
	}
	return { next: serializeManifest(manifest), drifted };
}
