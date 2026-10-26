#!/usr/bin/env bun
// Launches an Extension Development Host preconfigured against the local fake LiteLLM stack: starts the docker proxy +
// fake OpenAI backend, builds the dev bundle, drops a one-shot seed file the extension consumes on its next
// development-mode activation (src/extension/devSeed.ts), and opens a new VS Code window in extension-development mode.
// The seeded record settings own exactly the matcher keys they name, and a user's other keys survive verbatim. The demo
// records show inheritance, a barrier, a forced field, a fallback, an OpenRouter derivation, and entry-over-global at
// once in the Resolved models view and both inspectors.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	type WriteStream,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { VENDOR_ID } from "../../src/shared/config/commandIds";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../src/shared/config/settingSpec";
import { DEV_SEED_FILENAME, type DevSeed, type DevSeedEntry, type DevSeedModels } from "../../src/shared/devSeed";
import { composeSetting, readEnvFile, STACK_DEFAULTS } from "../stack/litellmConfig";
import { DEMO_USAGE_KEYS, type SeededDemoUsage } from "./seedDemoUsage";

// The cwd: the repository paths below hang off it, and the preflight refuses one that is not this repository's root.
const root = process.cwd();

// Read with compose's ${VAR:-fallback} semantics (composeSetting), so the seed agrees with what compose resolves.
const envFile = readEnvFile();

// The proxy port, shared by the seed's base URL and the stack.
const port = composeSetting("LITELLM_PORT", STACK_DEFAULTS.LITELLM_PORT, envFile);

// The master key; the seed's main entry and the misconfigured demo entry both authenticate with it.
const apiKey = composeSetting("LITELLM_MASTER_KEY", STACK_DEFAULTS.LITELLM_MASTER_KEY, envFile);

function run(label: string, cmd: string[], extraEnv?: Record<string, string>): void {
	console.log(`[dev] ${label}`);
	const result = spawnSync(cmd[0] as string, cmd.slice(1), {
		stdio: "inherit",
		cwd: root,
		env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
	});
	if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
		// The signal handler cannot dispatch while spawnSync blocks; honor the interrupt here so an already-started
		// stack still comes down.
		onSignal(result.signal);
	}
	if (result.error !== undefined) {
		console.error(`[dev] ${label} failed: could not run "${cmd[0]}" (${result.error.message})`);
		if (cmd[0] === "code") {
			console.error(
				`[dev] install the "code" shell command: VS Code > Command Palette > "Shell Command: Install 'code' command in PATH"`
			);
		}
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`[dev] ${label} failed (exit ${result.status})`);
		process.exit(result.status ?? 1);
	}
}

// Absolute, like demoUsageCli below: knip's literal-argv scan must not resolve the script path relative to this file.
const composeCli = join(root, "scripts", "stack", "compose.ts");

function composeDownExitCode(): number {
	console.log("\n[dev] stopping the fake stack");
	const down = spawnSync("bun", [composeCli, "down"], { stdio: "inherit", cwd: root });
	if (down.signal !== null) {
		// A second Ctrl+C lands on the compose child directly while spawnSync blocks signal dispatch here; honor it as
		// an interrupt.
		console.error("[dev] teardown interrupted; the stack may still be up - run: bun run docker:down");
		return 130;
	}
	if (down.status !== 0) {
		console.error("[dev] teardown did not finish; the stack may still be up - run: bun run docker:down");
		return down.status ?? 1;
	}
	return 0;
}
let shuttingDown = false;
let firstSignalAt = 0;
let shutdown = (): void => {
	process.exit(composeDownExitCode());
};

/**
 * Installed before the stack starts, so Ctrl+C at any later point (bundling, the host launch, the log follow) tears the
 * stack down instead of leaving it running. `shutdown` is upgraded once log-following starts.
 */
