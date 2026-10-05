import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../../webview/dashboard/app";
import { FailureText } from "../../../../webview/dashboard/failureText";
import { ServersSection } from "../../../../webview/dashboard/servers";
import { CAUSE, makeDeclaredServer, makeState, statePush } from "../fixtures";
import { cleanup, mount, pushToWebview, resetPosted, textOf } from "../harness";

beforeEach(resetPosted);
afterEach(cleanup);

function mountServers(servers: readonly ReturnType<typeof makeDeclaredServer>[]) {
	return mount(
		<ServersSection
			currencySymbol="$"
			servers={servers}
			now={Date.now()}
			onEditServer={() => {}}
			onAdoptServer={() => {}}
			onAddServer={() => {}}
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

test("a row's failure renders from its cause as one line: no detail half, no separator", () => {
	// The rows carry a cause key (never text), rendered here in the webview's locale; the one-line rendering has no
	// dimmed detail line to own.
	const root = mountServers([
		makeDeclaredServer({ label: "Prod", state: "error", cause: CAUSE.connection }),
		makeDeclaredServer({ label: "Beta", baseUrl: "http://beta.test", state: "error", cause: CAUSE.http500 }),
	]);
	const lines = [...root.querySelectorAll(".row-diagnostic")];
	expect(lines.length).toBe(2);
	expect(lines[0]?.querySelector(".row-diagnostic-headline")?.textContent).toContain(
		"Could not connect to http://localhost:4000"
	);
	expect(lines[0]?.querySelector(".row-diagnostic-detail")).toBeNull();
	// Each row owns its line, so there are no separators left to dangle.
	expect(root.textContent).not.toContain("; Beta");
	expect(lines[1]?.textContent).toContain("The server at http://beta.test answered 500");
	expect(lines[1]?.querySelector(".row-diagnostic-detail")).toBeNull();
});
