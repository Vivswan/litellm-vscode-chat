import * as assert from "node:assert";
import * as vscode from "vscode";
import { COMMAND_SIGIL } from "./fakeStack/commands";
import {
	addServer,
	clearServers,
	collectStream,
	ensureActivated,
	extractText,
	extractToolCalls,
	waitForHostModels,
} from "./hostApiHelpers";
import { expectDefined } from "./testUtils";

/**
 * Multi-turn conversation property suite for the docker LiteLLM stack.
 *
 * Each iteration generates a conversation of randomized length against
 * gpt-5.2-mini (single deployment, deliberately: responses cannot vary by
 * routing) through the real proxy. Turns mix %echo, %text, %think, %play of
 * a runtime-registered custom scenario, and the two-turn %tool flow with a
 * synthesized tool result fed back. Assertions target extracted content
 * only - text, tool calls, tool-call/result pairing across turns - never raw
 * bytes (LiteLLM stamps its own created on every chunk). %deployment is
 * excluded: its oracle is relational and a directed docker test covers it.
 *
 * The iteration budget is its own knob (CONVERSATION_ITERATIONS, default
 * 10) so nightly's FUZZ_ITERATIONS=500 cannot multiply multi-round-trip
 * conversations into the job budget. Reproduce any run with
 * FUZZ_SEED=<seed> (the seed knob is shared with the stream fuzzer); the
 * seed is always logged in nightly's grep format.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || "sk-test-1234";
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";

const seedEnv = Number(process.env.FUZZ_SEED ?? "");
const SEED =
	process.env.FUZZ_SEED?.trim() && Number.isFinite(seedEnv)
		? seedEnv >>> 0
		: (((Date.now() >>> 4) ^ (process.pid << 8)) >>> 0) % 1000000;
const ITERATIONS = Math.max(1, Math.floor(Number(process.env.CONVERSATION_ITERATIONS)) || 10);

/** Deterministic PRNG (mulberry32), same family as the stream fuzzer. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ECHO_WORDS = ["harbor", "signal", "meadow", "circuit", "lantern", "granite", "willow", "beacon"];
const TOOL = {
	name: "get_weather",
	description: "Get the weather",
	inputSchema: { type: "object", properties: { location: { type: "string" } } },
};

interface TurnPlan {
	/** The user message text for this turn. */
	command: string;
	/** Assert the turn's extracted content; returns the assistant text to append to history. */
	check(parts: unknown[]): string;
}

function makeTurn(random: () => number, iteration: number, turnIndex: number, registered: string): TurnPlan {
	const roll = random();
	if (roll < 0.3) {
		const word = expectDefined(ECHO_WORDS[Math.floor(random() * ECHO_WORDS.length)]);
		const text = `${word} ${iteration}-${turnIndex}`;
		return {
			command: `${COMMAND_SIGIL}echo:${text}`,
			check(parts) {
				assert.strictEqual(extractText(parts), text, "echo must round-trip verbatim");
				return text;
			},
		};
	}
	if (roll < 0.55) {
		const words = 5 + Math.floor(random() * 40);
		const seed = Math.floor(random() * 100000);
		return {
			command: `${COMMAND_SIGIL}text:${words}:${seed}`,
			check(parts) {
				const text = extractText(parts);
				assert.strictEqual(text.trim().split(/\s+/).length, words, `${COMMAND_SIGIL}text must produce exactly n words`);
				return text;
			},
		};
	}
	if (roll < 0.75) {
		const steps = 1 + Math.floor(random() * 5);
		return {
			command: `${COMMAND_SIGIL}think:${steps}`,
			check(parts) {
				const text = extractText(parts);
				assert.strictEqual(text, `Finished thinking in ${steps} steps.`, "the closing text is fixed");
				return text;
			},
		};
	}
	return {
		command: `${COMMAND_SIGIL}play:${registered}`,
		check(parts) {
			const text = extractText(parts);
			assert.strictEqual(text, `custom body for ${registered}`, "the registered scenario plays verbatim");
			return text;
		},
	};
}

suite("Docker LiteLLM multi-turn conversations", () => {
	if (!BASE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	let model: vscode.LanguageModelChat;

	suiteSetup(async function () {
		this.timeout(90000);
		await ensureActivated();
		await clearServers();
		await addServer("Docker conversations", BASE_URL, API_KEY);
		const models = await waitForHostModels(
			60000,
			(candidates) => candidates.some((m) => m.id === "gpt-5.2-mini"),
			"host to expose gpt-5.2-mini"
		);
		model = expectDefined(models.find((m) => m.id === "gpt-5.2-mini"));
	});

	async function sendTurns(
		history: vscode.LanguageModelChatMessage[],
		options: vscode.LanguageModelChatRequestOptions = {}
	): Promise<unknown[]> {
		const response = await model.sendRequest(history, options, new vscode.CancellationTokenSource().token);
		return collectStream(response);
	}

	test(`runs ${ITERATIONS} generated conversations (seed ${SEED})`, async function () {
		this.timeout(Math.max(120000, ITERATIONS * 20000));
		// Nightly's failure handler greps this exact format for the repro command.
		console.log(`[fuzz] seed=${SEED} iterations=${ITERATIONS} mode=conversation`);
		const random = mulberry32(SEED ^ 0x2545f491);

		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			// One custom scenario per conversation, registered up front.
			const registered = `conversation-${SEED}-${iteration}`;
			const registration = await fetch(`${FAKE_URL}/_test/custom-scenario`, {
				method: "PUT",
				body: JSON.stringify({
					name: registered,
					config: {
						type: "sse",
						chunks: [
							{ choices: [{ index: 0, delta: { role: "assistant", content: `custom body for ${registered}` } }] },
							{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
						],
					},
				}),
			});
			assert.ok(registration.ok, `custom-scenario registration failed: ${registration.status}`);

			const history: vscode.LanguageModelChatMessage[] = [];
			const turnCount = 1 + Math.floor(random() * 4);
			for (let turn = 0; turn < turnCount; turn++) {
				const plan = makeTurn(random, iteration, turn, registered);
				history.push(vscode.LanguageModelChatMessage.User(plan.command));
				const parts = await sendTurns(history);
				const assistantText = plan.check(parts);
				history.push(vscode.LanguageModelChatMessage.Assistant(assistantText));
			}
		}
	});

	test("the two-turn tool flow pairs the call and its result across turns", async function () {
		this.timeout(60000);
		const random = mulberry32(SEED ^ 0x9e3779b9);
		const location = expectDefined(ECHO_WORDS[Math.floor(random() * ECHO_WORDS.length)]);
		const command = `${COMMAND_SIGIL}tool:get_weather {"location":"${location}"}`;

		const callTurn = await sendTurns([vscode.LanguageModelChatMessage.User(command)], { tools: [TOOL] });
		const calls = extractToolCalls(callTurn);
		assert.strictEqual(calls.length, 1);
		const call = expectDefined(calls[0]);
		assert.strictEqual(call.name, "get_weather");
		assert.deepStrictEqual(call.input, { location });

		const result = `sunny in ${location}`;
		const summaryTurn = await sendTurns(
			[
				vscode.LanguageModelChatMessage.User(command),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
					new vscode.LanguageModelToolCallPart(call.callId, "get_weather", { location }),
				]),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
					new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result)]),
				]),
			],
			{ tools: [TOOL] }
		);
		assert.strictEqual(extractText(summaryTurn), `tool get_weather returned: ${result}`);
	});
});
