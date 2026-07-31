import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { DOCKER_TEST_LABELS } from "./dockerTestLabels";
import { parseEnvFile, STACK_DEFAULTS } from "./envFile";
import { PLAYBACK_MODEL } from "./fakeStack/models";
import { COPILOT_TOKEN_DIR, FAKE_BACKEND_PORT, REAL_PROVIDERS } from "./fakeStack/proxyConfig";

/**
 * Drift guards for the docker stack's non-TypeScript mirrors. The constants
 * are the code-side truth (STACK_DEFAULTS in envFile.ts, FAKE_BACKEND_PORT
 * and REAL_PROVIDERS in fakeStack/proxyConfig.ts, PLAYBACK_MODEL in
 * fakeStack/models.ts, package.json's packageManager and engines fields);
 * docker/docker-compose.yml, .env.example, README.md, and the devcontainer cannot
 * import them, so these tests turn every restatement into a CI-enforced
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

	test("the fake-stack quick start names the stack defaults", () => {
		// Accepted brittleness: README has several generic http://localhost
		// examples, so the fake-stack instruction is selected by the phrases
		// "base URL" and "API key" around the backticked values (any wording
		// between them is fine). Rewording past that means updating this regex.
		const match = /base URL `http:\/\/localhost:(\d+)`.*?API key `([^`]+)`/.exec(read("README.md"));
		assert.ok(match, 'README.md names the fake stack\'s "base URL `http://localhost:<port>`" and "API key `<key>`"');
		assert.strictEqual(match[1], STACK_DEFAULTS.LITELLM_PORT, "quick-start port");
		assert.strictEqual(match[2], STACK_DEFAULTS.LITELLM_MASTER_KEY, "quick-start API key");
	});

	test("the host-fidelity example command targets the stack defaults and the playback model", () => {
		// Anchored to the env assignments themselves (the values under guard),
		// so the surrounding prose is free to change; only the documented
		// invocation's arguments are pinned.
		const match =
			/LITELLM_REAL_BASE_URL=http:\/\/localhost:(\d+) LITELLM_REAL_API_KEY=(\S+) LITELLM_REAL_MODEL=(\S+)/.exec(
				read("README.md")
			);
		assert.ok(match, "README.md shows the live host-fidelity invocation against the stack");
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
