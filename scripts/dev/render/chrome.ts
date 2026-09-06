/**
 * Headless Chrome for the render harness: discovery, launch with its retry
 * budget, process-tree teardown, the DevTools target lookup, and the CDP
 * connection the probes evaluate through.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const READY_TIMEOUT_MS = 15000;

/**
 * Launch is the one phase that retries: on a loaded CI runner several Chromes
 * starting at once can starve each other past READY_TIMEOUT_MS, which says
 * nothing about the page. Anything after the DevTools server is up is a finding
 * about the code, and retrying it would mask nondeterminism instead of noise.
 */
const LAUNCH_ATTEMPTS = 3;

export function findChrome(): string {
	const fromEnv = process.env.CHROME_BIN;
	if (fromEnv !== undefined && fromEnv.length > 0) {
		if (!existsSync(fromEnv)) {
			throw new Error(`CHROME_BIN points at ${fromEnv}, which does not exist`);
		}
		return fromEnv;
	}
	const absoluteCandidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	];
	for (const candidate of absoluteCandidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	for (const name of ["chromium", "google-chrome", "google-chrome-stable", "chrome"]) {
		const which = spawnSync("which", [name], { encoding: "utf8" });
		if (which.status === 0) {
			const resolved = which.stdout.trim();
			if (resolved.length > 0) {
				return resolved;
			}
		}
	}
	throw new Error(
		"No Chrome found. Install Google Chrome or Chromium, or point CHROME_BIN at a Chrome binary" +
			" (tried the macOS app paths and chromium/google-chrome/google-chrome-stable/chrome on PATH)."
	);
}

/**
 * Chrome writes "<port>\n<browser ws path>" here once the DevTools server is
 * up. A Chrome that DIED on startup is not a slow one, so its exit ends the
 * wait immediately: otherwise a systematic launch failure (a forbidden sandbox,
 * a missing library) would spend the full deadline once per attempt per
 * fixture, and the sweep would hit its CI job timeout instead of reporting
 * which fixtures never ran.
 */
async function waitForDevtoolsPort(chrome: ChildProcess, userDataDir: string, timeoutMs: number): Promise<number> {
	const portFile = path.join(userDataDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const port = Number((await fs.readFile(portFile, "utf8")).split("\n")[0]);
			if (Number.isInteger(port) && port > 0) {
				return port;
			}
		} catch {
			// Not written yet.
		}
		// Read AFTER the file check, so a Chrome that wrote the port and exited
		// in the same breath is still believed about the port.
		if (chrome.exitCode !== null || chrome.signalCode !== null) {
			throw new Error(
				`Chrome exited (code ${chrome.exitCode ?? "none"}, signal ${chrome.signalCode ?? "none"})` +
					` without writing ${portFile}`
			);
		}
		await delay(100);
	}
	throw new Error(`Chrome did not write ${portFile} within ${timeoutMs}ms`);
}

/**
 * Whether this platform has POSIX process groups. Windows does not: a
 * negative-pid probe reports ESRCH for a live Chrome there, and reading that as
 * "group gone" would skip the kill entirely.
 */
const CAN_SIGNAL_PROCESS_GROUP = process.platform !== "win32";

/**
 * Ends a Chrome by its whole process group, SIGTERM then SIGKILL: a launch
 * killed mid-startup can leave renderer and GPU children the browser process
 * never got around to owning. Liveness is judged on the GROUP, not the leader,
 * because those children can outlive the browser process - precisely the leak
 * this hunts. Where group signalling does not exist or fails, the direct handle
 * and its exit or signal code are the fallback.
 */
export async function killChromeTree(chrome: ChildProcess): Promise<void> {
	// A spawn that never produced a pid has nothing to kill and reports neither
	// an exit code nor a signal, so the loop below would poll out its whole
	// grace period to signal nobody.
	if (chrome.pid === undefined) {
		return;
	}
	const leaderGone = (): boolean => chrome.exitCode !== null || chrome.signalCode !== null;
	const groupGone = (): boolean => {
		if (CAN_SIGNAL_PROCESS_GROUP && chrome.pid !== undefined) {
			try {
				process.kill(-chrome.pid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					return true;
				}
				// Probing failed some other way; the leader is the best signal left.
			}
		}
		return leaderGone();
	};
	const signalTree = (signal: NodeJS.Signals): void => {
		if (CAN_SIGNAL_PROCESS_GROUP && chrome.pid !== undefined) {
			try {
				process.kill(-chrome.pid, signal);
				return;
			} catch {
				// The group is gone or unaddressable; fall through to the handle.
			}
		}
		chrome.kill(signal);
	};
	if (groupGone()) {
		return;
	}
	signalTree("SIGTERM");
	const deadline = Date.now() + 2000;
	while (!groupGone() && Date.now() < deadline) {
		await delay(50);
	}
	if (!groupGone()) {
		signalTree("SIGKILL");
	}
}

