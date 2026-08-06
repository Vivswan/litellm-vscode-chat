import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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
	// The orchestrator passes each selected label to `vscode-test --label`.
	// .vscode-test.mjs maps its docker stanzas over DOCKER_TEST_LABELS, so a
	// plain rename can no longer drift silently - but its host-fidelity
	// exclusion filter and per-label options record sit outside the type
	// system (an .mjs), so this pins the resolved config's label set to the
	// canonical one from the outside.
	async function declaredLabels(): Promise<string[]> {
		const configUrl = pathToFileURL(path.resolve(__dirname, "..", "..", ".vscode-test.mjs")).href;
		const { default: config } = (await import(configUrl)) as { default: { tests: { label: string }[] } };
		const declared = config.tests.map((entry) => entry.label);
		assert.ok(declared.length >= DOCKER_TEST_LABELS.length, `found ${declared.length} labels in .vscode-test.mjs`);
		return declared;
	}

	test("every canonical label is a vscode-test label", async () => {
		const declared = await declaredLabels();
		for (const label of DOCKER_TEST_LABELS) {
			assert.ok(declared.includes(label), `.vscode-test.mjs declares no "${label}" label`);
		}
	});

	test("every docker-prefixed vscode-test label is canonical", async () => {
		const canonical: ReadonlySet<string> = new Set(DOCKER_TEST_LABELS);
		for (const label of (await declaredLabels()).filter((name) => name.startsWith("docker"))) {
			assert.ok(canonical.has(label), `.vscode-test.mjs label "${label}" is not in DOCKER_TEST_LABELS`);
		}
	});
});
