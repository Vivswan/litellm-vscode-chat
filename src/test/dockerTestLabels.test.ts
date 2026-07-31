import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { DOCKER_TEST_LABELS, parseOnlyLabels } from "./dockerTestLabels";

/**
 * Pins the label grammar behind `bun run test:docker --only ...`, which the
 * CI shard matrices in checks.yml drive. The selection rules are contracts:
 * canonical order (docker-monkey last) regardless of flag order, loud
 * rejection of anything unknown, and a round-trip identity for the full set
 * so --only can never diverge from the default run's leg list.
 */

suite("dockerTestLabels: parseOnlyLabels", () => {
	test("a single label selects exactly itself", () => {
		assert.deepStrictEqual(parseOnlyLabels("docker-serversync"), ["docker-serversync"]);
	});

	test("the selection replays canonical order (monkey last) regardless of input order", () => {
		assert.deepStrictEqual(parseOnlyLabels("docker-monkey,host-fidelity,docker"), [
			"docker",
			"host-fidelity",
			"docker-monkey",
		]);
	});

	test("duplicates collapse to one run", () => {
		assert.deepStrictEqual(parseOnlyLabels("docker,docker"), ["docker"]);
	});

	test("whitespace around entries is trimmed", () => {
		assert.deepStrictEqual(parseOnlyLabels(" docker , docker-fuzz "), ["docker", "docker-fuzz"]);
	});

	test("the full label list round-trips to the canonical set", () => {
		assert.deepStrictEqual(parseOnlyLabels(DOCKER_TEST_LABELS.join(",")), [...DOCKER_TEST_LABELS]);
	});

	test("an unknown label throws naming it and every known label", () => {
		assert.throws(
			() => parseOnlyLabels("docker,docker-transprot"),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.ok(message.includes('unknown label "docker-transprot"'), message);
				for (const label of DOCKER_TEST_LABELS) {
					assert.ok(message.includes(label), `error message names ${label}: ${message}`);
				}
				return true;
			}
		);
	});

	test("empty values and empty entries throw", () => {
		assert.throws(() => parseOnlyLabels(""), /empty label/);
		assert.throws(() => parseOnlyLabels("docker,,docker-fuzz"), /empty label/);
		assert.throws(() => parseOnlyLabels("docker,"), /empty label/);
	});
});

suite("dockerTestLabels: .vscode-test.mjs mirror", () => {
	// The orchestrator passes each selected label to `vscode-test --label`,
	// but .vscode-test.mjs cannot import this module, so the two label sets
	// would otherwise drift silently: a rename there surfaces only when the
	// renamed leg next runs, and a new docker leg declared only there would
	// never run anywhere - not in the orchestrator, not in a CI shard.
	function declaredLabels(): string[] {
		const config = fs.readFileSync(path.resolve(__dirname, "..", "..", ".vscode-test.mjs"), "utf8");
		const declared = [...config.matchAll(/^\s*label: "([^"]+)",$/gm)].map((match) => match[1] as string);
		assert.ok(declared.length >= DOCKER_TEST_LABELS.length, `found ${declared.length} labels in .vscode-test.mjs`);
		return declared;
	}

	test("every canonical label is a vscode-test label", () => {
		const declared = declaredLabels();
		for (const label of DOCKER_TEST_LABELS) {
			assert.ok(declared.includes(label), `.vscode-test.mjs declares no "${label}" label`);
		}
	});

	test("every docker-prefixed vscode-test label is canonical", () => {
		const canonical: ReadonlySet<string> = new Set(DOCKER_TEST_LABELS);
		for (const label of declaredLabels().filter((name) => name.startsWith("docker"))) {
			assert.ok(canonical.has(label), `.vscode-test.mjs label "${label}" is not in DOCKER_TEST_LABELS`);
		}
	});
});