function onSignal(signal: NodeJS.Signals): void {
	const now = Date.now();
	if (shuttingDown) {
		// One terminal Ctrl+C arrives here TWICE: the process-group delivery plus the `bun run` wrapper forwarding the
		// same signal.
		//
		//   without the window -> the duplicate killed the teardown before it started
		if (now - firstSignalAt > 1000) {
			console.error("[dev] aborted during teardown; the stack may still be up - run: bun run docker:down");
			process.exit(signal === "SIGTERM" ? 143 : 130);
		}
		return;
	}
	shuttingDown = true;
	firstSignalAt = now;
	shutdown();
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

/** The main entry's group identity, known before the stack is up, so the profile fingerprint can include it. */
const seedIdentity = {
	label: "Fake LiteLLM",
	baseUrl: `http://localhost:${port}`,
	apiKey,
} as const;

// The global models.* records; each entry demonstrates one rule of docs/models.md, named in its comment.
const DEMO_GLOBAL_RECORDS: DevSeedModels = {
	parameters: {
		// Inheritable house defaults; every model without a better match shows them.
		"*": { _inheritable: true, temperature: 0.7, top_p: 0.9 },
		// Glob over the gpt-5.2 family: a forced temperature (beats runtime options) that travels to gpt-5.2-mini via
		// inheritance, and a barrier that stops the catch-all's top_p at this record.
		"gpt-5*": { _inheritable: true, _inherit_from: false, _force: ["temperature"], temperature: 1 },
		// Exact ID beside the glob: its own field plus the inherited forced one.
		"gpt-5.2-mini": { max_tokens: 8192 },
		// Regex tier: deepseek-r2 gets this plus the catch-all's inheritable fields.
		"/deepseek.*/i": { reasoning_effort: "high" },
	},
	capabilities: {
		// A fallback fill that WINS somewhere: llama-4-scout declares no limits, and a fallback outranks its implicit
		// catalog match.
		"*": { _inheritable: true, _fallback: ["context_length"], context_length: 131072 },
		// Catalog derivation, ranked above the server's report: the Caps inspector shows deepseek-r2's reported limits
		// shadowed beneath the catalog entry.
		"deepseek-r2": { _openrouter_model: "deepseek/deepseek-r1" },
	},
};

// Entry-over-global on gpt-5.2-mini: max_tokens beats the global exact record; temperature stays forced by gpt-5*.
const DEMO_MAIN_ENTRY_MODELS: DevSeedModels = {
	parameters: { "gpt-5.2-mini": { max_tokens: 4000, temperature: 0.2 } },
};

// Seeded verbatim (nothing to measure), so the Servers page always shows failure presentation beside the healthy demos.
const DEMO_ERROR_ENTRIES: readonly DevSeedEntry[] = [
	{
		//   Port 4 -> IANA-unassigned, outside every OS ephemeral range, and privileged on Unix-likes
		label: "Dev Error (unreachable)",
		baseUrl: "http://localhost:4",
		apiKey: "sk-dev-error-unreachable",
	},
	{
		// The real proxy with a key it never issued: LiteLLM answers 401, which classifies as an auth error (never
		// retried, never re-wrapped).
		label: "Dev Error (bad key)",
		baseUrl: seedIdentity.baseUrl,
		apiKey: "sk-dev-error-bad-key",
	},
	{
		// A healthy server whose entry records are broken: an invalid regex matcher (warning) plus a misspelled
		// capability field the observed /model/info keys expose as a likely typo (advisory), both on Diagnostics.
		label: "Dev Error (misconfigured)",
		baseUrl: seedIdentity.baseUrl,
		apiKey,
		models: {
			parameters: { "/[unclosed/": { temperature: 0.5 } },
			capabilities: { "*": { supports_visoin: true } },
		},
	},
];

// DEV_NO_ERROR_SEED=1 drops the error zoo; the fingerprint tracks the choice, so flipping it resets the profile.
const errorEntries: readonly DevSeedEntry[] = process.env.DEV_NO_ERROR_SEED === "1" ? [] : DEMO_ERROR_ENTRIES;

// The dedicated user-data-dir; F5's "Run Extension" shares it, and the preflight below may wipe it.
const profileDir = join(root, ".dev-profile");

// Read before anything starts or is written: rmSync below is destructive, so the root must be this repository.
const rootPackageJson = join(root, "package.json");

// The preflight runs before anything starts or is written, so a refusal exits with no stack to tear down and no seed on
// disk. A malformed package.json must produce the refusal below, not a raw SyntaxError, so the parse failure reads as
// "not this repository".
let packageMeta: { name?: string; publisher?: string } = {};
try {
	if (existsSync(rootPackageJson)) {
		packageMeta = JSON.parse(readFileSync(rootPackageJson, "utf8")) as { name?: string; publisher?: string };
	}
} catch {
	packageMeta = {};
}
const rootIsThisRepo = packageMeta.name === "litellm-vscode-chat";
if (!rootIsThisRepo) {
	console.error(`[dev] refusing to manage the dev profile: ${root} is not the litellm-vscode-chat repository root`);
	process.exit(1);
}

// Holds the fingerprint of the seed configuration that populated the profile.
const markerFile = join(profileDir, "seed-fingerprint");

// Exactly what shapes the host's provider groups; the budgets and records stay out, since they change per run.
const seedGroupIdentity = [
	seedIdentity,
	...DEMO_USAGE_KEYS.map((spec) => ({ label: spec.label, baseUrl: seedIdentity.baseUrl, apiKey: spec.key })),
	...errorEntries.map(({ label, baseUrl, apiKey: entryKey }) => ({ label, baseUrl, apiKey: entryKey })),
];

// codeql[js/insufficient-password-hash] -- not password storage: a change-detection fingerprint of the dev seed
const seedFingerprint = createHash("sha256").update(JSON.stringify(seedGroupIdentity)).digest("hex");

// Undefined on a fresh profile, which then reads as a configuration change and is created from scratch.
const previousFingerprint = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim() : undefined;

function readProfileFile(...relative: string[]): string | undefined {
	try {
		return readFileSync(join(profileDir, ...relative), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * settings.json is JSONC, and either extension would make a strict parse read a seeded profile as unseeded.
 * String-aware, so a comma or slash inside a value never changes it.
 *
 *   whitespace, not a deletion -> a comment lodged mid-token cannot weld the fragments around it into a valid literal
 *   "[,]"                      -> stays invalid
 */
function stripJsoncExtensions(text: string): string {
	const out: string[] = [];
	let inString = false;
	let prev = "";
	let danglingComma = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (inString) {
			out.push(ch);
			if (ch === "\\" && i + 1 < text.length) {
				out.push(text[i + 1] as string);
				i++;
			} else if (ch === '"') {
				inString = false;
				prev = '"';
			}
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			out.push(" ");
			while (i + 1 < text.length && text[i + 1] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end < 0) {
				// Unterminated: malformed, not strippable. The unmodified text makes JSON.parse reject it, and the
				// caller keeps the profile.
				return text;
			}
			out.push(" ");
			i = end + 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			danglingComma = -1;
			prev = "";
			out.push(ch);
			continue;
		}
		if (ch === ",") {
			danglingComma = /["\]}0-9A-Za-z]/.test(prev) ? out.length : -1;
			prev = ch;
			out.push(ch);
			continue;
		}
		if (ch === "]" || ch === "}") {
			if (danglingComma >= 0) {
				out.splice(danglingComma, 1);
			}
			danglingComma = -1;
			prev = ch;
			out.push(ch);
			continue;
		}
		if (!/\s/.test(ch)) {
			danglingComma = -1;
			prev = ch;
		}
		out.push(ch);
	}
	return out.join("");
}

const serversSettingKey = `${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`;

/**
 * The marker cannot answer this - it is written BEFORE the host launches - so "marker present, group absent" also
 * describes a host that never activated, and wiping on that would reset the profile every run. An unreadable or
 * malformed settings file keeps the profile: the failure mode is a skipped reset, never a wipe.
 *
 *   applying it -> writes a servers entry with the seed's label into the profile's User/settings.json
 */
function profileConsumedSeed(): boolean {
	const raw = readProfileFile("User", "settings.json");
	if (raw === undefined) {
		return false;
	}
	let settings: unknown;
	try {
		settings = JSON.parse(stripJsoncExtensions(raw));
	} catch {
		return false;
	}
	if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
		return false;
	}
	const servers = (settings as Record<string, unknown>)[serversSettingKey];
	if (!Array.isArray(servers)) {
		return false;
	}
	return servers.some((entry) => {
		if (entry === null || typeof entry !== "object") {
			return false;
		}
		const label = (entry as { label?: unknown }).label;
		// Trimmed like the seed consumer matches labels (upsertSeedEntry).
		return typeof label === "string" && label.trim() === seedIdentity.label;
	});
}

/**
 * Whether the seeded group is still in the host's group store, User/chatLanguageModels.json. Absent, unparsable, or
 * group-less all count as gone - the caller only asks after profileConsumedSeed() proved the group was once created.
 */
function profileHasSeededGroup(): boolean {
	const raw = readProfileFile("User", "chatLanguageModels.json");
	if (raw === undefined) {
		return false;
	}
	let groups: unknown;
	try {
		groups = JSON.parse(raw);
	} catch {
		return false;
	}
	if (!Array.isArray(groups)) {
		return false;
	}
	return groups.some(
		(group) =>
			group !== null &&
			typeof group === "object" &&
			(group as { vendor?: unknown }).vendor === VENDOR_ID &&
			(group as { name?: unknown }).name === seedIdentity.label
	);
}

// One reset per lost group: while the breadcrumb is present, a still-missing group logs instead of wiping again.
const reseedBreadcrumb = join(profileDir, "seed-reseeded");

// The host's provider-group command is add-only, so a group left by an earlier run could never be brought up to date:
// any change to the fingerprint wipes the profile before launch, and the wipe discards the Copilot Chat sign-in.
//
//   budgets and records              -> out of the fingerprint: plain settings the seed upserts freely, tuned per run
//   fingerprint matches, group gone  -> a developer deleted it by hand; re-seed once, as a configuration change would
//   still gone after that reset      -> the group add itself is failing; log, since wiping every run would pile
//                                       sign-in loss on top of that bug
let wipeReason: string | undefined;
let missingGroupReset = false;
if (previousFingerprint !== seedFingerprint) {
	wipeReason = "seed configuration changed";
} else if (profileConsumedSeed()) {
	if (profileHasSeededGroup()) {
		rmSync(reseedBreadcrumb, { force: true });
	} else if (existsSync(reseedBreadcrumb)) {
		console.error(
			"[dev] the seeded group is missing again after a profile reset; the group add is failing, so the profile is kept - inspect the extension logs (or delete .dev-profile to retry from scratch)"
		);
	} else {
		wipeReason = "seeded group missing from the profile";
		missingGroupReset = true;
	}
}
if (wipeReason !== undefined) {
	if (existsSync(profileDir)) {
		// Wiping under a live host would yank its state out from under it, so a visible host blocks the launch. Best
		// effort, not a lock: when ps is unavailable or misses the host (see findDevHostPid), the wipe proceeds.
		if (findDevHostPid() !== undefined) {
			console.error(
				"[dev] the dev profile is in use by a running Extension Development Host; close that window and re-run"
			);
			process.exit(1);
		}
		console.log(`[dev] ${wipeReason}; resetting the dedicated dev profile`);
	}
	rmSync(profileDir, { recursive: true, force: true });
}
mkdirSync(profileDir, { recursive: true });
writeFileSync(markerFile, `${seedFingerprint}\n`);
if (missingGroupReset) {
	writeFileSync(reseedBreadcrumb, "");
}

// Explicit env wins.
//
//   Verbose by default -> in the dev stack (and only there)
run("starting the fake LiteLLM stack", ["bun", "scripts/stack/compose.ts", "up", "-d", "--wait"], {
	FAKE_VERBOSE: process.env.FAKE_VERBOSE ?? "1",
});

// The child seeding script (this file is CommonJS, so no top-level await) writes its measurements here.
const demoResultsPath = join(root, "docker", ".generated", "dev-demo-usage.json");

// Absolute, like composeCli: knip's literal-argv scan must not resolve the script path relative to this file.
const demoUsageCli = join(root, "scripts", "dev", "seed-demo-usage.ts");

// A failure costs the usage demo, never the run; DEV_NO_USAGE_SEED=1 skips it for a faster launch.
let demoUsage: SeededDemoUsage[] = [];
if (process.env.DEV_NO_USAGE_SEED === "1") {
	console.log("[dev] DEV_NO_USAGE_SEED=1: skipping the demo usage seeding");
} else {
	console.log("[dev] seeding demo usage spend (a few completions, then LiteLLM's spend flush; ~30s)");
	rmSync(demoResultsPath, { force: true });
	const demoSeedRun = spawnSync("bun", [demoUsageCli, "--out", demoResultsPath], {
		stdio: "inherit",
		cwd: root,
	});
	if (demoSeedRun.signal === "SIGINT" || demoSeedRun.signal === "SIGTERM") {
		onSignal(demoSeedRun.signal);
	}
	if (demoSeedRun.status === 0) {
		try {
			demoUsage = JSON.parse(readFileSync(demoResultsPath, "utf8")) as SeededDemoUsage[];
		} catch {
			// Unreadable results are handled below like a failed seeding run.
		}
	}
	rmSync(demoResultsPath, { force: true });
	if (demoUsage.length === 0) {
		console.warn(
			"[dev] demo usage seeding failed; new runs get no demo usage entries, and entries seeded by an earlier run keep their previous state - rerun: bun scripts/dev/seed-demo-usage.ts"
		);
	}
}

run("building the dev bundle", ["bun", "run", "bundle:dev"]);

const seed: DevSeed = {
	...seedIdentity,
	openDashboard: true,
	models: DEMO_MAIN_ENTRY_MODELS,
	entries: [
		...demoUsage.map(({ spec, entryBudget }) => ({
			label: spec.label,
			baseUrl: seedIdentity.baseUrl,
			apiKey: spec.key,
			...(entryBudget === undefined ? {} : { budget: entryBudget }),
		})),
		...errorEntries,
	],
	records: DEMO_GLOBAL_RECORDS,
};
writeFileSync(join(root, DEV_SEED_FILENAME), `${JSON.stringify(seed, null, "\t")}\n`);
console.log(`[dev] seed written for ${seed.baseUrl}`);
// Loud on purpose: the demo parameter records ride every dev-host request, which would otherwise read as a pass-through
// regression while debugging.
console.log(
	"[dev] demo model records are active (temperature/top_p defaults; gpt-5* forces temperature=1) - delete .dev-profile to reset"
);
// The error rows would otherwise read as a broken stack while debugging.
if (errorEntries.length > 0) {
	console.log(
		"[dev] error-state demo servers are seeded (unreachable / bad key / misconfigured records); their failing rows are intentional - DEV_NO_ERROR_SEED=1 skips them"
	);
} else {
	console.log("[dev] DEV_NO_ERROR_SEED=1: skipping the error-state demo servers");
}

// ---- Live log follow ----
const logsDir = join(root, "logs");

mkdirSync(logsDir, { recursive: true });
const logSinks: WriteStream[] = [];
const logChildren: ChildProcess[] = [];
const logChildrenClosed: Promise<void>[] = [];

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function endSinks(): Promise<void> {
	return new Promise((resolve) => {
		let open = logSinks.length;
		if (open === 0) {
			resolve();
			return;
		}
		for (const sink of logSinks) {
			sink.end(() => {
				open--;
				if (open <= 0) {
					resolve();
				}
			});
		}
	});
}

interface LineForwarder {
	push(chunk: Buffer): void;
	flush(): void;
}

function forwardLines(label: string, sink: WriteStream): LineForwarder {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	return {
		push(chunk: Buffer): void {
			sink.write(chunk);
			pending += decoder.write(chunk);
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim() !== "") {
					console.log(`[${label}] ${line}`);
				}
			}
		},
		flush(): void {
			pending += decoder.end();
			if (pending.trim() !== "") {
				console.log(`[${label}] ${pending}`);
			}
			pending = "";
		},
	};
}

function followComposeService(service: string, label: string): void {
	const sink = createWriteStream(join(logsDir, `${service}.log`));
	logSinks.push(sink);
	// No --no-log-prefix: podman-compose does not accept it, and this repo supports both runtimes. detached puts the
	// compose child in its own process group so teardown can kill the real `docker compose logs -f` grandchild, not
	// just the bun wrapper.
	const child = spawn("bun", [composeCli, "logs", "-f", service], { cwd: root, detached: true });
	logChildren.push(child);
	// One forwarder per stream: stdout and stderr chunks must not share a partial-line buffer.
	const stdoutForward = forwardLines(label, sink);
	const stderrForward = forwardLines(label, sink);
	child.stdout?.on("data", (chunk: Buffer) => stdoutForward.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderrForward.push(chunk));
	child.on("error", (error: Error) => {
		console.error(`[dev] could not follow ${service} logs: ${error.message}`);
	});
	logChildrenClosed.push(
		new Promise((resolve) => {
			child.on("close", (code: number | null) => {
				stdoutForward.flush();
				stderrForward.flush();
				if (!shuttingDown && code !== 0) {
					console.error(`[dev] the ${service} log stream ended (exit ${code}); this stream is now silent`);
				}
				resolve();
			});
			child.on("error", () => resolve());
		})
	);
}

function killLogChildren(): void {
	for (const child of logChildren) {
		if (child.pid !== undefined) {
			// Negative pid = the whole detached process group, so the real compose process dies too, not only the bun
			// wrapper.
			try {
				process.kill(-child.pid, "SIGTERM");
				continue;
			} catch {
				// Group already gone or not created; fall through.
			}
		}
		child.kill();
	}
}

// publisher.name: the directory under the profile's exthost logs that holds the extension's output channel files.
const extensionLogId = `${packageMeta.publisher ?? ""}.${packageMeta.name ?? ""}`;

// Bytes already forwarded per channel file; a file first seen mid-run starts at 0 and streams whole.
const tailOffsets = new Map<string, number>();

// The host's channel lines, mirrored to one file beside the stack service logs.
const vscodeSink = createWriteStream(join(logsDir, "vscode-extension.log"));

logSinks.push(vscodeSink);
const forwardVscode = forwardLines("vscode", vscodeSink);

function readDirNames(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function extensionLogFiles(): string[] {
	const found: string[] = [];
	const sessionsRoot = join(profileDir, "logs");
	for (const session of readDirNames(sessionsRoot)) {
		const sessionDir = join(sessionsRoot, session);
		for (const window of readDirNames(sessionDir)) {
			const channelDir = join(sessionDir, window, "exthost", extensionLogId);
			for (const file of readDirNames(channelDir)) {
				if (file.endsWith(".log")) {
					found.push(join(channelDir, file));
				}
			}
		}
	}
	return found;
}

function tailExtensionLogsOnce(): void {
	for (const file of extensionLogFiles()) {
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			continue;
		}
		let offset = tailOffsets.get(file) ?? 0;
		if (offset > size) {
			// Truncated or rotated under us: the content is fresh, replay it.
			offset = 0;
		}
		if (size <= offset) {
			tailOffsets.set(file, offset);
			continue;
		}
		try {
			const fd = openSync(file, "r");
			try {
				const buffer = Buffer.alloc(size - offset);
				const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
				tailOffsets.set(file, offset + bytesRead);
				if (bytesRead > 0) {
					forwardVscode.push(buffer.subarray(0, bytesRead));
				}
			} finally {
				closeSync(fd);
			}
		} catch {
			// The file can disappear between stat and open; the next tick re-stats.
		}
	}
}

// Snapshot BEFORE the host launches so its very first log lines stream (a post-launch snapshot would either skip them
// or replay a pre-existing session file's whole history). Everything already in a channel file is history, everything
// appended afterwards streams, including appends to a session directory that predates this launch, which happens when
// the single-instance hand-off routes the new window into one.
for (const file of extensionLogFiles()) {
	try {
		tailOffsets.set(file, statSync(file).size);
	} catch {
		// Unreadable now; the tail loop treats it as new if it reappears.
	}
}

// Handed to the `code` invocation, so `bun run dev -- --locale=zh-cn` launches a localized dev host.
const passthroughArgs = process.argv.slice(2);

if (passthroughArgs[0] === "--") {
	passthroughArgs.shift();
}

// --locale needs the matching language pack in the real extensions directory; without it the host stays English. F5's
// "Run Extension" shares this profile, and VS Code allows one instance per user-data-dir, so `bun run dev` under a live
// F5 host hands it the arguments.
run("opening the Extension Development Host", [
	"code",
	"--new-window",
	`--user-data-dir=${profileDir}`,
	`--extensionDevelopmentPath=${root}`,
	...passthroughArgs,
]);
console.log("[dev] window launched; the seed configures the server on activation");

// Where the dev host loads extensions from; extensions installed into a VS Code profile are invisible to it.
const defaultExtensionsDir = join(homedir(), ".vscode", "extensions");

// Judged by directory name alone, and an unreadable extensions directory must not fail the launch.
const hasCopilotChat = (() => {
	try {
		return readdirSync(defaultExtensionsDir).some((entry) => entry.startsWith("github.copilot-chat-"));
	} catch {
		return false;
	}
})();

// Warn loudly, never auto-install: without Copilot Chat the extension activates but has no chat surface, which reads
// as "does nothing".
if (!hasCopilotChat) {
	console.error("[dev] ============================================================");
	console.error("[dev] WARNING: GitHub Copilot Chat is not installed in the DEFAULT");
	console.error(`[dev] extensions directory (${defaultExtensionsDir}).`);
	console.error("[dev] The dev host only loads extensions from there - it cannot see");
	console.error("[dev] extensions installed into a VS Code profile. Chat features");
	console.error("[dev] (the model picker, chat requests) need Copilot Chat: install");
	console.error("[dev] it in the default profile, then relaunch bun run dev.");
	console.error("[dev] ============================================================");
}

const tailTimer = setInterval(tailExtensionLogsOnce, 1000);

/**
 * The dev host's Electron MAIN process pid, found by argv: the exact --user-data-dir element for this profile,
 * excluding Chromium helpers by their --type= argument. VS Code keeps no SingletonLock on any platform, and its own
 * code.lock is undocumented, while argv is observable everywhere ps exists.
 *
 *   The whole-element match                      -> keeps a sibling profile like "<profileDir>-other" from matching
 *   Where an old and a new host briefly overlap  -> the youngest wins
 */
function findDevHostPid(): number | undefined {
	// -ww: GNU ps truncates command= to COLUMNS otherwise, which would silently hide a long profile path; macOS accepts
	// the flag as a no-op. etime is the POSIX-portable elapsed-time keyword ([[dd-]hh:]mm:ss).
	const ps = spawnSync("ps", ["-axww", "-o", "pid=,etime=,command="], { encoding: "utf8" });
	if (ps.status !== 0) {
		return undefined;
	}
	const flag = `--user-data-dir=${profileDir}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const element = new RegExp(`(^|\\s)${flag}(\\s|$)`);
	let found: number | undefined;
	let foundElapsed = Number.POSITIVE_INFINITY;
	for (const line of ps.stdout.split("\n")) {
		const fields = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (fields === null) {
			continue;
		}
		const command = (fields[3] as string).trimEnd();
		if (!element.test(command) || / --type=/.test(` ${command}`)) {
			continue;
		}
		const pid = Number(fields[1]);
		if (!Number.isInteger(pid) || pid <= 0) {
			continue;
		}
		// An unparsable elapsed field counts as infinitely old; equal ages keep the later line, so a ps whose etime
		// column is unusable degrades to last-match instead of finding nothing.
		const elapsed = parseEtimeSeconds(fields[2] as string) ?? Number.POSITIVE_INFINITY;
		if (elapsed <= foundElapsed) {
			found = pid;
			foundElapsed = elapsed;
		}
	}
	return found;
}

/** ps's `etime` value ([[dd-]hh:]mm:ss) as seconds; undefined for anything else. */
function parseEtimeSeconds(etime: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
	if (match === null) {
		return undefined;
	}
	const [, days, hours, minutes, seconds] = match;
	return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * The main process hosts every window on this profile, so an F5-launched host sharing it closes too: Ctrl+C here means
 * the stack it depends on is going away.
 */
function closeDevHost(): void {
	const pid = findDevHostPid();
	if (pid === undefined) {
		return;
	}
	console.log("[dev] closing the Extension Development Host");
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already gone between the scan and the signal.
	}
}

shutdown = (): void => {
	void (async (): Promise<void> => {
		clearInterval(tailTimer);
		// A final pass so extension log lines from the last polling interval are not lost, then flush the partial-line
		// buffers.
		tailExtensionLogsOnce();
		forwardVscode.flush();
		killLogChildren();
		closeDevHost();
		// The children's final data/close callbacks must drain BEFORE anything blocks the event loop or the sinks
		// close; a hung child forfeits its tail after the timeout.
		await Promise.race([Promise.all(logChildrenClosed), delay(1500)]);
		const exitCode = composeDownExitCode();
		// end() flushes asynchronously; the timeout is the backstop against a sink that never finishes.
		await Promise.race([endSinks(), delay(2000)]);
		process.exit(exitCode);
	})();
};

followComposeService("litellm", "litellm");
followComposeService("fake-openai", "fake");
console.log(`[dev] streaming litellm + fake-openai + extension logs (teed into logs/)`);
console.log("[dev] Ctrl+C stops the stream and tears the stack down");
