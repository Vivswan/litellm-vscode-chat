#!/usr/bin/env bun
// Launches an Extension Development Host preconfigured against the local
// fake LiteLLM stack: starts the docker proxy + fake OpenAI backend, builds
// the dev bundle, drops a one-shot seed file the extension consumes on its
// next development-mode activation (src/extension/devSeed.ts), and opens a
// new VS Code window in extension-development mode.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
let rootIsThisRepo = false;
try {
	rootIsThisRepo =
		existsSync(rootPackageJson) &&
		(JSON.parse(readFileSync(rootPackageJson, "utf8")) as { name?: string }).name === "litellm-vscode-chat";
} catch {
	rootIsThisRepo = false;
}
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

run("opening the Extension Development Host", [
	"code",
	"--new-window",
	`--user-data-dir=${profileDir}`,
	`--extensionDevelopmentPath=${root}`,
]);
console.log("[dev:fake] window launched; the seed configures the server on activation");
console.log("[dev:fake] tear the stack down with: bun run docker:down");
