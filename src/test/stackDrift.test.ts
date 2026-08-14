import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { DOCKER_SKIP_FLAGS, DOCKER_TEST_LABELS } from "./dockerTestLabels";
import { parseEnvFile, STACK_DEFAULTS } from "./envFile";
import { PLAYBACK_MODEL } from "./fakeStack/models";
import { COPILOT_TOKEN_DIR, FAKE_BACKEND_PORT, REAL_PROVIDERS } from "./fakeStack/proxyConfig";

/**
 * Drift guards for the docker stack's non-TypeScript mirrors. The constants
 * are the code-side truth (STACK_DEFAULTS in envFile.ts, FAKE_BACKEND_PORT
 * and REAL_PROVIDERS in fakeStack/proxyConfig.ts, PLAYBACK_MODEL in
 * fakeStack/models.ts, package.json's packageManager and engines fields);
 * docker/docker-compose.yml, .env.example, README.md, docs/development.md,
 * and the devcontainer cannot import them, so these tests turn every
 * restatement into a CI-enforced
 * mirror. Captured values are compared whole, never as substrings, so a
 * stale number that happens to prefix the live one still fails. Tests run
 * from out/test, so the repo root is two levels up.
 */
const repoRoot = path.resolve(__dirname, "..", "..");

const fileCache = new Map<string, string>();

function read(name: string): string {
	let content = fileCache.get(name);
	if (content === undefined) {
		content = fs.readFileSync(path.join(repoRoot, name), "utf8");
		fileCache.set(name, content);
	}
	return content;
}

