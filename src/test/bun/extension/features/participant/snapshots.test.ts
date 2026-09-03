/**
 * The snapshot conversion behind /models: the provider's per-group snapshots
 * become the label-plus-models shape the markdown renderer takes, with each
 * model's id read from the mint-stamped raw-ID metadata (the id a user writes
 * in settings), and a one-line capability summary per model.
 */
import { describe, expect, test } from "bun:test";
import { participantSnapshots, type SnapshotSource } from "../../../../../extension/features/participant/snapshots";

const SOURCE: readonly SnapshotSource[] = [
	{
		status: { label: "Team proxy", serverId: "srv-1", state: "ok" },
		models: [
			{
				// The exposed id differs from the stamp, so a conversion reading the
				// exposed id cannot pass by accident.
				id: "team-proxy/gpt-4o-mini:cheapest",
				litellm: { rawModelId: "gpt-4o-mini:cheapest" },
				maxInputTokens: 128000,
				capabilities: { toolCalling: true, imageInput: true },
			},
			{ id: "plain", litellm: { rawModelId: "plain" }, maxInputTokens: 8192, capabilities: {} },
		],
	},
];

describe("extension/features/participant snapshots", () => {
	test("the label rides through, every id is the mint-stamped raw model id, and the summary names only what the model reports", () => {
		expect(participantSnapshots(SOURCE)).toEqual([
			{
				label: "Team proxy",
				models: [
					{ id: "gpt-4o-mini:cheapest", capabilities: "128k context, tools, images" },
					{ id: "plain", capabilities: "8k context" },
				],
			},
		]);
	});

	test("a copy that lost the stamp falls back to the exposed id, which group mints keep raw", () => {
		const [group] = participantSnapshots([
			{ status: { label: "solo", serverId: "srv-1", state: "ok" }, models: [{ id: "gpt-4o", maxInputTokens: 1000 }] },
		]);
		expect(group?.models[0]?.id).toBe("gpt-4o");
	});

	test("token counts render compactly at each magnitude", () => {
		const summaries = participantSnapshots([
			{
				status: { label: "s", serverId: "s", state: "ok" },
				models: [
					{ id: "small", maxInputTokens: 900 },
					{ id: "mid", maxInputTokens: 200_000 },
					{
						id: "huge",
						maxInputTokens: 2_000_000,
					},
				],
			},
		])[0]?.models.map((model) => model.capabilities);
		expect(summaries).toEqual(["900 context", "200k context", "2M context"]);
	});

	test("a tool count of zero is not tool support, a positive count is", () => {
		const [group] = participantSnapshots([
			{
				status: { label: "s", serverId: "s", state: "ok" },
				models: [
					{ id: "none", maxInputTokens: 1000, capabilities: { toolCalling: 0 } },
					{ id: "some", maxInputTokens: 1000, capabilities: { toolCalling: 16 } },
				],
			},
		]);
		expect(group?.models[0]?.capabilities).toBe("1k context");
		expect(group?.models[1]?.capabilities).toBe("1k context, tools");
	});

	test("a model that reports nothing usable says so rather than rendering an empty cell", () => {
		const [group] = participantSnapshots([
			{ status: { label: "s", serverId: "s", state: "ok" }, models: [{ id: "mystery" }] },
		]);
		expect(group?.models[0]?.capabilities).toBe("no capabilities reported");
	});

	test("a non-finite or non-positive context window is not reported as a number", () => {
		const [group] = participantSnapshots([
			{
				status: { label: "s", serverId: "s", state: "ok" },
				models: [
					{ id: "nan", maxInputTokens: Number.NaN },
					{ id: "zero", maxInputTokens: 0 },
					{ id: "negative", maxInputTokens: -1 },
				],
			},
		]);
		expect(group?.models.map((model) => model.capabilities)).toEqual([
			"no capabilities reported",
			"no capabilities reported",
			"no capabilities reported",
		]);
	});

	test("a group the user removed is left out entirely, not headed with an empty table", () => {
		// A removed group stays in the status window as healthy-with-no-models, so
		// an unfiltered answer would name a server the user deleted.
		const converted = participantSnapshots([
			{
				status: { label: "removed", serverId: "gone", state: "ok", hiddenByRemoval: true },
				models: [],
			},
			{ status: { label: "live", serverId: "live", state: "ok" }, models: [{ id: "m", maxInputTokens: 1000 }] },
		]);
		expect(converted.map((group) => group.label)).toEqual(["live"]);
	});

	test("a group that is merely empty, or failing, still appears", () => {
		// Only an explicit removal hides a group; an empty or unreachable server
		// is news the user wants, not noise.
		const converted = participantSnapshots([
			{ status: { label: "empty", serverId: "a", state: "ok" }, models: [] },
			{ status: { label: "down", serverId: "b", state: "error" }, models: [] },
		]);
		expect(converted.map((group) => group.label)).toEqual(["empty", "down"]);
	});

	test("no groups converts to no sections", () => {
		expect(participantSnapshots([])).toEqual([]);
	});
});
