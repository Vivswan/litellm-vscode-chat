import os from "node:os";
import path from "node:path";
import { defineConfig } from "@vscode/test-cli";
// Compiled by the `compile` step that precedes every vscode-test invocation
// (see the test scripts and scripts/docker-test.ts).
import { DOCKER_TEST_LABELS } from "./out/test/dockerTestLabels.js";

// Per-label isolation; VS Code's IPC socket lives inside this dir and must fit macOS's ~104-byte AF_UNIX path cap.
const launchArgsFor = (label) => [
	"--user-data-dir",
	process.env.VSCODE_TEST_USER_DATA_DIR
		? path.join(process.env.VSCODE_TEST_USER_DATA_DIR, label)
		: path.join(os.tmpdir(), `lvt-${process.pid}-${label}`),
];

const passthroughEnv = (...names) => Object.fromEntries(names.map((name) => [name, process.env[name] || ""]));

const dockerLabel = (label, { file = label, timeout, extraEnv = {} }) => ({
	label,
	files: `out/test/${file}.test.js`,
	mocha: {
		ui: "tdd",
		timeout,
		color: true,
	},
	env: {
		...passthroughEnv("LITELLM_DOCKER_BASE_URL", "LITELLM_DOCKER_API_KEY", "LITELLM_DOCKER_FAKE_URL"),
		...extraEnv,
	},
	launchArgs: launchArgsFor(label),
});

// Per-label options for every docker suite. host-fidelity runs against the
// stack too (scripts/docker-test.ts) but keeps its own stanza below: its env
// contract is the LITELLM_REAL_* live-server seam, not the docker one.
const dockerSuites = {
	docker: { file: "docker-litellm", timeout: 60000 },
	"docker-usage": { timeout: 60000 },
	"docker-transport": { timeout: 120000 },
	"docker-serversync": { timeout: 120000 },
	"docker-resolution": { timeout: 120000 },
	"docker-fuzz": { timeout: 120000, extraEnv: passthroughEnv("FUZZ_SEED", "FUZZ_ITERATIONS") },
	"docker-conversation": { timeout: 120000, extraEnv: passthroughEnv("FUZZ_SEED", "CONVERSATION_ITERATIONS") },
	// Its own host: the provider group it creates is add-only for the host
	// lifetime and would linger into any suite sharing the label.
	"docker-group-path": { timeout: 120000 },
	// Capture-mode host-fidelity spin-off with the same lingering-groups
	// isolation need; it runs in the plain `bun run test` chain too.
	"host-fidelity-groups": { file: "hostFidelity/host-fidelity-groups", timeout: 60000 },
	// Whole-walk tests; the suite raises its own per-test budgets on top.
	"docker-monkey": { timeout: 300000, extraEnv: passthroughEnv("FUZZ_SEED", "MONKEY_ITERATIONS") },
};

// The runtime analog of docker-test.ts's total Record: a label added to
// DOCKER_TEST_LABELS without options here (or vice versa) must fail loudly,
// never silently drop a leg.
const dockerLabels = DOCKER_TEST_LABELS.filter((label) => label !== "host-fidelity");
{
	const configured = Object.keys(dockerSuites).sort().join(", ");
	const canonical = [...dockerLabels].sort().join(", ");
	if (configured !== canonical) {
		throw new Error(`dockerSuites must cover exactly the docker labels: have [${configured}], need [${canonical}]`);
	}
}

export default defineConfig({
	coverage: {
		include: ["**/out/**", "**/dist/**"],
		exclude: ["**/out/test/**", "**/node_modules/**"],
		reporter: ["text-summary", "json-summary", "lcovonly"],
		output: "./coverage",
	},
	tests: [
		{
			label: "unit",
			// Positive globs and literals only: the installed @vscode/test-cli
			// ignores "!" negations in files globs, so exclusion works by
			// directory layout instead. Suites that need their own host
			// (activation-production, host-fidelity) or a running stack (the
			// docker suites at the out/test root, listed by literal name in
			// their own labels) are simply never matched here. stackDrift's
			// label-coverage guard walks out/test and fails the suite when a
			// compiled test file is matched by zero labels or by more than one.
			files: [
				"out/test/creditConvention.test.js",
				"out/test/dockerTestLabels.test.js",
				"out/test/envFile.test.js",
				"out/test/scenarios.test.js",
				"out/test/stackDrift.test.js",
				"out/test/fakeStack/*.test.js",
				"out/test/shared/*.test.js",
				"out/test/shared/config/*.test.js",
				"out/test/shared/conversion/*.test.js",
				"out/test/provider/*.test.js",
				"out/test/provider/catalog/*.test.js",
				"out/test/provider/transport/*.test.js",
				"out/test/extension/*.test.js",
				"out/test/extension/dashboard/*.test.js",
				"out/test/extension/migrations/*.test.js",
				"out/test/extension/servers/*.test.js",
				"out/test/extension/servers/usage/*.test.js",
				"out/test/extension/settingsTransfer/*.test.js",
				"out/test/extension/ui/*.test.js",
			],
			mocha: {
				ui: "tdd",
				timeout: 20000,
				color: true,
				// The unit suites fingerprint without running activation's salt
				// load; this bootstrap pins the fixed salt before any test file.
				require: ["./out/test/util/fingerprintSalt.js"],
			},
			env: {
				FUZZ_RUNS: process.env.FUZZ_RUNS || "",
				FUZZ_SEED: process.env.FUZZ_SEED || "",
			},
			launchArgs: launchArgsFor("unit"),
		},
		{
			// Its own label and host: the file calls the compiled activate() with a
			// fake Production-mode context, which registers the real litellm.*
			// command IDs - it can never share a host with the activated extension.
			// onStartupFinished (the manifest's activation event) would activate
			// the real dev-mode extension first and collide every registration,
			// so this label suppresses host-initiated activation (see the guard
			// at the top of activate()).
			label: "activation-production",
			files: "out/test/activation/production.test.js",
			mocha: {
				ui: "tdd",
				timeout: 30000,
				color: true,
			},
			env: {
				LITELLM_SUPPRESS_STARTUP_ACTIVATION: "1",
			},
			launchArgs: launchArgsFor("activation-production"),
		},
		{
			label: "host-fidelity",
			files: "out/test/hostFidelity/host-fidelity.test.js",
			mocha: {
				ui: "tdd",
				timeout: 30000,
				color: true,
			},
			env: {
				LITELLM_REAL_LIVE: process.env.LITELLM_REAL_LIVE || "",
				LITELLM_REAL_BASE_URL: process.env.LITELLM_REAL_BASE_URL || "",
				LITELLM_REAL_API_KEY: process.env.LITELLM_REAL_API_KEY || "",
				LITELLM_REAL_MODEL: process.env.LITELLM_REAL_MODEL || "",
				LITELLM_REAL_TIMEOUT: process.env.LITELLM_REAL_TIMEOUT || "",
			},
			launchArgs: launchArgsFor("host-fidelity"),
		},
		...dockerLabels.map((label) => dockerLabel(label, dockerSuites[label])),
	],
});