suite("stack drift guard: docker/docker-compose.yml", () => {
	/**
	 * The indented body of one service under `services:` (from its 2-space
	 * name line up to the next 2-space key). Checks anchor to a service block
	 * so a variable attached to the WRONG container can never satisfy a guard
	 * (an OPENAI_API_KEY under fake-openai is not a litellm passthrough), and
	 * a service reorder cannot change which lines are compared.
	 */
	function serviceBlock(name: string): string {
		const match = new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, "m").exec(read("docker/docker-compose.yml"));
		assert.ok(match, `docker/docker-compose.yml declares a "${name}" service`);
		const body = match[1] as string;
		assert.ok(body.trim() !== "", `the "${name}" service block is not empty`);
		return body;
	}

	/** The single match of a pattern; zero or several matches fail loudly instead of comparing an arbitrary one. */
	function captureOne(text: string, pattern: RegExp, what: string): string {
		const captures = [...text.matchAll(pattern)].map((match) => match[1] as string);
		assert.strictEqual(captures.length, 1, `expected exactly one ${what}, found ${captures.length}`);
		return captures[0] as string;
	}

	test("every VAR:-default compose fallback for a stack setting states the STACK_DEFAULTS value", () => {
		// Host-side settings only: the litellm container-internal port 4000
		// (the image's --port argument, the mapping's container side, and the
		// litellm healthcheck URL) is compose-internal with no TypeScript
		// mirror and stays deliberately unguarded.
		const fallbacks: Record<string, string> = {};
		for (const match of read("docker/docker-compose.yml").matchAll(/\$\{([A-Z_]+):-([^}]*)\}/g)) {
			const name = match[1] as string;
			assert.ok(
				!Object.hasOwn(fallbacks, name),
				`duplicate \${${name}:-...} fallbacks would make this guard ambiguous`
			);
			fallbacks[name] = match[2] as string;
		}
		const found = Object.keys(fallbacks).length;
		assert.ok(found >= 3, `docker/docker-compose.yml declares \${VAR:-default} fallbacks (found ${found})`);
		for (const [name, value] of Object.entries(STACK_DEFAULTS)) {
			assert.ok(Object.hasOwn(fallbacks, name), `docker/docker-compose.yml has no \${${name}:-...}`);
			assert.strictEqual(fallbacks[name], value, `compose fallback for ${name}`);
		}
	});

	test("the fake-openai service pins FAKE_BACKEND_PORT on its PORT env, port mapping, and healthcheck", () => {
		const block = serviceBlock("fake-openai");
		const portEnv = captureOne(block, /^ +PORT: "(\d+)"$/gm, "fake-openai PORT env line");
		assert.strictEqual(portEnv, String(FAKE_BACKEND_PORT), "fake-openai PORT env");
		const mapping = captureOne(block, /"127\.0\.0\.1:\$\{FAKE_OPENAI_PORT:-\d+\}:(\d+)"/g, "fake-openai port mapping");
		assert.strictEqual(mapping, String(FAKE_BACKEND_PORT), "fake-openai container-side mapping");
		const health = captureOne(
			block,
			/"wget", "-qO-", "http:\/\/127\.0\.0\.1:(\d+)\/health"/g,
			"fake-openai wget healthcheck"
		);
		assert.strictEqual(health, String(FAKE_BACKEND_PORT), "fake-openai healthcheck port");
	});

	test("the litellm environment block passes through every env var the generated config reads", () => {
		// The wildcard-route decision runs on the HOST at generation time, but
		// os.environ/<VAR> in the emitted config resolves INSIDE the litellm
		// container; that service's passthrough lines are the only conduit. A
		// REAL_PROVIDERS entry without a litellm passthrough line generates a
		// route whose key can never resolve.
		const block = serviceBlock("litellm");
		const passthrough: Record<string, string> = {};
		for (const match of block.matchAll(/^ +([A-Z_]+): \$\{\1(?::-([^}]*))?\}$/gm)) {
			const name = match[1] as string;
			assert.ok(!Object.hasOwn(passthrough, name), `duplicate litellm passthrough for ${name}`);
			passthrough[name] = match[2] ?? "";
		}
		assert.ok(REAL_PROVIDERS.length >= 2, "REAL_PROVIDERS names the provider key set");
		for (const { envVar } of REAL_PROVIDERS) {
			assert.ok(Object.hasOwn(passthrough, envVar), `the litellm service does not pass ${envVar} through`);
			assert.strictEqual(passthrough[envVar], "", `${envVar} passes through with an empty default`);
		}
		// The generated config always ends in master_key: os.environ/LITELLM_MASTER_KEY.
		assert.ok(Object.hasOwn(passthrough, "LITELLM_MASTER_KEY"), "the litellm service must keep LITELLM_MASTER_KEY");
		assert.strictEqual(passthrough.LITELLM_MASTER_KEY, STACK_DEFAULTS.LITELLM_MASTER_KEY);
	});

	test("every compose restatement of the copilot token dir matches COPILOT_TOKEN_DIR", () => {
		// copilot-login seeds COPILOT_TOKEN_DIR on the host; compose cannot
		// import the constant, so its copies would otherwise drift silently:
		// the login would seed a directory nothing mounts, tests stay green,
		// and the stack just has no github_copilot routes.
		const litellm = serviceBlock("litellm");
		assert.ok(litellm.includes(`- ./${COPILOT_TOKEN_DIR}:/copilot-token:ro`), "litellm mounts the token dir read-only");
		assert.ok(litellm.includes("GITHUB_COPILOT_TOKEN_DIR: /copilot-token"), "the authenticator env names the mount");
		assert.match(
			litellm,
			/GITHUB_COPILOT_API_KEY_FILE: \/\S+/,
			"the key cache redirects to an absolute container-local path (escapes the read-only mount)"
		);
		const fakeOpenai = serviceBlock("fake-openai");
		assert.ok(
			fakeOpenai.includes(`- /app/${COPILOT_TOKEN_DIR}`),
			"fake-openai masks the token dir out of its repo mount"
		);
	});
});

