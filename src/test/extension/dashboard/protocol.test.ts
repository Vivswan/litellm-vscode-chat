import * as assert from "node:assert";
import type { DashboardServer } from "../../../extension/dashboard/protocol";
import {
	classifyOverall,
	latestCheckedMs,
	overallStatusText,
	serverOutcomeParts,
	serverOutcomeText,
} from "../../../extension/dashboard/protocol";

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

suite("extension/dashboard/protocol renderers", () => {
	suite("overallStatusText", () => {
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
				"Expected discovery failures; no declared models (add _declare entries to modelCapabilities)"
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

	suite("serverOutcomeText", () => {
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
			assert.ok(line.includes("add _declare entries"), line);
		});

		test("an entry whose group cannot serve its per-entry parameters says so on a healthy line", () => {
			// The row is healthy, which is exactly why the line must call the
			// inactive parameters out: this is what users collect into reports.
			const line = serverOutcomeText(declaredServer({ modelCount: 2, notices: ["entry-params-inactive"] }));
			assert.ok(line.startsWith("OK (2 models) - per-entry modelParameters are not applied"), line);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("the capabilities twin of the params-inactive line names its own fields", () => {
			const line = serverOutcomeText(declaredServer({ modelCount: 2, notices: ["entry-capabilities-inactive"] }));
			assert.ok(
				line.startsWith("OK (2 models) - per-entry modelCapabilities and expectedFailures are not applied"),
				line
			);
			assert.ok(line.includes("run Sync Models Now"), line);
		});

		test("a row carrying both inactive notices lists them both, params first", () => {
			const line = serverOutcomeText(
				declaredServer({ modelCount: 2, notices: ["entry-params-inactive", "entry-capabilities-inactive"] })
			);
			assert.ok(line.includes("per-entry modelParameters are not applied"), line);
			assert.ok(line.includes("per-entry modelCapabilities and expectedFailures are not applied"), line);
			assert.ok(
				line.indexOf("modelParameters are not applied") < line.indexOf("modelCapabilities and expectedFailures"),
				line
			);
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
			];
			for (const server of cases) {
				const parts = serverOutcomeParts(server);
				const status = parts.models === undefined ? parts.status : `${parts.status} (${parts.models})`;
				const error = parts.error === undefined ? "" : parts.status === "OK" ? ` - ${parts.error}` : `: ${parts.error}`;
				const notice = parts.notice.map((text) => ` - ${text}`).join("");
				assert.strictEqual(serverOutcomeText(server), `${status}${error}${notice}`);
			}
		});
	});

	suite("latestCheckedMs", () => {
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
});
