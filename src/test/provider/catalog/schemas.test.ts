import * as assert from "node:assert";
import { buildModelInfos } from "../../../provider/catalog/registration";
import { supportsTools } from "../../../provider/catalog/schemas";

suite("provider/catalog/schemas", () => {
	suite("supportsTools", () => {
		test("an explicit false is the only veto", () => {
			assert.strictEqual(supportsTools({ provider: "openai", status: "ok", supports_tools: false }), false);
		});

		test("missing and null count as supported", () => {
			assert.strictEqual(supportsTools({ provider: "openai", status: "ok", supports_tools: true }), true);
			assert.strictEqual(supportsTools({ provider: "openai", status: "ok" }), true);
			assert.strictEqual(
				supportsTools({ provider: "openai", status: "ok", supports_tools: null }),
				true,
				"wire entries are lenient pass-throughs, so a null flag must not veto tool calling"
			);
		});

		test("providers without the flag still register aggregates and tool-capable entries", () => {
			const { infos } = buildModelInfos(
				[
					{
						id: "multi",
						shape: {
							kind: "group",
							providers: [
								{ provider: "groq", status: "active" },
								{ provider: "together", status: "active", supports_tools: null },
							],
						},
					},
				],
				{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" },
				1,
				() => {},
				{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
			);
			assert.deepStrictEqual(
				infos.map((i) => i.id),
				["multi:cheapest", "multi:fastest", "multi:groq", "multi:together"],
				"undeclared and null flags register as tool-capable, never as the untooled base entry"
			);
			for (const info of infos) {
				assert.strictEqual(info.capabilities.toolCalling, true, `${info.id} must advertise tool calling`);
			}
		});
	});
});
