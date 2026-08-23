import { describe, expect, test } from "bun:test";
import {
	handleParticipantTurn,
	type ParticipantDeps,
	type ParticipantRequest,
} from "../../../../../extension/features/participant/handler";
import type { ChatMessage } from "../../../../../extension/features/participant/historyConversion";
import type { ProviderSnapshot } from "../../../../../extension/features/participant/modelsMarkdown";
import {
	createSlashCommandRegistry,
	TESTS_INSTRUCTION,
} from "../../../../../extension/features/participant/slashCommands";

const SNAPSHOTS: ProviderSnapshot[] = [{ label: "alpha", models: [{ id: "gpt-test", capabilities: "tools" }] }];

/** Deps around a recording stream and a scripted model. */
function fakeDeps(
	fragments: () => AsyncIterable<string>,
	overrides: Partial<ParticipantDeps> = {}
): {
	deps: ParticipantDeps;
	reported: string[];
	requests: (readonly ChatMessage[])[];
} {
	const reported: string[] = [];
	const requests: (readonly ChatMessage[])[] = [];
	return {
		reported,
		requests,
		deps: {
			sendRequest: (messages) => {
				requests.push(messages);
				return Promise.resolve(fragments());
			},
			stream: {
				report: (markdown) => {
					reported.push(markdown);
				},
			},
			snapshots: () => SNAPSHOTS,
			commands: createSlashCommandRegistry(),
			...overrides,
		},
	};
}

async function* replies(...fragments: string[]): AsyncIterable<string> {
	for (const fragment of fragments) {
		yield fragment;
	}
}

function turn(overrides: Partial<ParticipantRequest> = {}): ParticipantRequest {
	return { prompt: "how do retries work?", history: [], ...overrides };
}

