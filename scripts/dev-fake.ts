#!/usr/bin/env bun
// Launches an Extension Development Host preconfigured against the local
// fake LiteLLM stack: starts the docker proxy + fake OpenAI backend, builds
// the dev bundle, drops a one-shot seed file the extension consumes on its
// next development-mode activation (src/extension/devSeed.ts), and opens a
// new VS Code window in extension-development mode.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	existsSync,
	lstatSync,
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
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { composeSetting, readEnvFile } from "./litellmConfig";

/** Whether a directory entry exists at all, symlink targets notwithstanding (existsSync follows symlinks). */
function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

const root = process.cwd();

// The seed must agree with what docker-compose resolves, so it uses the same
// ${VAR:-fallback} semantics: shell env wins even when empty, .env fills in
// only unset variables, and an empty result takes the compose default.
const envFile = readEnvFile();
const port = composeSetting("LITELLM_PORT", "4000", envFile);
const apiKey = composeSetting("LITELLM_MASTER_KEY", "sk-test-1234", envFile);

function run(label: string, cmd: string[]): void {
	console.log(`[dev:fake] ${label}`);
	const result = spawnSync(cmd[0] as string, cmd.slice(1), { stdio: "inherit", cwd: root });
	if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
		// The signal handler cannot dispatch while spawnSync blocks; honor the
		// interrupt here so an already-started stack still comes down.
		onSignal();
	}
	if (result.error !== undefined) {
		console.error(`[dev:fake] ${label} failed: could not run "${cmd[0]}" (${result.error.message})`);
		if (cmd[0] === "code") {
			console.error(
				`[dev:fake] install the "code" shell command: VS Code > Command Palette > "Shell Command: Install 'code' command in PATH"`
			);
		}
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`[dev:fake] ${label} failed (exit ${result.status})`);
		process.exit(result.status ?? 1);
	}
}

// ── Teardown on signal ───────────────────────────────────────────────────────
// Installed before the stack starts, so Ctrl+C at any later point (bundling,
// the host launch, the log follow) tears the stack down instead of leaving it
// running. The handler is upgraded once log-following starts.
const composeCli = join(root, "scripts", "compose.ts");
// knip parses literal child_process argument arrays and reported the compose
// subcommands here ("logs", "down") as unlisted binaries; building the argv
// through a helper keeps the call sites opaque to that scan.
function composeArgv(...args: string[]): [string, string[]] {
	return ["bun", [composeCli, ...args]];
}
function composeDownExitCode(): number {
	console.log("\n[dev:fake] stopping the fake stack");
	const [downCmd, downArgs] = composeArgv("down");
	const down = spawnSync(downCmd, downArgs, { stdio: "inherit", cwd: root });
	if (down.signal !== null) {
		// A second Ctrl+C lands on the compose child directly while spawnSync
		// blocks signal dispatch here; honor it as an interrupt.
		console.error("[dev:fake] teardown interrupted; the stack may still be up - run: bun run docker:down");
		return 130;
	}
	if (down.status !== 0) {
		console.error("[dev:fake] teardown did not finish; the stack may still be up - run: bun run docker:down");
		return down.status ?? 1;
	}
	return 0;
}
let shuttingDown = false;
let shutdown = (): void => {
	process.exit(composeDownExitCode());
};
function onSignal(): void {
	if (shuttingDown) {
		// A second Ctrl+C during teardown must not wedge the terminal.
		process.exit(130);
	}
	shuttingDown = true;
	shutdown();
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

run("starting the fake LiteLLM stack", ["bun", "scripts/compose.ts", "up", "-d", "--wait"]);
run("building the dev bundle", ["bun", "run", "bundle:dev"]);

const seed = {
	label: "Fake LiteLLM",
	baseUrl: `http://localhost:${port}`,
	apiKey,
	openDashboard: true,
};
writeFileSync(join(root, ".dev-fake-seed.json"), `${JSON.stringify(seed, null, "\t")}\n`);
console.log(`[dev:fake] seed written for ${seed.baseUrl}`);

// The dev host runs on its own persistent profile. The host's provider-group
// command is add-only, so a group left behind by an earlier run with a
// different port, key, or label could never be brought up to date; instead,
// a marker in the profile records the seed configuration that populated it,
// and any change wipes the profile before launch. Wiping is safe precisely
// because nothing but dev:fake ever uses this profile. Same config, same
// profile: the existing group already matches what the sync engine expects.
// DX cost: changing LITELLM_PORT or LITELLM_MASTER_KEY discards the whole
// profile, including the Copilot Chat sign-in, so the next run signs in again.
// F5's "Run Extension" launch shares this profile; because of the Electron
// singleton, running dev:fake while an F5 host is up hands the arguments to
// that running instance - and a changed fingerprint wipes that live session's
// profile out from under it, so close the F5 host first.
const profileDir = join(root, ".dev-profile");
// rmSync below is destructive, so the root must be this repository before it
// runs: a wrong cwd (never expected, since compose already ran here) must not
// let it delete an unrelated .dev-profile. Structural, not incidental.
const rootPackageJson = join(root, "package.json");
// A malformed package.json must produce the refusal below, not a raw
// SyntaxError, so the parse failure reads as "not this repository".
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
	console.error(
		`[dev:fake] refusing to manage the dev profile: ${root} is not the litellm-vscode-chat repository root`
	);
	process.exit(1);
}
const markerFile = join(profileDir, "seed-fingerprint");
// codeql[js/insufficient-password-hash] -- not password storage: a change-detection fingerprint of the dev seed (a well-known local test key)
const seedFingerprint = createHash("sha256").update(JSON.stringify(seed)).digest("hex");
const previousFingerprint = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim() : undefined;
if (previousFingerprint !== seedFingerprint) {
	if (existsSync(profileDir)) {
		// Electron drops a SingletonLock in a live user-data-dir; wiping while a
		// dev host still holds it would yank state from under it. This is not a
		// hard lock (no cross-process guarantee), just a heads-up for the common
		// case of a second dev:fake with a changed port. The lock is typically a
		// dangling symlink (it points at hostname-pid, not a real file), which
		// existsSync would report as absent, so presence is checked with lstat.
		if (pathEntryExists(join(profileDir, "SingletonLock"))) {
			console.warn(
				"[dev:fake] warning: the dev profile looks in use by another Extension Development Host; close it before continuing"
			);
		}
		console.log("[dev:fake] seed configuration changed; resetting the dedicated dev profile");
	}
	rmSync(profileDir, { recursive: true, force: true });
}
mkdirSync(profileDir, { recursive: true });
writeFileSync(markerFile, `${seedFingerprint}\n`);