/**
 * Launches Chrome and waits for its DevTools server, relaunching one that never
 * got there. Each attempt gets a FRESH profile directory, because the killed
 * attempt leaves a half-written one (SingletonLock included) behind; they live
 * under the caller's tmpRoot, so its one removal sweeps every attempt.
 * `onSpawn` hands the caller each attempt's process so a cancellation mid-wait
 * has something to kill, and `stopped` is read before every spawn with no await
 * in between: a cancellation that landed BETWEEN attempts already ran its
 * cleanup, and a relaunch after it would be a Chrome nothing kills.
 */
export async function launchChrome(
	chromeBin: string,
	tmpRoot: string,
	flags: readonly string[],
	pageUrl: string,
	onSpawn: (chrome: ChildProcess) => void,
	stopped: () => boolean
): Promise<{ chrome: ChildProcess; port: number }> {
	for (let attempt = 1; ; attempt++) {
		const profileDir = path.join(tmpRoot, `profile-${attempt}`);
		await fs.mkdir(profileDir);
		if (stopped()) {
			throw new Error("Launch cancelled by a termination signal");
		}
		const chrome = spawn(chromeBin, [...flags, `--user-data-dir=${profileDir}`, pageUrl], {
			stdio: "ignore",
			// Its own process group where groups exist, so killChromeTree can
			// signal the whole tree.
			detached: CAN_SIGNAL_PROCESS_GROUP,
			env: { ...process.env, TZ: "UTC", LANG: "en_US.UTF-8" },
		});
		onSpawn(chrome);
		try {
			const port = await waitForDevtoolsPort(chrome, profileDir, READY_TIMEOUT_MS);
			return { chrome, port };
		} catch (error) {
			await killChromeTree(chrome);
			if (attempt >= LAUNCH_ATTEMPTS) {
				throw error;
			}
			console.log(
				`chrome launch ${attempt}/${LAUNCH_ATTEMPTS} brought up no DevTools server` +
					` (${error instanceof Error ? error.message : String(error)}); relaunching with a fresh profile`
			);
		}
	}
}

interface DevtoolsTarget {
	readonly type?: string;
	readonly url?: string;
	readonly webSocketDebuggerUrl?: string;
}

export async function findPageTargetUrl(port: number, pageUrl: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = (await response.json()) as readonly DevtoolsTarget[];
			const page = targets.find((target) => target.type === "page" && target.url === pageUrl);
			if (page?.webSocketDebuggerUrl !== undefined) {
				return page.webSocketDebuggerUrl;
			}
		} catch {
			// DevTools HTTP endpoint not ready yet.
		}
		await delay(100);
	}
	throw new Error(`Chrome never listed a page target for ${pageUrl} within ${timeoutMs}ms`);
}

/** A minimal DevTools protocol client over Chrome's page WebSocket: send a method, await its result. */

export class CdpConnection {
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private nextId = 1;

	private constructor(private readonly socket: WebSocket) {}

	static connect(url: string): Promise<CdpConnection> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const connection = new CdpConnection(socket);
			socket.addEventListener("open", () => resolve(connection));
			socket.addEventListener("error", () => {
				reject(new Error(`DevTools WebSocket connection to ${url} failed`));
				connection.rejectPending(new Error("DevTools WebSocket errored"));
			});
			socket.addEventListener("message", (event) => connection.onMessage(String(event.data)));
			// A Chrome that dies mid-session must fail every in-flight command,
			// not leave its awaiter hanging forever.
			socket.addEventListener("close", () => connection.rejectPending(new Error("DevTools WebSocket closed")));
		});
	}

	private rejectPending(error: Error): void {
		for (const waiter of this.pending.values()) {
			waiter.reject(error);
		}
		this.pending.clear();
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	private onMessage(text: string): void {
		const message = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
		if (message.id === undefined) {
			return; // Protocol events; the harness only awaits command results.
		}
		const waiter = this.pending.get(message.id);
		if (waiter === undefined) {
			return;
		}
		this.pending.delete(message.id);
		if (message.error !== undefined) {
			waiter.reject(new Error(message.error.message ?? "DevTools command failed"));
		} else {
			waiter.resolve(message.result);
		}
	}

	close(): void {
		this.socket.close();
	}
}

interface EvaluateResult {
	readonly result?: { readonly value?: unknown };
	readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } };
}

export async function evaluate(cdp: CdpConnection, expression: string, awaitPromise = false): Promise<unknown> {
	const raw = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise })) as EvaluateResult;
	if (raw.exceptionDetails !== undefined) {
		const reason = raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? "unknown error";
		throw new Error(`Page evaluation failed: ${reason}\n  in: ${expression}`);
	}
	return raw.result?.value;
}

export async function setWidth(cdp: CdpConnection, width: number, height: number, dpr: number): Promise<void> {
	await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
	await evaluate(cdp, "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))", true);
}