suite("stack drift guard: bun version pin", () => {
	test("compose's oven/bun image and the devcontainer bun feature carry the packageManager version", () => {
		const { packageManager } = JSON.parse(read("package.json")) as { packageManager?: string };
		const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager ?? "")?.[1];
		assert.ok(pinned, `package.json packageManager pins an exact bun version (got "${packageManager}")`);
		const image = /^\s+image: docker\.io\/oven\/bun:(\S+?)-alpine$/m.exec(read("docker/docker-compose.yml"))?.[1];
		assert.ok(image, "docker/docker-compose.yml runs the fake backend on a docker.io/oven/bun:*-alpine image");
		assert.strictEqual(image, pinned, "compose oven/bun image tag version");
		// devcontainer.json is JSONC; drop full-line comments before parsing.
		const devcontainer = read(".devcontainer/devcontainer.json").replace(/^\s*\/\/.*$/gm, "");
		const { features } = JSON.parse(devcontainer) as {
			features?: Record<string, { version?: string }>;
		};
		const bunFeature = Object.entries(features ?? {}).find(([id]) => /\/bun:\d+$/.test(id));
		assert.ok(bunFeature, "the devcontainer declares a bun feature");
		assert.strictEqual(bunFeature[1].version, pinned, "devcontainer bun feature version");
	});
});

suite("stack drift guard: README", () => {
	test("the requirements line states engines.vscode's minimum", () => {
		const { engines } = JSON.parse(read("package.json")) as { engines: { vscode: string } };
		const minimum = /^\^(\d+\.\d+\.\d+)$/.exec(engines.vscode)?.[1];
		assert.ok(minimum, `engines.vscode is a caret range over an exact version (got "${engines.vscode}")`);
		const claimed = /VS Code (\d+\.\d+\.\d+) or higher/.exec(read("README.md"))?.[1];
		assert.ok(claimed, 'README.md states "VS Code <version> or higher"');
		assert.strictEqual(claimed, minimum, "README minimum VS Code version");
	});
});

suite("stack drift guard: docs/development.md", () => {
	test("the fake-stack quick start names the stack defaults", () => {
		// Accepted brittleness: the doc has several generic http://localhost
		// examples, so the fake-stack instruction is selected by the phrases
		// "base URL" and "API key" around the backticked values (any wording
		// between them is fine). Rewording past that means updating this regex.
		const match = /base URL `http:\/\/localhost:(\d+)`.*?API key `([^`]+)`/.exec(read("docs/development.md"));
		assert.ok(
			match,
			'docs/development.md names the fake stack\'s "base URL `http://localhost:<port>`" and "API key `<key>`"'
		);
		assert.strictEqual(match[1], STACK_DEFAULTS.LITELLM_PORT, "quick-start port");
		assert.strictEqual(match[2], STACK_DEFAULTS.LITELLM_MASTER_KEY, "quick-start API key");
	});

	test("the host-fidelity example command targets the stack defaults and the playback model", () => {
		// Anchored to the env assignments themselves (the values under guard),
		// so the surrounding prose is free to change; only the documented
		// invocation's arguments are pinned.
		const match =
			/LITELLM_REAL_BASE_URL=http:\/\/localhost:(\d+) LITELLM_REAL_API_KEY=(\S+) LITELLM_REAL_MODEL=(\S+)/.exec(
				read("docs/development.md")
			);
		assert.ok(match, "docs/development.md shows the live host-fidelity invocation against the stack");
		assert.strictEqual(match[1], STACK_DEFAULTS.LITELLM_PORT, "host-fidelity example port");
		assert.strictEqual(match[2], STACK_DEFAULTS.LITELLM_MASTER_KEY, "host-fidelity example key");
		assert.strictEqual(match[3], PLAYBACK_MODEL.alias, "host-fidelity example model");
	});
});

suite("stack drift guard: .env.example", () => {
	test("the template ships the stack defaults and covers every provider key", () => {
		// Parsed with the same compose-conformant grammar the stack itself uses.
		const values = parseEnvFile(read(".env.example"));
		for (const [name, value] of Object.entries(STACK_DEFAULTS)) {
			assert.ok(Object.hasOwn(values, name), `.env.example has no ${name} line`);
			assert.strictEqual(values[name], value, `.env.example value for ${name}`);
		}
		for (const { envVar } of REAL_PROVIDERS) {
			assert.ok(Object.hasOwn(values, envVar), `.env.example does not template ${envVar}`);
			assert.strictEqual(values[envVar], "", `${envVar} ships empty (no key, no wildcard route)`);
		}
	});
});

