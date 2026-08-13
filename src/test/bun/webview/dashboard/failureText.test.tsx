/**
 * The two-part failure rendering seam: redesigned error messages arrive as
 * "headline\ndetail", and nothing in the webview styles newlines, so the raw
 * string would collapse into one run-on paragraph. FailureText splits the
 * parts with the same shared extraction the host notifier uses; these tests
 * pin the split at the component and at the surfaces that render host
 * failure text (the scalar-failure line, the server banners, the diagnostics
 * grid) - plus the setUsageAlertThresholds wiring, whose failures previously
 * reached no component at all.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../../webview/dashboard/app";
import { FailureText } from "../../../../webview/dashboard/failureText";
import { ServersSection } from "../../../../webview/dashboard/servers";
import { makeDeclaredServer, makeState, statePush } from "../fixtures";
import { cleanup, mount, pushToWebview, resetPosted, textOf } from "../harness";

beforeEach(resetPosted);
afterEach(cleanup);

function mountServers(servers: readonly ReturnType<typeof makeDeclaredServer>[]) {
	return mount(<ServersSection servers={servers} now={Date.now()} />);
}

test("FailureText renders headline and detail as separate elements; single-part messages get no detail", () => {
	const twoPart = mount(
		<p>
			<FailureText message={"The server could not be reached.\nGET http://x.test/v1/models: ETIMEDOUT"} />
		</p>
	);
	expect(twoPart.textContent).toContain("The server could not be reached.");
	expect(textOf(twoPart, ".failure-detail")).toBe("GET http://x.test/v1/models: ETIMEDOUT");
	cleanup();
	const single = mount(
		<p>
			<FailureText message="one line" frame={(headline) => `framed: ${headline}`} />
		</p>
	);
	expect(single.textContent).toBe("framed: one line");
	expect(single.querySelector(".failure-detail")).toBeNull();
});

test("a two-part scalar-setting failure keeps the headline in the sentence and the detail on its own line", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({
		kind: "fail",
		id: "req-1",
		method: "setNumberSetting",
		message: "The value was rejected.\nchat.timeout: must be a positive integer",
		failureKind: "validation",
	});
	const line = root.querySelector("p.error");
	expect(line?.textContent).toContain("The last change did not apply: The value was rejected.");
	expect(textOf(root, "p.error .failure-detail")).toBe("chat.timeout: must be a positive integer");
});

test("a setUsageAlertThresholds failure reaches the scalar-failure surface", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({
		kind: "fail",
		id: "req-1",
		method: "setUsageAlertThresholds",
		message: "Thresholds were not saved.",
		failureKind: "validation",
	});
	expect(root.querySelector("p.error")?.textContent).toContain(
		"The last change did not apply: Thresholds were not saved."
	);
});

test("a two-part server failure banner renders the framed headline plus a detail line", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	pushToWebview({
		kind: "fail",
		id: "req-1",
		method: "saveServerSetting",
		message: "The entry could not be written.\nsettings.json is read-only",
		failureKind: "validation",
	});
	const banner = root.querySelector(".banner-error");
	expect(banner?.textContent).toContain("Saving the server failed: The entry could not be written.");
	expect(banner?.querySelector(".failure-detail")?.textContent).toBe("settings.json is read-only");
});

test("a two-part error keeps its technical half on its own line, under its own row", () => {
	const root = mountServers([
		makeDeclaredServer({
			label: "Prod",
			state: "error",
			error: "The server could not be reached.\nGET http://prod.test/v1/models: ETIMEDOUT",
		}),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", error: "bang" }),
	]);
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(2);
	// The readable half leads; the wire detail sits beneath it, dimmed, still
	// selectable for an issue report.
	expect(lines[0]?.querySelector(".row-diagnostic-headline")?.textContent).toContain(
		"The server could not be reached."
	);
	expect(lines[0]?.querySelector(".row-diagnostic-detail")?.textContent).toBe(
		"GET http://prod.test/v1/models: ETIMEDOUT"
	);
	// There are no separators left to dangle: each row owns its line, which is
	// the whole reason the joined banner went away.
	expect(root.textContent).not.toContain("; Beta");
	expect(lines[1]?.textContent).toContain("bang");
	// A one-part error grows no empty detail line.
	expect(lines[1]?.querySelector(".row-diagnostic-detail")).toBeNull();
});

test("an expected two-part failure keeps its detail beneath its own headline", () => {
	const root = mountServers([
		makeDeclaredServer({
			label: "Alpha",
			state: "error",
			error: "Discovery is declared unavailable.\nGET http://alpha.test/v1/models: 404",
			expected: true,
		}),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", error: "quiet", expected: true }),
	]);
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(2);
	// An expected failure still says what the server said - the reader who
	// configured this months ago should not have to remember why.
	expect(lines[0]?.textContent).toContain("Discovery is declared unavailable.");
	expect(lines[0]?.querySelector(".row-diagnostic-detail")?.textContent).toBe("GET http://alpha.test/v1/models: 404");
	expect(root.textContent).not.toContain("; Beta");
	expect(lines[1]?.textContent).toContain("quiet");
});