describe("extension/features/participant handleParticipantTurn", () => {
	test("the default path sends converted history plus the prompt and streams every fragment", async () => {
		const { deps, reported, requests } = fakeDeps(() => replies("Retries ", "never ", "apply."));
		const outcome = await handleParticipantTurn(
			turn({ history: [{ prompt: "earlier" }, { response: [{ value: { value: "before" } }] }] }),
			deps
		);
		expect(outcome).toEqual({ kind: "completed" });
		expect(requests).toEqual([
			[
				{ role: "user", content: "earlier" },
				{ role: "assistant", content: "before" },
				{ role: "user", content: "how do retries work?" },
			],
		]);
		expect(reported).toEqual(["Retries ", "never ", "apply."]);
	});

	test("/tests routes through the registry and shapes the request", async () => {
		const { deps, requests } = fakeDeps(() => replies("test code"));
		const outcome = await handleParticipantTurn(turn({ command: "tests", prompt: "the parser" }), deps);
		expect(outcome).toEqual({ kind: "completed" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.at(-1)?.content).toBe(`${TESTS_INSTRUCTION}\n\nthe parser`);
	});

	test("/models answers from snapshots without a model request", async () => {
		const { deps, reported, requests } = fakeDeps(() => replies("never streamed"));
		const outcome = await handleParticipantTurn(turn({ command: "models", prompt: "" }), deps);
		expect(outcome).toEqual({ kind: "completed" });
		expect(requests).toEqual([]);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("`gpt-test`");
	});

	test("a command the registry does not know degrades to the plain-prompt path, command preserved", async () => {
		const { deps, requests } = fakeDeps(() => replies("plain answer"));
		const outcome = await handleParticipantTurn(turn({ command: "unknown", prompt: "still a question" }), deps);
		expect(outcome).toEqual({ kind: "completed" });
		expect(requests).toEqual([[{ role: "user", content: "/unknown still a question" }]]);
	});

	test("a history left same-role by a canceled turn coalesces before it is sent", async () => {
		const { deps, requests } = fakeDeps(() => replies("answer"));
		await handleParticipantTurn(
			turn({ history: [{ prompt: "asked, then canceled" }, { response: [] }], prompt: "asked again" }),
			deps
		);
		expect(requests).toEqual([[{ role: "user", content: "asked, then canceled\n\nasked again" }]]);
	});

	test("the empty-turn listing cannot leave the next question opening assistant-first", async () => {
		const { deps, requests } = fakeDeps(() => replies("answer"));
		await handleParticipantTurn(
			turn({
				history: [{ prompt: "" }, { response: [{ value: { value: "Ask me anything, or pick a command:" } }] }],
				prompt: "real question",
			}),
			deps
		);
		expect(requests).toEqual([[{ role: "user", content: "real question" }]]);
	});

	test("an unknown command with an empty prompt gets the listing, not a bare slash token", async () => {
		const { deps, reported, requests } = fakeDeps(() => replies("never streamed"));
		const outcome = await handleParticipantTurn(turn({ command: "unknown", prompt: "  " }), deps);
		expect(outcome).toEqual({ kind: "completed" });
		expect(requests).toEqual([]);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("/tests");
	});

	test("an empty turn lists the commands instead of sending an empty request", async () => {
		const { deps, reported, requests } = fakeDeps(() => replies("never streamed"));
		const outcome = await handleParticipantTurn(turn({ prompt: "   " }), deps);
		expect(outcome).toEqual({ kind: "completed" });
		expect(requests).toEqual([]);
		expect(reported).toHaveLength(1);
		for (const name of ["/tests", "/docs", "/models"]) {
			expect(reported[0]).toContain(name);
		}
	});

	test("an empty turn against an empty registry still answers, without a dangling listing", async () => {
		const { deps, reported } = fakeDeps(() => replies("never streamed"), {
			commands: createSlashCommandRegistry([]),
		});
		const outcome = await handleParticipantTurn(turn({ prompt: "" }), deps);
		expect(outcome).toEqual({ kind: "completed" });
		expect(reported).toEqual(["Ask me anything."]);
	});

	test("a failed request reports friendly text and returns a classification, never the error text", async () => {
		const failure = new Error("500 SECRET-RESPONSE-DETAIL from the server body");
		failure.name = "RequestError";
		const { deps, reported } = fakeDeps(() => replies(), {
			sendRequest: () => Promise.reject(failure),
		});
		const outcome = await handleParticipantTurn(turn(), deps);
		expect(outcome).toEqual({ kind: "failed", log: "chat participant turn failed: RequestError" });
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("Try again");
		expect(JSON.stringify([outcome, reported])).not.toContain("SECRET-RESPONSE-DETAIL");
	});

	test("a terse logClassification wins over the error name, keeping transport failures distinguishable", async () => {
		const failure = Object.assign(new Error("boom"), {
			name: "RequestError",
			logClassification: "RequestError(http, status 404, chat)",
		});
		const { deps } = fakeDeps(() => replies(), { sendRequest: () => Promise.reject(failure) });
		const outcome = await handleParticipantTurn(turn(), deps);
		expect(outcome).toEqual({
			kind: "failed",
			log: "chat participant turn failed: RequestError(http, status 404, chat)",
		});
	});

	test("a multi-line error name fails the terse gate instead of reaching the log", async () => {
		const failure = new Error("boom");
		failure.name = "500 Internal\nbody: SECRET-RESPONSE-DETAIL";
		const { deps } = fakeDeps(() => replies(), { sendRequest: () => Promise.reject(failure) });
		const outcome = await handleParticipantTurn(turn(), deps);
		expect(outcome).toEqual({ kind: "failed", log: "chat participant turn failed: object" });
	});

	test("a hostile error whose getters throw still degrades to friendly text", async () => {
		const hostile = new Error("boom");
		Object.defineProperty(hostile, "name", {
			get() {
				throw new Error("gotcha");
			},
		});
		const { deps, reported } = fakeDeps(() => replies(), { sendRequest: () => Promise.reject(hostile) });
		const outcome = await handleParticipantTurn(turn(), deps);
		expect(outcome).toEqual({ kind: "failed", log: "chat participant turn failed: unreadable-error" });
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("Try again");
	});

	test("a throwing injected cancellation check degrades to the failure path instead of rejecting", async () => {
		const failure = new Error("boom");
		failure.name = "RequestError";
		const { deps, reported } = fakeDeps(() => replies(), {
			sendRequest: () => Promise.reject(failure),
			isCancellation: () => {
				throw new Error("broken check");
			},
		});
		const outcome = await handleParticipantTurn(turn(), deps);
		expect(outcome).toEqual({ kind: "failed", log: "chat participant turn failed: RequestError" });
		expect(reported).toHaveLength(1);
	});

	test("a mid-stream failure keeps the delivered fragments and still ends friendly", async () => {
		async function* failing(): AsyncIterable<string> {
			yield "partial ";
			throw new Error("stream cut SECRET-RESPONSE-DETAIL");
		}
		const { deps, reported } = fakeDeps(failing);
		const outcome = await handleParticipantTurn(turn(), deps);
		expect(outcome).toEqual({ kind: "failed", log: "chat participant turn failed: Error" });
		expect(reported[0]).toBe("partial ");
		expect(reported).toHaveLength(2);
		expect(JSON.stringify(reported)).not.toContain("SECRET-RESPONSE-DETAIL");
	});

	test("a non-Error throw classifies by type", async () => {
		const { deps } = fakeDeps(() => replies(), {
			sendRequest: () => Promise.reject("string failure"),
		});
		const outcome = await handleParticipantTurn(turn(), deps);
		expect(outcome).toEqual({ kind: "failed", log: "chat participant turn failed: string" });
	});

	test("cancellation rides out uncaught and reports nothing", async () => {
		const canceled = new Error("Canceled");
		canceled.name = "Canceled";
		const { deps, reported } = fakeDeps(() => replies(), {
			sendRequest: () => Promise.reject(canceled),
		});
		let caught: unknown;
		try {
			await handleParticipantTurn(turn(), deps);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(canceled);
		expect(reported).toEqual([]);
	});

	test("an injected cancellation check wins over the structural default", async () => {
		const hostCancellation = new Error("stopped");
		const { deps, reported } = fakeDeps(() => replies(), {
			sendRequest: () => Promise.reject(hostCancellation),
			isCancellation: (error) => error === hostCancellation,
		});
		let caught: unknown;
		try {
			await handleParticipantTurn(turn(), deps);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(hostCancellation);
		expect(reported).toEqual([]);
	});
});