suite("stack drift guard: checks.yml docker shards", () => {
	/**
	 * The shard matrices in checks.yml restate the orchestrator's label set
	 * as quoted comma-separated strings the workflow cannot import. The
	 * orchestrator exits 2 on an unknown label, but only when that shard
	 * actually runs; these guards catch a rename or a new suite at unit-test
	 * time instead. Same block-anchoring approach as the compose guards.
	 */
	function jobBlock(name: string): string {
		const match = new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, "m").exec(read(".github/workflows/checks.yml"));
		assert.ok(match, `checks.yml declares a "${name}" job`);
		const body = match[1] as string;
		assert.ok(body.trim() !== "", `the "${name}" job block is not empty`);
		return body;
	}

	/** Each matrix entry as its list of labels, in matrix order. */
	function shardLabels(job: string): string[][] {
		const list = /^ +labels:\n((?: +- '[^'\n]*'\n)+)/m.exec(jobBlock(job));
		assert.ok(list, `the "${job}" job declares a quoted labels matrix`);
		return [...(list[1] as string).matchAll(/- '([^'\n]*)'/g)].map((match) =>
			(match[1] as string).split(",").map((label) => label.trim())
		);
	}

	test("every label in the docker-stack and fuzz-docker matrices is one the orchestrator knows", () => {
		const known: ReadonlySet<string> = new Set(DOCKER_TEST_LABELS);
		for (const job of ["docker-stack", "fuzz-docker"]) {
			const shards = shardLabels(job);
			assert.ok(shards.length >= 2, `the "${job}" matrix declares at least two shards`);
			for (const shard of shards) {
				for (const label of shard) {
					assert.ok(known.has(label), `checks.yml ${job} matrix lists unknown label "${label}"`);
				}
			}
		}
	});

	test("the docker-stack shards cover the full label set exactly once", () => {
		const sharded = shardLabels("docker-stack").flat().sort();
		assert.deepStrictEqual(sharded, [...DOCKER_TEST_LABELS].sort(), "docker-stack shard union");
	});

	test("the docker-stack shards are wired through docker-only", () => {
		// Without this line each shard's input resolves to '' and the reusable
		// workflow falls back to the full sequential run: every shard green,
		// every leg run twice, nothing to notice but the wall clock.
		assert.match(
			jobBlock("docker-stack"),
			/^ +docker-only: \$\{\{ matrix\.labels \}\}$/m,
			"checks.yml docker-stack passes matrix.labels through the docker-only input"
		);
	});

	test("the fuzz-docker shards cover exactly the seeded fuzz labels", () => {
		// The docker legs that draw a replay seed and take an iteration
		// budget. The membership test above catches a rename; this catches a
		// deleted shard, which would silently end that leg's elevated pass in
		// the gate while every other guard stays green.
		const sharded = shardLabels("fuzz-docker").flat().sort();
		assert.deepStrictEqual(sharded, ["docker-conversation", "docker-fuzz", "docker-monkey"], "fuzz-docker shard union");
	});
});

