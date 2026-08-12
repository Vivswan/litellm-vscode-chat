import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { CapabilityJsonValue, CapabilityValueKind, DashboardServer } from "../../../dashboard/protocol";
import {
	CAPABILITY_FIELDS,
	CONSUMED_CAPABILITY_FIELDS,
	capabilityField,
	classifyOverall,
	latestCheckedMs,
	overallStatusText,
	serverOutcomeParts,
	serverOutcomeText,
} from "../../../dashboard/protocol";

/**
 * Wording pins for the shared diagnostics renderers. These lines are what
 * users copy out of the Diagnostics tab into issue reports (the Show
 * Diagnostics dialog used to render the same functions), so the exact text
 * is pinned here once instead of per surface.
 */

type DeclaredServer = Extract<DashboardServer, { origin: "declared" }>;

function declaredServer(overrides: Partial<DeclaredServer> = {}): DashboardServer {
	const base: DeclaredServer = {
		origin: "declared",
		label: "Prod",
		baseUrl: "http://prod.test",
		modelCount: 0,
		hasApiKey: false,
		hasOAuth: false,
		state: "ok",
		config: { secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } },
	};
	return { ...base, ...overrides } as DeclaredServer;
}

function misconfiguredServer(problems: readonly string[]): DashboardServer {
	return {
		origin: "misconfigured",
		label: "Broken",
		baseUrl: "http://broken.test",
		modelCount: 0,
		hasApiKey: false,
		hasOAuth: false,
		state: "error",
		problems,
		error: "misconfigured entry; not used until its configuration is fixed",
		errorEnglish: "misconfigured entry; not used until its configuration is fixed",
	};
}

