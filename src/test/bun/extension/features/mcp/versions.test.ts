import { describe, expect, test } from "bun:test";
import * as assert from "node:assert";
import { McpVersionCounters, type VersionStore } from "../../../../../extension/features/mcp/versions";
import type { DeclaredServer } from "../../../../../extension/servers/serverSync/setting";
import { MCP_ENTRY_VERSIONS_KEY } from "../../../../../shared/config/storageKeys";

/**
 * The rotation counter. Two things are load-bearing and neither is obvious:
 * a rotation must always be REPORTED (the editor would otherwise keep offering
 * tools authenticated by a credential that no longer works), and activation
 * must never be announced as one (every window would prompt a tool refresh).
 * Reporting is exactly-once: a rotation whose counter write then fails is not
 * retried, because the next rotation bumps the counter anyway.
 */

/**
 * `slow` makes the write actually yield before it lands. A store that writes
 * synchronously closes the read-modify-write window by accident and would let
 * an unserialized counter pass; the real Memento does not, so the concurrency
 * test uses this one.
 */
function store(initial: unknown = undefined, slow = false): VersionStore & { value: unknown } {
	return {
		value: initial,
		get<T>(key: string): T | undefined {
			return key === MCP_ENTRY_VERSIONS_KEY ? (this.value as T | undefined) : undefined;
		},
		async update(key: string, value: unknown): Promise<void> {
			if (slow) {
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			if (key === MCP_ENTRY_VERSIONS_KEY) {
				this.value = value;
			}
		},
	};
}

function entry(overrides: Partial<DeclaredServer> = {}): DeclaredServer {
	return { label: "Main", baseUrl: "http://localhost:4000", mcp: true, ...overrides };
}

describe("extension/features/mcp/versions", () => {
	test("an entry never rotated publishes 0", () => {
		assert.strictEqual(new McpVersionCounters(store()).versionOf("Main"), 0);
	});

	test("each bump increments exactly its own label", async () => {
		const backing = store();
		const counters = new McpVersionCounters(backing);
		await counters.bump("Main");
		await counters.bump("Main");
		await counters.bump("Other");
		assert.strictEqual(counters.versionOf("Main"), 2);
		assert.strictEqual(counters.versionOf("Other"), 1);
		assert.deepStrictEqual(backing.value, { Main: 2, Other: 1 });
	});

	test("concurrent bumps all land: the writes serialize instead of interleaving", async () => {
		// Every bump is a read-modify-write of one shared record, and the events
		// that trigger them are not awaited by VS Code. Unserialized, the later
		// read would see the earlier value and one increment would vanish.
		const backing = store(undefined, true);
		const counters = new McpVersionCounters(backing);
		await Promise.all([counters.bump("A"), counters.bump("A"), counters.bump("B"), counters.bump("A")]);
		assert.deepStrictEqual(backing.value, { A: 3, B: 1 });
	});

	test("a junk persisted value reads as no rotations, never as a crash", () => {
		for (const junk of [undefined, null, 42, "nope", [], { Main: -1 }, { Main: 1.5 }, { Main: "3" }]) {
			assert.strictEqual(new McpVersionCounters(store(junk)).versionOf("Main"), 0);
		}
		// A well-formed neighbour still survives beside a junk one.
		assert.strictEqual(new McpVersionCounters(store({ Main: 4, Other: "x" })).versionOf("Main"), 4);
	});

	describe("credential rotation detection", () => {
		test("the first sighting is never a rotation, with or without a secret", () => {
			assert.deepStrictEqual(new McpVersionCounters(store()).observeCredentials([entry({ apiKey: "sk-1" })]), []);
			assert.deepStrictEqual(new McpVersionCounters(store()).observeCredentials([entry()]), []);
		});

		test("a changed inline secret rotates; an unchanged one does not", () => {
			const counters = new McpVersionCounters(store());
			counters.observeCredentials([entry({ apiKey: "sk-1" })]);
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-1" })]), []);
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-2" })]), ["Main"]);
		});

		test("GAINING a first inline secret rotates, and so does losing and re-adding one", () => {
			// The regression this guards: with "carries nothing" recorded as
			// absence, a first secret would read as a first sighting and its
			// rotation would go unannounced.
			const counters = new McpVersionCounters(store());
			const step = (declared: DeclaredServer): readonly string[] => counters.observeCredentials([declared]);
			step(entry());
			assert.deepStrictEqual(step(entry({ apiKey: "sk-1" })), ["Main"]);
			assert.deepStrictEqual(step(entry()), ["Main"]);
			assert.deepStrictEqual(step(entry({ apiKey: "sk-1" })), ["Main"]);
		});

		test("moving one value between credential fields counts as the rotation it is", () => {
			const counters = new McpVersionCounters(store());
			counters.observeCredentials([entry({ apiKey: "same-text" })]);
			assert.deepStrictEqual(counters.observeCredentials([entry({ virtualKeyValue: "same-text" })]), ["Main"]);
		});

		test("non-secret fields that shape the sent headers rotate too", () => {
			// What matters is whether the next session authenticates differently,
			// and renaming the header a virtual key rides in does that as surely
			// as rotating its value. Same for the OAuth text and custom headers.
			const cases: Partial<DeclaredServer>[] = [
				{ virtualKeyHeader: "x-other-key" },
				{ oauthTokenUrl: "https://idp2.test/token" },
				{ oauthClientId: "client-2" },
				{ oauthScopes: "read write" },
				{ headers: { "x-routing-env": "staging" } },
			];
			const base: Partial<DeclaredServer> = {
				apiKey: "sk-1",
				virtualKeyHeader: "x-key",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthScopes: "read",
				headers: { "x-routing-env": "prod" },
			};
			for (const change of cases) {
				const counters = new McpVersionCounters(store());
				counters.observeCredentials([entry(base)]);
				assert.deepStrictEqual(
					counters.observeCredentials([entry({ ...base, ...change })]),
					["Main"],
					`${Object.keys(change)[0]} must count as a rotation`
				);
			}
		});

		test("a base URL change rotates: it authorizes the credentials, it does not merely address them", () => {
			// The regression: with a custom mcp.url the published endpoint does not
			// move when baseUrl does, so nothing else would tell the editor that
			// the same-origin verdict and the stored secret's stamped destination
			// both just changed.
			const counters = new McpVersionCounters(store());
			const at = (baseUrl: string): DeclaredServer =>
				entry({ baseUrl, mcp: { url: "https://gw.example/mcp" }, apiKey: "sk-1" });
			counters.observeCredentials([at("http://localhost:4000")]);
			assert.deepStrictEqual(counters.observeCredentials([at("https://elsewhere.example")]), ["Main"]);
		});

		test("a field that changes nothing about the sent headers does not rotate", () => {
			// The digest is wider than "secrets" but not unbounded: a budget edit
			// would churn every published version for nothing.
			const counters = new McpVersionCounters(store());
			counters.observeCredentials([entry({ apiKey: "sk-1", budget: 10 })]);
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-1", budget: 99 })]), []);
		});

		test("only the entries that moved are reported, and every label is tracked apart", () => {
			const counters = new McpVersionCounters(store());
			const pair = (a: string, b: string) => [entry({ label: "A", apiKey: a }), entry({ label: "B", apiKey: b })];
			counters.observeCredentials(pair("sk-a", "sk-b"));
			assert.deepStrictEqual(counters.observeCredentials(pair("sk-a", "sk-b2")), ["B"]);
		});

		test("an undeclared label is forgotten, so its return is a first sighting again", () => {
			// A label that comes back is a new pairing; its stored counter keeps
			// the rotations it already accumulated, but its re-appearance is not
			// itself one.
			const counters = new McpVersionCounters(store());
			counters.observeCredentials([entry({ apiKey: "sk-1" })]);
			assert.deepStrictEqual(counters.observeCredentials([]), []);
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-9" })]), []);
		});

		test("a rotation is reported exactly once: the observed digest commits at observation", () => {
			const counters = new McpVersionCounters(store());
			counters.observeCredentials([entry({ apiKey: "sk-1" })]);
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-2" })]), ["Main"]);
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-2" })]), []);
		});

		test("a failed counter write leaves the old counter, and the next rotation still bumps observably", async () => {
			// The write can fail (globalState). Nothing retries it, deliberately:
			// the version is an opaque change token, so the worst case is the
			// editor serving the previous cached credential until the next
			// rotation moves the counter anyway - which this pins.
			const backing = store();
			let failNext = true;
			const write = backing.update.bind(backing);
			backing.update = async (key: string, value: unknown): Promise<void> => {
				if (failNext) {
					failNext = false;
					throw new Error("write failed");
				}
				await write(key, value);
			};
			const counters = new McpVersionCounters(backing);
			counters.observeCredentials([entry({ apiKey: "sk-1" })]);
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-2" })]), ["Main"]);
			await assert.rejects(counters.bump("Main"));
			// The old counter survives the failed write untouched.
			assert.strictEqual(counters.versionOf("Main"), 0);
			assert.strictEqual(backing.value, undefined);
			// The next rotation is still detected, and its write bumps observably.
			assert.deepStrictEqual(counters.observeCredentials([entry({ apiKey: "sk-3" })]), ["Main"]);
			await counters.bump("Main");
			assert.strictEqual(counters.versionOf("Main"), 1);
			assert.deepStrictEqual(backing.value, { Main: 1 });
		});

		test("detection persists nothing: only the caller's bump writes", () => {
			const backing = store();
			const counters = new McpVersionCounters(backing);
			counters.observeCredentials([entry({ apiKey: "sk-1" })]);
			counters.observeCredentials([entry({ apiKey: "sk-2" })]);
			assert.strictEqual(backing.value, undefined);
		});

		test("no secret material reaches the persisted counters", async () => {
			const backing = store();
			const counters = new McpVersionCounters(backing);
			counters.observeCredentials([entry({ apiKey: "sk-super-secret" })]);
			counters.observeCredentials([entry({ apiKey: "sk-also-secret" })]);
			await counters.bump("Main");
			expect(JSON.stringify(backing.value)).not.toContain("secret");
			assert.deepStrictEqual(backing.value, { Main: 1 });
		});
	});
});