suite("stack drift guard: nightly-fuzz legs", () => {
	/**
	 * nightly-fuzz.yml restates the orchestrator's label vocabulary twice: the
	 * seeded docker legs name their labels through --only, and the unseeded
	 * leg runs the complement through --skip-* flags. Neither list can import
	 * DOCKER_TEST_LABELS or DOCKER_SKIP_FLAGS, so without these guards a label
	 * seeded in a new leg but not skipped in the unseeded one would run twice
	 * per night (once unseeded at default iterations), and a seeded label
	 * whose skip flag went stale after a rename would silently land in the
	 * unseeded leg, unfuzzed.
	 */
	const workflow = () => read(".github/workflows/nightly-fuzz.yml");

	/** The matrix include rows as key/value records, one per `- leg:` block. */
	function matrixRows(): Record<string, string>[] {
		const include = /^ +include:\n((?:(?: {10,}.*)?\n)*)/m.exec(workflow());
		assert.ok(include, "nightly-fuzz.yml declares a matrix include block");
		const segments = (include[1] as string).split(/\n(?= *- leg:)/).filter((segment) => segment.includes("- leg:"));
		assert.ok(segments.length >= 4, `the matrix declares real legs (found ${segments.length})`);
		return segments.map((segment) => {
			const row: Record<string, string> = {};
			for (const line of segment.split("\n")) {
				const pair = /^ *(?:- )?([a-zA-Z]+): (.*?)\s*$/.exec(line);
				if (pair && !line.trimStart().startsWith("#")) {
					row[pair[1] as string] = pair[2] as string;
				}
			}
			return row;
		});
	}

	test("every seeded docker leg names known, skippable labels", () => {
		const known: ReadonlySet<string> = new Set(DOCKER_TEST_LABELS);
		const seededRows = matrixRows().filter((row) => row.family === "docker" && row.seeded === "true");
		assert.ok(seededRows.length >= 1, "the matrix declares at least one seeded docker leg");
		for (const row of seededRows) {
			const labels = (row.labels ?? "").split(",").map((label) => label.trim());
			assert.ok(labels.length > 0 && labels[0] !== "", "a seeded docker leg must name its labels");
			for (const label of labels) {
				assert.ok(known.has(label), `nightly-fuzz seeded leg lists unknown label "${label}"`);
				assert.ok(
					DOCKER_SKIP_FLAGS[label as (typeof DOCKER_TEST_LABELS)[number]] !== undefined,
					`seeded label "${label}" has no --skip flag, so the unseeded leg cannot exclude it`
				);
			}
		}
	});

	test("the leg accounting matches the header's floors", () => {
		// The header comment promises four unit legs and three seeded docker
		// legs per night, and the complement equation below only holds with
		// EXACTLY one unseeded docker row (a second one would run the
		// complement twice; zero would drop it entirely). Floors, not exact
		// counts, for the fuzzing legs: adding legs adds coverage, deleting
		// one silently reduces a night's distinct-seed spread.
		const rows = matrixRows();
		assert.ok(
			rows.filter((row) => row.family === "unit").length >= 4,
			"the matrix keeps at least the four unit property legs"
		);
		assert.ok(
			rows.filter((row) => row.family === "docker" && row.seeded === "true").length >= 3,
			"the matrix keeps at least the three seeded docker legs"
		);
		assert.strictEqual(
			rows.filter((row) => row.family === "docker" && row.seeded === "false").length,
			1,
			"exactly one unseeded docker leg runs the skip-flag complement"
		);
		for (const row of rows) {
			assert.ok(
				row.family === "unit" || row.family === "docker",
				`matrix row "${row.leg}" has family "${row.family}", which no fuzz step runs`
			);
			// Structural, not by count: the seeded/unseeded split is inferred
			// from this value, so a typo ("yes", a dropped key) must fail here
			// rather than quietly turn a seeded leg into a second unseeded run.
			if (row.family === "docker") {
				assert.ok(
					row.seeded === "true" || row.seeded === "false",
					`docker leg "${row.leg}" must declare seeded as true or false, got "${row.seeded}"`
				);
			}
		}
	});

	test("the unseeded leg's skip flags are exactly the seeded labels' flags", () => {
		// This is the coverage equation: the unseeded leg runs the complement
		// of its skip flags, so skips == seeded labels means every label in
		// DOCKER_TEST_LABELS runs at night exactly once - seeded legs fuzz
		// their labels, the unseeded leg picks up everything else (including
		// any label added later without touching the workflow).
		const seededLabels = new Set(
			matrixRows()
				.filter((row) => row.family === "docker" && row.seeded === "true")
				.flatMap((row) => (row.labels ?? "").split(",").map((label) => label.trim()))
		);
		const skipLine = /^ +set -- (--skip-\S+(?: --skip-\S+)*)$/m.exec(workflow());
		assert.ok(skipLine, "nightly-fuzz.yml's unseeded branch sets --skip-* flags");
		const skips = (skipLine[1] as string).split(/\s+/).sort();
		const expected = [...seededLabels]
			.map((label) => DOCKER_SKIP_FLAGS[label as (typeof DOCKER_TEST_LABELS)[number]])
			.filter((flag): flag is string => flag !== undefined)
			.sort();
		assert.deepStrictEqual(skips, expected, "unseeded-leg skip flags must mirror the seeded labels");
	});

	test("every leg carries a distinct salt", () => {
		// The header's coverage argument rests on per-leg seed divergence; two
		// legs sharing a salt would replay each other's inputs all night.
		const salts = matrixRows().map((row) => row.salt);
		assert.ok(
			salts.every((salt) => salt !== undefined && /^\d+$/.test(salt)),
			"every matrix row declares a numeric salt"
		);
		assert.strictEqual(new Set(salts).size, salts.length, "matrix salts must be distinct across legs");
	});
});

