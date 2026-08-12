import fs from "node:fs/promises";
import path from "node:path";

interface BundleMeta {
	moduleIds: string[];
}

/** Extracts the unique npm package names that the bundler actually bundled, from its module list. */
function bundledPackages(meta: BundleMeta): string[] {
	const packages = new Set<string>();
	for (const id of meta.moduleIds) {
		// Rolldown module ids are absolute OS paths; normalize Windows separators.
		const match = id.replaceAll("\\", "/").match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
		if (match?.[1]) {
			packages.add(match[1]);
		}
	}
	return [...packages].sort();
}

async function readLicenseTexts(depDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(depDir);
	} catch {
		return [];
	}
	const files = entries.filter((name) => /^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(name)).sort();
	return Promise.all(files.map((name) => fs.readFile(path.join(depDir, name), "utf8")));
}

async function main(): Promise<void> {
	const root = process.cwd();
	const metaPath = path.join(root, "out", "bundle-meta.json");
	let meta: BundleMeta;
	try {
		meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as BundleMeta;
	} catch {
		throw new Error(`Missing or unreadable ${metaPath}; run the production bundle first (bun run bundle).`);
	}
	const deps = bundledPackages(meta);

	// A silently empty or partial module list would ship a legally wrong
	// notices file: every runtime dependency must have reached a bundle.
	const declared = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const missing = Object.keys(declared.dependencies ?? {}).filter((name) => !deps.includes(name));
	if (missing.length > 0) {
		throw new Error(`Bundle metadata lists no modules from declared dependencies: ${missing.join(", ")}`);
	}

	const sections: string[] = [
		"Third-party notices for litellm-vscode-chat",
		"",
		"The bundled extension includes code from the following npm packages.",
		"",
	];

	if (deps.length === 0) {
		sections.push("(none: the extension currently bundles no third-party code)");
	}

	for (const dep of deps) {
		const depDir = path.join(root, "node_modules", dep);
		const depPkg = JSON.parse(await fs.readFile(path.join(depDir, "package.json"), "utf8")) as {
			version?: string;
			license?: string;
		};
		sections.push("---", "", `${dep} ${depPkg.version ?? ""} (${depPkg.license ?? "license unspecified"})`, "");
		const licenses = await readLicenseTexts(depDir);
		if (licenses.length > 0) {
			for (const text of licenses) {
				sections.push(text.trimEnd(), "");
			}
		} else {
			sections.push(`(no license file shipped in the package; see https://www.npmjs.com/package/${dep})`, "");
		}
	}

	await fs.writeFile(path.join(root, "ThirdPartyNotices.txt"), `${sections.join("\n").trimEnd()}\n`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
