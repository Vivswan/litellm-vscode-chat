import fs from "node:fs/promises";
import path from "node:path";

interface EsbuildMetafile {
	inputs: Record<string, unknown>;
}

/** Extracts the unique npm package names that esbuild actually bundled, from its metafile inputs. */
function bundledPackages(metafile: EsbuildMetafile): string[] {
	const packages = new Set<string>();
	for (const input of Object.keys(metafile.inputs)) {
		const match = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
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
	const metafilePath = path.join(root, "out", "esbuild-meta.json");
	let metafile: EsbuildMetafile;
	try {
		metafile = JSON.parse(await fs.readFile(metafilePath, "utf8")) as EsbuildMetafile;
	} catch {
		throw new Error(`Missing or unreadable ${metafilePath}; run the production bundle first (bun run bundle).`);
	}
	const deps = bundledPackages(metafile);

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