// ── Live log follow ──────────────────────────────────────────────────────────
// The terminal stays attached: both container logs and the extension's output
// channel stream here, each teed into logs/ for later reading (truncated per
// run). Ctrl+C tears the stack down; the dev window stays open, it just loses
// its server.
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
	// No --no-log-prefix: podman-compose does not accept it, and this repo
	// supports both runtimes. detached puts the compose child in its own
	// process group so teardown can kill the real `docker compose logs -f`
	// grandchild, not just the bun wrapper.
	const [logsCmd, logsArgs] = composeArgv("logs", "-f", service);
	const child = spawn(logsCmd, logsArgs, { cwd: root, detached: true });
	logChildren.push(child);
	// One forwarder per stream: stdout and stderr chunks must not share a
	// partial-line buffer.
	const stdoutForward = forwardLines(label, sink);
	const stderrForward = forwardLines(label, sink);
	child.stdout?.on("data", (chunk: Buffer) => stdoutForward.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderrForward.push(chunk));
	child.on("error", (error: Error) => {
		console.error(`[dev:fake] could not follow ${service} logs: ${error.message}`);
	});
	logChildrenClosed.push(
		new Promise((resolve) => {
			child.on("close", (code: number | null) => {
				stdoutForward.flush();
				stderrForward.flush();
				if (!shuttingDown && code !== 0) {
					console.error(`[dev:fake] the ${service} log stream ended (exit ${code}); this stream is now silent`);
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
			// Negative pid = the whole detached process group, so the real
			// compose process dies too, not only the bun wrapper.
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

// The extension's output channel is backed by files under the dev profile:
// logs/<session>/window*/exthost/<publisher>.<name>/*.log. Offsets are primed
// from a snapshot taken BEFORE the host launches (see below): everything
// already in a channel file is history, everything appended afterwards
// streams - including appends to a session directory that predates this
// launch, which happens whenever the Electron singleton routes the new window
// into an already-running session.
const extensionLogId = `${packageMeta.publisher ?? ""}.${packageMeta.name ?? ""}`;
const tailOffsets = new Map<string, number>();
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

// Snapshot BEFORE the host launches so its very first log lines stream (a
// post-launch snapshot would either skip them or replay a pre-existing
// session file's whole history).
for (const file of extensionLogFiles()) {
	try {
		tailOffsets.set(file, statSync(file).size);
	} catch {
		// Unreadable now; the tail loop treats it as new if it reappears.
	}
}

run("opening the Extension Development Host", [
	"code",
	"--new-window",
	`--user-data-dir=${profileDir}`,
	`--extensionDevelopmentPath=${root}`,
]);
console.log("[dev:fake] window launched; the seed configures the server on activation");

const tailTimer = setInterval(tailExtensionLogsOnce, 1000);

shutdown = (): void => {
	void (async (): Promise<void> => {
		clearInterval(tailTimer);
		// A final pass so extension log lines from the last polling interval are
		// not lost, then flush the partial-line buffers.
		tailExtensionLogsOnce();
		forwardVscode.flush();
		killLogChildren();
		// The children's final data/close callbacks must drain BEFORE anything
		// blocks the event loop or the sinks close; a hung child forfeits its
		// tail after the timeout.
		await Promise.race([Promise.all(logChildrenClosed), delay(1500)]);
		const exitCode = composeDownExitCode();
		// end() flushes asynchronously; the timeout is the backstop against a
		// sink that never finishes.
		await Promise.race([endSinks(), delay(2000)]);
		process.exit(exitCode);
	})();
};

followComposeService("litellm", "litellm");
followComposeService("fake-openai", "fake");
console.log(`[dev:fake] streaming litellm + fake-openai + extension logs (teed into logs/)`);
console.log("[dev:fake] Ctrl+C stops the stream and tears the stack down");
