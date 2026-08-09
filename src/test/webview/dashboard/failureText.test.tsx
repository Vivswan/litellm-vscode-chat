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
import { App } from "../../../webview/dashboard/app";
import { DiagnosticsSection } from "../../../webview/dashboard/diagnostics";
import { FailureText } from "../../../webview/dashboard/failureText";
import { ServersSection } from "../../../webview/dashboard/servers";
import { makeDeclaredServer, makeState, statePush } from "../fixtures";
import { cleanup, mount, pushToWebview, resetPosted, textOf } from "../harness";

beforeEach(resetPosted);
afterEach(cleanup);

const noop = () => {};

function mountServers(servers: readonly ReturnType<typeof makeDeclaredServer>[]) {
	return mount(
		<ServersSection
			servers={servers}
			now={Date.now()}
			ack={undefined}
			failures={{}}
			inlineSecrets={undefined}
			onDismissFailure={noop}
			onClearInlineSecrets={noop}
		/>
	);
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
		type: "intentFailed",
		intentType: "setNumberSetting",
		message: "The value was rejected.\nchat.timeout: must be a positive integer",
		kind: "validation",
	});
	const line = root.querySelector("p.error");
	expect(line?.textContent).toContain("The last change did not apply: The value was rejected.");
	expect(textOf(root, "p.error .failure-detail")).toBe("chat.timeout: must be a positive integer");
});

test("a setUsageAlertThresholds failure reaches the scalar-failure surface", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	pushToWebview({
		type: "intentFailed",
		intentType: "setUsageAlertThresholds",
		message: "Thresholds were not saved.",
		kind: "validation",
	});
	expect(root.querySelector("p.error")?.textContent).toContain(
		"The last change did not apply: Thresholds were not saved."
	);
});

test("a two-part server failure banner renders the framed headline plus a detail line", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState({ servers: [makeDeclaredServer()] })));
	pushToWebview({
		type: "intentFailed",
		intentType: "saveServerSetting",
		message: "The entry could not be written.\nsettings.json is read-only",
		kind: "validation",
	});
	const banner = root.querySelector(".banner-error");
	expect(banner?.textContent).toContain("Saving the server failed: The entry could not be written.");
	expect(banner?.querySelector(".failure-detail")?.textContent).toBe("settings.json is read-only");
});

test("mixed error banner: a two-part entry keeps its detail as a block, and the next entry gets no dangling separator", () => {
	const root = mountServers([
		makeDeclaredServer({
			label: "Prod",
			state: "error",
			error: "The server could not be reached.\nGET http://prod.test/v1/models: ETIMEDOUT",
		}),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", error: "bang" }),
	]);
	const banner = root.querySelector(".banner-error p.error");
	expect(banner?.textContent).toContain("Prod: The server could not be reached.");
	expect(banner?.querySelector(".failure-detail")?.textContent).toBe("GET http://prod.test/v1/models: ETIMEDOUT");
	// The block detail already breaks the line; a leading "; " on the next
	// entry would dangle at the start of its line.
	expect(banner?.textContent).not.toContain("; Beta");
	expect(banner?.textContent).toContain("Beta: bang");
	// Single-line neighbors keep the joined shape.
	cleanup();
	const joined = mountServers([
		makeDeclaredServer({ label: "Prod", state: "error", error: "boom" }),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", error: "bang" }),
	]);
	expect(joined.querySelector(".banner-error p.error")?.innerHTML).toBe("Prod: boom; Beta: bang");
});

test("mixed expected banner: the (expected) frame carries the headline, the detail rides beneath", () => {
	const root = mountServers([
		makeDeclaredServer({
			label: "Alpha",
			state: "error",
			error: "Discovery is declared unavailable.\nGET http://alpha.test/v1/models: 404",
			expected: true,
		}),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", error: "quiet", expected: true }),
	]);
	const banner = root.querySelector(".banner-warn p.state-warn");
	expect(banner?.textContent).toContain("Alpha: Discovery is declared unavailable. (expected)");
	expect(banner?.querySelector(".failure-detail")?.textContent).toBe("GET http://alpha.test/v1/models: 404");
	expect(banner?.textContent).not.toContain("; Beta");
	expect(banner?.textContent).toContain("Beta: quiet (expected)");
});

test("the diagnostics grid splits a two-part server error instead of collapsing it", () => {
	const root = mount(
		<DiagnosticsSection
			servers={[
				makeDeclaredServer({
					label: "Gateway",
					state: "error",
					error: "The server could not be reached.\nGET http://gw.test/v1/models: ECONNREFUSED",
				}),
			]}
			modelCount={0}
			legacyServerCount={0}
			diagnostics={[]}
			resolvedResponse={undefined}
			active={false}
			stateSeq={0}
			onInspect={() => undefined}
			now={Date.now()}
		/>
	);
	const note = root.querySelector("tr.diag-note td");
	expect(note?.textContent).toContain("The server could not be reached.");
	expect(note?.querySelector(".failure-detail")?.textContent).toBe("GET http://gw.test/v1/models: ECONNREFUSED");
});
