/**
 * Behavioral suite for the two correlation hooks. The suites around this one
 * exercise them through components; this one pins the correlation semantics
 * themselves - latest-wins orphaning, reset, instance independence, and the
 * ack/fail outcome lifecycle - because a settled request renders the same
 * pixels whether or not a stale answer was ever mis-attached, so only these
 * assertions can see a correlation bug. Every assertion reads state between
 * act() boundaries, so batching cannot hide the intermediate it pins.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { IntentOutcomeState, RpcState } from "../../../../webview/dashboard/hooks";
import { useIntentOutcome, useRpc } from "../../../../webview/dashboard/hooks";
import { makeState, statePush } from "../fixtures";
import { cleanup, mount, postedRequests, pushToWebview, resetPosted, respondTo } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

/** Exposes one useRpc instance; the holder always carries the latest render's state. */
function RpcProbe({ holder }: { holder: { current?: RpcState<"searchCatalog"> } }) {
	const rpc = useRpc("searchCatalog");
	holder.current = rpc;
	return <output>{rpc.data === undefined ? "loading" : rpc.data.results.map((entry) => entry.id).join(",")}</output>;
}

function IntentProbe({ holder }: { holder: { current?: IntentOutcomeState<"hideExternalServer"> } }) {
	const intent = useIntentOutcome("hideExternalServer");
	holder.current = intent;
	return <output>{intent.outcome === undefined ? "none" : `${intent.outcome.result}#${intent.outcome.seq}`}</output>;
}

const send = (holder: { current?: RpcState<"searchCatalog"> }, query: string) => {
	void act(() => {
		holder.current?.send({ query });
	});
};

test("useRpc latest-wins: a rapid re-request orphans the in-flight answer, and only the newest id lands", () => {
	const holder: { current?: RpcState<"searchCatalog"> } = {};
	const root = mount(<RpcProbe holder={holder} />);
	const output = () => root.querySelector("output")?.textContent;

	send(holder, "first");
	send(holder, "second");
	const [first, second] = postedRequests("searchCatalog");
	if (first === undefined || second === undefined) {
		throw new Error("both sends must post");
	}
	expect(first.id).not.toBe(second.id);

	// The orphaned answer must not land: the view stays loading.
	respondTo(first, { results: [{ id: "stale/model", name: "Stale" }] });
	expect(output()).toBe("loading");
	expect(holder.current?.data).toBeUndefined();

	// The newest id lands; a late duplicate of the old one still cannot overwrite it.
	respondTo(second, { results: [{ id: "fresh/model", name: "Fresh" }] });
	expect(output()).toBe("fresh/model");
	respondTo(first, { results: [{ id: "stale/model", name: "Stale" }] });
	expect(output()).toBe("fresh/model");
});

test("useRpc reset drops the held answer and orphans the in-flight request", () => {
	const holder: { current?: RpcState<"searchCatalog"> } = {};
	const root = mount(<RpcProbe holder={holder} />);

	send(holder, "query");
	const request = postedRequests("searchCatalog")[0];
	if (request === undefined) {
		throw new Error("the send must post");
	}
	void act(() => {
		holder.current?.reset();
	});
	respondTo(request, { results: [{ id: "late/model", name: "Late" }] });
	expect(root.querySelector("output")?.textContent).toBe("loading");
	expect(holder.current?.data).toBeUndefined();
});

test("two useRpc instances of the same method are independent: each answer lands only on its own hook", () => {
	const one: { current?: RpcState<"searchCatalog"> } = {};
	const two: { current?: RpcState<"searchCatalog"> } = {};
	const rootOne = mount(<RpcProbe holder={one} />);
	const rootTwo = mount(<RpcProbe holder={two} />);

	send(one, "alpha");
	send(two, "beta");
	const [alpha, beta] = postedRequests("searchCatalog");
	if (alpha === undefined || beta === undefined) {
		throw new Error("both probes must post");
	}

	// Answering the second leaves the first in flight.
	respondTo(beta, { results: [{ id: "beta/model", name: "Beta" }] });
	expect(rootOne.querySelector("output")?.textContent).toBe("loading");
	expect(rootTwo.querySelector("output")?.textContent).toBe("beta/model");

	respondTo(alpha, { results: [{ id: "alpha/model", name: "Alpha" }] });
	expect(rootOne.querySelector("output")?.textContent).toBe("alpha/model");
	expect(rootTwo.querySelector("output")?.textContent).toBe("beta/model");
});

test("useIntentOutcome carries the latest ack or fail of its method, re-firing repeats through seq", () => {
	const holder: { current?: IntentOutcomeState<"hideExternalServer"> } = {};
	mount(<IntentProbe holder={holder} />);

	let id = "";
	void act(() => {
		id = holder.current?.send({ baseUrl: "http://a.test", sourceHandle: "handle-a" }) ?? "";
	});
	expect(id).not.toBe("");

	pushToWebview({ kind: "ack", id, method: "hideExternalServer" });
	expect(holder.current?.outcome).toMatchObject({ id, result: "ok" });
	const firstSeq = holder.current?.outcome?.seq;

	// An identical repeat still bumps seq, so equal-text outcomes re-fire effects.
	pushToWebview({ kind: "ack", id, method: "hideExternalServer" });
	expect(holder.current?.outcome?.seq).not.toBe(firstSeq);

	// The hook reports its METHOD's outcomes whoever posted them; consumers correlate by id.
	pushToWebview({
		kind: "fail",
		id: "someone-elses-request",
		method: "hideExternalServer",
		message: "the group vanished",
		failureKind: "operation",
	});
	expect(holder.current?.outcome).toMatchObject({
		id: "someone-elses-request",
		result: "fail",
		message: "the group vanished",
		failureKind: "operation",
	});

	// Another method's notices never land here.
	pushToWebview({ kind: "ack", id, method: "unhideServer" });
	expect(holder.current?.outcome?.result).toBe("fail");
});

test("useIntentOutcome outcomes survive state pushes and retire only through reset", () => {
	const holder: { current?: IntentOutcomeState<"hideExternalServer"> } = {};
	const root = mount(<IntentProbe holder={holder} />);

	let id = "";
	void act(() => {
		id = holder.current?.send({ baseUrl: "http://a.test", sourceHandle: "handle-a" }) ?? "";
	});
	pushToWebview({ kind: "ack", id, method: "hideExternalServer" });
	expect(holder.current?.outcome).toMatchObject({ id, result: "ok" });

	pushToWebview(statePush(makeState()));
	expect(holder.current?.outcome).toMatchObject({ id, result: "ok" });

	void act(() => {
		holder.current?.reset();
	});
	expect(holder.current?.outcome).toBeUndefined();
	expect(root.querySelector("output")?.textContent).toBe("none");
});
