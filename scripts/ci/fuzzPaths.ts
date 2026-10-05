/**
 * The fuzzers and everything that decides what they run: the stream and monkey fuzzers with their corpus and seed
 * plumbing, the fast-check property suites, the canned stream scenarios, the fake stack the fuzzers drive, the
 * streaming transport whose leniency contract the fuzzer pins, the bun leg's root and preload, and the docker
 * orchestrator with its label list. A rename here is pinned by src/test/bun/scripts/ci/fuzzPaths.test.ts.
 */
export const FUZZ_PATHS = {
	files: [
		"bunfig.toml",
		"scripts/docker-test.ts",
		"scripts/stack/fake-openai-server.ts",
		"src/test/bun/preload.ts",
		"src/test/dockerTestLabels.ts",
	],
	directories: ["src/provider/transport/streaming/"],
	/** Name prefixes under either test root: fuzzSeed.ts, monkeyCorpus.ts, scenarios.test.ts, fakeStack/models.ts. */
	testRoots: ["src/test/", "src/test/bun/"],
	testNames: [
		"docker-conversation.test.ts",
		"docker-fuzz.test.ts",
		"docker-monkey.test.ts",
		"fakeStack/",
		"fuzz",
		"monkey",
		"scenarios",
	],
	suffixes: [".property.test.ts"],
} as const;

export function fuzzPathsHit(changed: readonly string[]): boolean {
	const files: ReadonlySet<string> = new Set(FUZZ_PATHS.files);
	return changed.some(
		(file) =>
			files.has(file) ||
			FUZZ_PATHS.directories.some((directory) => file.startsWith(directory)) ||
			FUZZ_PATHS.testRoots.some(
				(root) => file.startsWith(root) && FUZZ_PATHS.testNames.some((name) => file.startsWith(name, root.length))
			) ||
			FUZZ_PATHS.suffixes.some((suffix) => file.endsWith(suffix))
	);
}