describe("dashboard/protocol renderers", () => {
	describe("overallStatusText", () => {
		test("nothing configured anywhere reads as not configured", () => {
			assert.strictEqual(overallStatusText([], 0), "Not configured");
		});

		test("a legacy-only registry names the registry instead of a not-configured claim", () => {
			assert.strictEqual(overallStatusText([], 0, 1), "Legacy registry only (1 server)");
			assert.strictEqual(overallStatusText([], 0, 2), "Legacy registry only (2 servers)");
		});

		test("legacy leftovers never override a configured verdict", () => {
			const servers = [declaredServer({ state: "ok", modelCount: 3 })];
			assert.strictEqual(overallStatusText(servers, 3, 2), "Connected (3 models)");
		});

		test("every server reachable reads as connected with the model count", () => {
			const servers = [declaredServer({ modelCount: 4 }), declaredServer({ label: "Backup", modelCount: 2 })];
			assert.strictEqual(overallStatusText(servers, 6), "Connected (6 models)");
		});

		test("one failing server among reachable ones reads as degraded", () => {
			const servers = [
				declaredServer({ modelCount: 4 }),
				declaredServer({ label: "Backup", state: "error", error: "connection refused" }),
			];
			assert.strictEqual(overallStatusText(servers, 4), "Degraded (4 models, some servers failed)");
		});

		test("every server failing surfaces the first error as the status", () => {
			const servers = [
				declaredServer({ state: "error", error: "connection refused" }),
				declaredServer({ label: "Backup", state: "error", error: "timeout" }),
			];
			assert.strictEqual(overallStatusText(servers, 0), "Error: connection refused");
		});

		test("declared entries no discovery pass has seen read as waiting, never as a failure", () => {
			const servers = [declaredServer({ state: "unchecked" })];
			assert.strictEqual(classifyOverall(servers), "waiting");
			assert.strictEqual(overallStatusText(servers, 0), "Waiting for first sync");
		});

		test("expected failures never count as failures: declared models read as connected", () => {
			const servers = [
				declaredServer({ modelCount: 4 }),
				declaredServer({
					label: "Gateway",
					state: "error",
					error: "404 on /models",
					expected: true,
					declaredModelCount: 2,
				}),
			];
			assert.strictEqual(classifyOverall(servers), "connected");
			assert.strictEqual(overallStatusText(servers, 6), "Connected (6 models)");
		});

		test("all-expected failures with nothing declared read as the neutral needs-declare verdict", () => {
			const servers = [declaredServer({ state: "error", error: "404 on /models", expected: true })];
			assert.strictEqual(classifyOverall(servers), "needs-declare");
			assert.strictEqual(
				overallStatusText(servers, 0),
				"Expected discovery failures; no declared models (add IDs to the entry's discovery.declared)"
			);
		});

		test("a misconfigured entry beside a healthy server stays neutral: connected, not degraded", () => {
			// The status bar cannot see misconfigured entries (they never reach the
			// host), so counting them here would split the headline from the bar;
			// their signal is the Misconfigured pill and Configuration diagnostics.
			const servers = [misconfiguredServer(["auth must pick one form"]), declaredServer({ modelCount: 3 })];
			assert.strictEqual(classifyOverall(servers), "connected");
			assert.strictEqual(overallStatusText(servers, 3), "Connected (3 models)");
		});

		test("with every real server down, the headline names the transport failure, not the misconfigured row", () => {
			// Rows sort by label ("Broken" first); the real outage is the line
			// worth pasting into an issue report.
			const servers = [
				misconfiguredServer(["auth must pick one form"]),
				declaredServer({ state: "error", error: "connection refused" }),
			];
			assert.strictEqual(classifyOverall(servers), "error");
			assert.strictEqual(overallStatusText(servers, 0), "Error: connection refused");
		});

		test("a configuration of only misconfigured entries is an error, never waiting", () => {
			const servers = [misconfiguredServer(["auth must pick one form"])];
			assert.strictEqual(classifyOverall(servers), "error");
			assert.strictEqual(
				overallStatusText(servers, 0),
				"Error: misconfigured entry; not used until its configuration is fixed"
			);
		});

		test("an unexpected failure beside an expected one still degrades, not errors", () => {
			const servers = [
				declaredServer({ state: "error", error: "refused" }),
				declaredServer({
					label: "Gateway",
					state: "error",
					error: "404 on /models",
					expected: true,
					declaredModelCount: 1,
				}),
			];
			assert.strictEqual(classifyOverall(servers), "degraded");
		});
	});

	describe("serverOutcomeText", () => {
		test("a reachable server reads OK with its model count", () => {
			assert.strictEqual(serverOutcomeText(declaredServer({ modelCount: 3 })), "OK (3 models)");
		});

		test("a reachable server whose sync failed shows both the models and the sync error", () => {
			const server = declaredServer({ modelCount: 2, error: "upsert refused" });
			assert.strictEqual(serverOutcomeText(server), "OK (2 models) - upsert refused");
		});

		test("a failing server reads its error", () => {
			const server = declaredServer({ state: "error", error: "connection refused" });
			assert.strictEqual(serverOutcomeText(server), "Error: connection refused");
		});

		test("an unchecked entry reads not checked yet", () => {
			assert.strictEqual(serverOutcomeText(declaredServer({ state: "unchecked" })), "Not checked yet");
		});

		test("a two-part error flattens to one physical line in the paste form", () => {
			// The grid renders headline and detail as separate lines; the copied
			// issue-report line must stay one physical line per server.
			const server = declaredServer({
				state: "error",
				error: "The server refused this request.\nLiteLLM 403: blocked by policy",
			});
			assert.strictEqual(
				serverOutcomeText(server),
				"Error: The server refused this request. - LiteLLM 403: blocked by policy"
			);
			assert.strictEqual(
				serverOutcomeParts(server).error,
				"The server refused this request.\nLiteLLM 403: blocked by policy"
			);
		});

		test("an expected failure with declared models reads as OK, annotated (expected)", () => {
			const server = declaredServer({
				state: "error",
				error: "404 on /models",
				expected: true,
				declaredModelCount: 2,
			});
			assert.strictEqual(serverOutcomeText(server), "OK (2 declared models) - 404 on /models (expected)");
			assert.strictEqual(
				serverOutcomeText(declaredServer({ state: "error", error: "x", expected: true, declaredModelCount: 1 })),
				"OK (1 declared model) - x (expected)"
			);
		});

		test("an expected two-part error carries its (expected) annotation on the headline", () => {
			const server = declaredServer({
				state: "error",
				error: "Discovery is declared unavailable.\nHTTP 404: not found",
				expected: true,
				declaredModelCount: 2,
			});
			assert.strictEqual(
				serverOutcomeParts(server).error,
				"Discovery is declared unavailable. (expected)\nHTTP 404: not found"
			);
			assert.strictEqual(
				serverOutcomeText(server),
				"OK (2 declared models) - Discovery is declared unavailable. (expected) - HTTP 404: not found"
			);
		});

		test("an expected failure with nothing declared stays an annotated error line", () => {
			const line = serverOutcomeText(
				declaredServer({
					state: "error",
					error: "404 on /models",
					expected: true,
					notices: ["expected-failures-nothing-declared"],
				})
			);
			assert.ok(line.startsWith("Error: 404 on /models (expected)"), line);
			assert.ok(line.includes("discovery.declared"), line);
		});

		test("an entry whose group cannot serve its per-entry parameters says so on a healthy line", () => {
			// The row is healthy, which is exactly why the line must call the
			// inactive parameters out: this is what users collect into reports.
			const line = serverOutcomeText(declaredServer({ modelCount: 2, notices: ["entry-params-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - per-entry modelParameters are not applied"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("an entry whose group cannot serve its apiVersion override says so on a healthy line", () => {
			// Same policy as the params notice: healthy row, English diagnostics
			// prose, and the line must say requests fell back to the auto rule.
			const line = serverOutcomeText(declaredServer({ modelCount: 2, notices: ["entry-api-version-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - the per-entry API version override is not applied"), line);
			assert.ok(line.includes("requests use the auto rule"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the capabilities twin of the params-inactive line names its own fields", () => {
			const line = serverOutcomeText(declaredServer({ modelCount: 2, notices: ["entry-capabilities-inactive"] }));
			assert.ok(
				line.startsWith(
					"OK (2 models) - per-entry modelCapabilities, declared models, and expectedFailures are not applied"
				),
				line
			);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("a row carrying both inactive notices lists them both, params first", () => {
			const line = serverOutcomeText(
				declaredServer({ modelCount: 2, notices: ["entry-params-inactive", "entry-capabilities-inactive"] })
			);
			assert.ok(line.includes("per-entry modelParameters are not applied"), line);
			assert.ok(
				line.includes("per-entry modelCapabilities, declared models, and expectedFailures are not applied"),
				line
			);
			assert.ok(
				line.indexOf("modelParameters are not applied") <
					line.indexOf("modelCapabilities, declared models, and expectedFailures"),
				line
			);
		});

		test("a misconfigured row short-circuits to its status with the parser's reports as the error", () => {
			const server = misconfiguredServer(["auth must pick one form", "unknown field ignored"]);
			assert.deepStrictEqual(serverOutcomeParts(server), {
				status: "Misconfigured",
				error: "auth must pick one form; unknown field ignored",
				notice: [],
			});
			assert.strictEqual(serverOutcomeText(server), "Misconfigured: auth must pick one form; unknown field ignored");
		});

		test("the one-line form is exactly the composition of serverOutcomeParts", () => {
			// The Diagnostics grid renders the decomposed parts; the pinned line
			// is what lands in issue reports. Re-deriving one from the other here
			// means neither surface can drift in wording.
			const cases: DashboardServer[] = [
				declaredServer({ modelCount: 3 }),
				declaredServer({ modelCount: 2, error: "upsert refused" }),
				declaredServer({ state: "error", error: "connection refused" }),
				declaredServer({ state: "unchecked" }),
				declaredServer({ modelCount: 2, notices: ["entry-params-inactive"] }),
				declaredServer({ modelCount: 2, error: "upsert refused", notices: ["entry-params-inactive"] }),
				declaredServer({ state: "error", error: "connection refused", notices: ["entry-params-inactive"] }),
				declaredServer({ state: "unchecked", notices: ["entry-params-inactive"] }),
				declaredServer({ modelCount: 2, notices: ["entry-params-inactive", "entry-capabilities-inactive"] }),
				declaredServer({ state: "error", error: "404", expected: true, declaredModelCount: 2 }),
				declaredServer({
					state: "error",
					error: "404",
					expected: true,
					notices: ["expected-failures-nothing-declared"],
				}),
				declaredServer({ state: "error", error: "headline\nLiteLLM 403: detail line" }),
				declaredServer({ modelCount: 2, error: "headline\nHTTP 502: upsert detail" }),
				declaredServer({
					state: "error",
					error: "headline\nHTTP 404: detail line",
					expected: true,
					declaredModelCount: 2,
				}),
			];
			for (const server of cases) {
				const parts = serverOutcomeParts(server);
				const status = parts.models === undefined ? parts.status : `${parts.status} (${parts.models})`;
				// The one-line form flattens a two-part error's newline to " - ";
				// the grid renders parts.error two-part on purpose.
				const flat = parts.error
					?.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
					.join(" - ");
				const error = flat === undefined ? "" : parts.status === "OK" ? ` - ${flat}` : `: ${flat}`;
				const notice = parts.notice.map((text) => ` - ${text}`).join("");
				assert.strictEqual(serverOutcomeText(server), `${status}${error}${notice}`);
			}
		});
	});

	describe("latestCheckedMs", () => {
		test("undefined while nothing was checked; otherwise the most recent timestamp", () => {
			assert.strictEqual(latestCheckedMs([]), undefined);
			assert.strictEqual(latestCheckedMs([{ lastChecked: undefined }]), undefined);
			const older = "2026-07-26T01:02:03.000Z";
			const newer = "2026-07-27T05:06:07.000Z";
			assert.strictEqual(
				latestCheckedMs([{ lastChecked: older }, { lastChecked: undefined }, { lastChecked: newer }]),
				new Date(newer).getTime()
			);
		});

		test("unparseable timestamps are ignored instead of poisoning the maximum", () => {
			assert.strictEqual(latestCheckedMs([{ lastChecked: "not a date" }]), undefined);
		});
	});

	describe("capability vocabulary re-exports", () => {
		test("the consumed vocabulary rides the protocol module and contains the registration-typed core", () => {
			// The webview may import only the src/dashboard tree; the record editors key
			// their inputs and validation hints off these constants.
			for (const name of Object.keys(CAPABILITY_FIELDS)) {
				assert.ok(Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, name), `core field ${name} must be consumed`);
			}
			const costKind: CapabilityValueKind | undefined = CONSUMED_CAPABILITY_FIELDS.input_cost_per_token;
			assert.strictEqual(costKind, "cost");
		});

		test("capabilityField reads own properties only, so prototype-named open fields cannot leak members", () => {
			const bag: Readonly<Record<string, CapabilityJsonValue | undefined>> = { toString: "own" };
			assert.strictEqual(capabilityField(bag, "toString"), "own");
			assert.strictEqual(capabilityField(bag, "constructor"), undefined);
			assert.strictEqual(capabilityField(bag, "__proto__"), undefined);
		});
	});
});