suite("stack drift guard: test label coverage", () => {
	/**
	 * The installed @vscode/test-cli silently ignores "!" negations in files
	 * globs, so .vscode-test.mjs holds only positive per-directory globs and
	 * literal filenames. That layout has two failure modes a green run would
	 * hide: a moved test file that no label matches (it just stops running)
	 * and one that two labels match (it runs twice, as host-fidelity's
	 * capture suite once did under the unit label). This walks every
	 * compiled test file and pins the count of matching labels to one.
	 */
	test("every compiled test file is matched by exactly one label's files list", async () => {
		const configUrl = pathToFileURL(path.join(repoRoot, ".vscode-test.mjs")).href;
		const { default: config } = (await import(configUrl)) as {
			default: { tests: { label: string; files: string | string[] }[] };
		};
		const escapeLiteral = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const matchers = config.tests.flatMap(({ label, files }) =>
			(Array.isArray(files) ? files : [files]).map((glob) => ({
				label,
				glob,
				// "*" spans within one path segment; everything else is literal.
				regex: new RegExp(`^${glob.split("*").map(escapeLiteral).join("[^/]*")}$`),
			}))
		);
		const testFiles: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".test.js")) {
					testFiles.push(path.relative(repoRoot, full).split(path.sep).join("/"));
				}
			}
		};
		walk(path.join(repoRoot, "out", "test"));
		assert.ok(testFiles.length > 20, `walking out/test found a real test tree (got ${testFiles.length} files)`);
		for (const file of testFiles) {
			const hits = matchers.filter((matcher) => matcher.regex.test(file));
			assert.strictEqual(
				hits.length,
				1,
				`${file} must run under exactly one label; matched ${
					hits.length === 0 ? "none" : hits.map((hit) => `${hit.label} (${hit.glob})`).join(", ")
				}`
			);
		}
	});
});

suite("stack drift guard: bun-tree purity boundary", () => {
	/**
	 * The bun tree (src/test/bun) is the home for suites that need no
	 * extension host. Neither direction fully self-enforces: a runtime
	 * vscode import crashes bun's runner at load, but msw resolves and runs
	 * there just fine, and nothing at all stops a pure suite from landing
	 * host-side, where it boots a VS Code host for nothing. This guard
	 * closes both: every unit-label suite must reach vscode or msw through
	 * its transitive runtime imports or carry an entry below saying why it
	 * stays, and no bun-tree suite may reach either. Docker, host-fidelity,
	 * and activation suites are exempt by layout - their host need is the
	 * stack or the host itself, not an import.
	 */
	const HOST_SIDE_PURE_SUITES = new Map<string, string>([
		["src/test/creditConvention.test.ts", "meta-test: walks the repository's git history"],
		["src/test/dockerTestLabels.test.ts", "meta-test: imports .vscode-test.mjs, which loads compiled out/ files"],
		["src/test/envFile.test.ts", "meta-test: pins the docker stack's env-file grammar beside its stack suites"],
		["src/test/scenarios.test.ts", "meta-test: pins the canned stream shapes the docker suites replay"],
		["src/test/stackDrift.test.ts", "meta-test: walks out/test and imports .vscode-test.mjs"],
		["src/test/extension/dashboard/html.test.ts", "pure today; owned by the dashboard HTML work, port separately"],
		["src/test/extension/dashboard/state.property.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/extension/dashboard/usageView.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/extension/servers/usage/freshness.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/extension/servers/usage/store.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/extension/settingsTransfer/secretSurgery.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/extension/settingsTransfer/snapshot.test.ts", "pure today; not yet ported to the bun tree"],
		[
			"src/test/extension/ui/usageStatusItem.property.test.ts",
			"pure since the l10n unification; not yet ported to the bun tree",
		],
		[
			"src/test/extension/ui/usageStatusItem.test.ts",
			"pure since the l10n unification; not yet ported to the bun tree",
		],
		["src/test/fakeStack/collapseChunks.property.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/provider/catalog/modelConfiguration.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/provider/transport/request.property.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/shared/conversion/promptCache.test.ts", "pure today; not yet ported to the bun tree"],
		["src/test/shared/logger.test.ts", "pure today; not yet ported to the bun tree"],
	]);

	// TypeScript AST scan: only value-position module references count as
	// runtime edges; import type / export type statements, type-only named
	// lists, and type-position import("...") nodes are erased by both tsc
	// and bun, so they never make a suite host-bound.
	function runtimeImportSpecs(fileName: string, source: string): string[] {
		const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
		const specs: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node)) {
				if (!importClauseIsTypeOnly(node.importClause) && ts.isStringLiteral(node.moduleSpecifier)) {
					specs.push(node.moduleSpecifier.text);
				}
			} else if (ts.isExportDeclaration(node)) {
				const namedTypeOnly =
					node.exportClause !== undefined &&
					ts.isNamedExports(node.exportClause) &&
					node.exportClause.elements.length > 0 &&
					node.exportClause.elements.every((element) => element.isTypeOnly);
				if (!node.isTypeOnly && !namedTypeOnly && node.moduleSpecifier !== undefined) {
					if (ts.isStringLiteral(node.moduleSpecifier)) {
						specs.push(node.moduleSpecifier.text);
					}
				}
			} else if (ts.isImportEqualsDeclaration(node)) {
				if (
					!node.isTypeOnly &&
					ts.isExternalModuleReference(node.moduleReference) &&
					ts.isStringLiteral(node.moduleReference.expression)
				) {
					specs.push(node.moduleReference.expression.text);
				}
			} else if (ts.isCallExpression(node)) {
				// Dynamic import()/require() in value position; the type-position
				// import("...") form is an ImportTypeNode, never a CallExpression.
				const callee = node.expression;
				const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
				const isRequireCall = ts.isIdentifier(callee) && callee.text === "require";
				const argument = node.arguments[0];
				if ((isImportCall || isRequireCall) && argument !== undefined && ts.isStringLiteralLike(argument)) {
					specs.push(argument.text);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		return specs;
	}

	function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
		if (clause === undefined) {
			return false;
		}
		if (clause.isTypeOnly) {
			return true;
		}
		return (
			clause.name === undefined &&
			clause.namedBindings !== undefined &&
			ts.isNamedImports(clause.namedBindings) &&
			clause.namedBindings.elements.length > 0 &&
			clause.namedBindings.elements.every((element) => element.isTypeOnly)
		);
	}

	function resolveRelative(fromFile: string, spec: string): string {
		const base = path.resolve(path.dirname(fromFile), spec);
		for (const candidate of [
			base,
			`${base}.ts`,
			`${base}.tsx`,
			path.join(base, "index.ts"),
			path.join(base, "index.tsx"),
		]) {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return candidate;
			}
		}
		// Fail closed: a spec this resolver cannot place would silently prune
		// the walk, and a pruned subtree is exactly where a vscode or msw edge
		// hides while every reachability guard below stays green.
		throw new Error(
			`${fromFile} imports "${spec}", which resolves to no file this scanner knows; teach resolveRelative the new shape`
		);
	}

	/** Whether the file's transitive runtime imports reach vscode or msw. */
	function reachesHostMachinery(entryFile: string): boolean {
		const seen = new Set<string>();
		const stack = [entryFile];
		while (stack.length > 0) {
			const file = stack.pop() as string;
			if (seen.has(file)) {
				continue;
			}
			seen.add(file);
			for (const spec of runtimeImportSpecs(file, fs.readFileSync(file, "utf8"))) {
				if (spec === "vscode" || spec === "msw" || spec.startsWith("msw/")) {
					return true;
				}
				if (spec.startsWith(".")) {
					stack.push(resolveRelative(file, spec));
				}
			}
		}
		return false;
	}

	test("the scanner counts value edges and erases type-only forms", () => {
		const specsOf = (source: string): string[] => runtimeImportSpecs("probe.ts", source);
		assert.deepStrictEqual(specsOf('import { x } from "a"; import "b"; export { y } from "c";'), ["a", "b", "c"]);
		assert.deepStrictEqual(specsOf('const m = await import("a"); const n = require("b");'), ["a", "b"]);
		assert.deepStrictEqual(specsOf('import x = require("a"); export * from "b";'), ["a", "b"]);
		assert.deepStrictEqual(specsOf('import { type X, y } from "a"; import d, { type Z } from "b";'), ["a", "b"]);
		assert.deepStrictEqual(
			specsOf('import type { X } from "a"; import { type Y } from "b"; export type { Z } from "c";'),
			[]
		);
		assert.deepStrictEqual(specsOf('type X = import("a").X;'), []);
	});

	function walkTestFiles(root: string, skipDirs: readonly string[]): string[] {
		const found: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				const rel = path.relative(repoRoot, full).split(path.sep).join("/");
				if (entry.isDirectory()) {
					if (!skipDirs.includes(rel)) {
						walk(full);
					}
				} else if (/\.test\.tsx?$/.test(entry.name)) {
					found.push(rel);
				}
			}
		};
		walk(root);
		return found;
	}

	test("every host-side unit suite needs the host, or documents why it stays", () => {
		const hostSuites = walkTestFiles(path.join(repoRoot, "src", "test"), [
			"src/test/bun",
			"src/test/hostFidelity",
			"src/test/activation",
		]).filter((rel) => !/^src\/test\/docker-[^/]+\.test\.ts$/.test(rel));
		assert.ok(hostSuites.length > 20, `walking src/test found a real host tree (got ${hostSuites.length} files)`);
		for (const [listed] of HOST_SIDE_PURE_SUITES) {
			assert.ok(
				hostSuites.includes(listed),
				`${listed} is allow-listed but is no longer a host-side unit suite; drop the stale entry`
			);
			assert.ok(
				!reachesHostMachinery(path.join(repoRoot, listed)),
				`${listed} now reaches vscode or msw; its allow-list entry is stale, drop it`
			);
		}
		for (const file of hostSuites) {
			if (HOST_SIDE_PURE_SUITES.has(file)) {
				continue;
			}
			assert.ok(
				reachesHostMachinery(path.join(repoRoot, file)),
				`${file} reaches neither vscode nor msw through its runtime imports; move it to src/test/bun/ (mirrored path, bun:test callables) or allow-list it here with a reason`
			);
		}
	});

	test("no bun-tree suite reaches vscode or msw", () => {
		// vscode fails loudly there (no such package under bun), but msw
		// resolves and runs; only this walk enforces that half of the rule.
		// The preload files bunfig.toml names run before every bun suite, so
		// they are seeded into the walk: a violation there would run
		// everywhere while a suites-only walk stayed green.
		const preloadList = /^preload = \[([^\]]*)\]/m.exec(read("bunfig.toml"));
		assert.ok(preloadList, "bunfig.toml declares a preload list");
		const preloads = [...(preloadList[1] as string).matchAll(/"([^"]+)"/g)].map((match) =>
			(match[1] as string).replace(/^\.\//, "")
		);
		assert.ok(preloads.length >= 1, "bunfig.toml's preload list names at least one file");
		for (const file of preloads) {
			assert.ok(fs.existsSync(path.join(repoRoot, file)), `bunfig.toml preloads ${file}, which does not exist`);
		}
		const bunSuites = walkTestFiles(path.join(repoRoot, "src", "test", "bun"), []);
		assert.ok(bunSuites.length > 20, `walking src/test/bun found a real bun tree (got ${bunSuites.length} files)`);
		for (const file of [...preloads, ...bunSuites]) {
			assert.ok(
				!reachesHostMachinery(path.join(repoRoot, file)),
				`${file} reaches vscode or msw through its runtime imports; it cannot run under bun - move it back to the host tree`
			);
		}
	});
});
