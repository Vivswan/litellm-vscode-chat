import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	renderAgentTool,
	renderChatParticipants,
	renderLanguageModelChatProviders,
	renderMenus,
	renderWalkthroughs,
} from "../../../../../scripts/dev/manifest/contributions";

/**
 * The renderers over hand-written inputs: the when-clause compositions, the key orders, and the refusals are facts of
 * the manifest format that no type in the constants states. The real tables render through the same code paths and
 * are judged by `manifest:check`, not here.
 */
describe("manifest contributions renderer", () => {
	test("menus compose each surface's when-clause from the command's feature gate", () => {
		const menus = renderMenus({
			commands: { plain: "x.plain", draft: "x.draft", thread: "x.thread" },
			features: { plain: undefined, draft: "commitGeneration", thread: "reviewComments" },
			scmTitle: ["draft"],
			commentThreadContext: [{ command: "thread", group: "inline@1" }],
			commentThreadTitle: [{ command: "thread", group: "inline@2", thread: "unresolved" }],
			paletteHidden: ["thread"],
		});
		assert.deepStrictEqual(menus, {
			"scm/title": [
				{
					command: "x.draft",
					when: "config.litellm-vscode-chat.commitGeneration.enabled && scmProvider == git",
					group: "navigation",
				},
			],
			"comments/commentThread/context": [
				{
					command: "x.thread",
					when: "commentController == litellm.review && config.litellm-vscode-chat.reviewComments.enabled",
					group: "inline@1",
				},
			],
			"comments/commentThread/title": [
				{
					command: "x.thread",
					when: "commentController == litellm.review && commentThread == unresolved && config.litellm-vscode-chat.reviewComments.enabled",
					group: "inline@2",
				},
			],
			// The ungated command has no palette entry; the hidden one is contributed as `false`.
			commandPalette: [
				{ command: "x.draft", when: "config.litellm-vscode-chat.commitGeneration.enabled" },
				{ command: "x.thread", when: "false" },
			],
		});
	});

	test("a menu placing an ungated or uncontributed command is refused by name", () => {
		const base = {
			commands: { plain: "x.plain" },
			features: { plain: undefined },
			scmTitle: [],
			commentThreadContext: [],
			commentThreadTitle: [],
			paletteHidden: [],
		};
		assert.throws(() => renderMenus({ ...base, scmTitle: ["plain"] }), /command plain has no feature/);
		assert.throws(() => renderMenus({ ...base, paletteHidden: ["plain"] }), /command plain has no feature/);
		assert.throws(
			() => renderMenus({ ...base, commentThreadContext: [{ command: "ghost", group: "inline@1" }] }),
			/command ghost is not contributed/
		);
	});

	test("a read tool gates on the feature switch alone, a write tool on the switch and its own toggle", () => {
		const read = renderAgentTool("diagnostics", { name: "x_read", referenceName: "xRead", toggle: undefined });
		const write = renderAgentTool("runAction", { name: "x_write", referenceName: "xWrite", toggle: "runAction" });
		assert.strictEqual(read.when, "config.litellm-vscode-chat.agentTools.enabled");
		assert.strictEqual(
			write.when,
			"config.litellm-vscode-chat.agentTools.enabled && config.litellm-vscode-chat.agentTools.runAction.enabled"
		);
		assert.deepStrictEqual(
			Object.keys(read),
			[
				"name",
				"toolReferenceName",
				"displayName",
				"userDescription",
				"modelDescription",
				"canBeReferencedInPrompt",
				"icon",
				"when",
				"inputSchema",
			],
			"the manifest's key order"
		);
		assert.strictEqual(write.toolReferenceName, "xWrite");
		assert.strictEqual(write.displayName, "%litellm.tool.runAction.displayName%");
	});

	test("the participant renders the live command order with per-command stickiness and numbered examples", () => {
		const [participant] = renderChatParticipants({
			commands: ["b", "a"],
			presentation: {
				a: { isSticky: true, category: "x_a", examples: 1 },
				b: { isSticky: false, category: "x_b", examples: 2 },
			},
			disambiguation: [{ category: "x_top", key: "top", examples: 1 }],
		});
		assert.deepStrictEqual(participant?.disambiguation, [
			{
				category: "x_top",
				description: "%litellm.participant.disambiguation.top.description%",
				examples: ["%litellm.participant.disambiguation.top.example1%"],
			},
		]);
		assert.deepStrictEqual(participant?.commands, [
			{
				name: "b",
				description: "%litellm.participant.command.b.description%",
				isSticky: false,
				sampleRequest: "%litellm.participant.command.b.sampleRequest%",
				disambiguation: [
					{
						category: "x_b",
						description: "%litellm.participant.command.b.disambiguation.description%",
						examples: [
							"%litellm.participant.command.b.disambiguation.example1%",
							"%litellm.participant.command.b.disambiguation.example2%",
						],
					},
				],
			},
			{
				name: "a",
				description: "%litellm.participant.command.a.description%",
				isSticky: true,
				sampleRequest: "%litellm.participant.command.a.sampleRequest%",
				disambiguation: [
					{
						category: "x_a",
						description: "%litellm.participant.command.a.disambiguation.description%",
						examples: ["%litellm.participant.command.a.disambiguation.example1%"],
					},
				],
			},
		]);
	});

	test("a reused, malformed, or example-less category, a command without a row, and no participant block are refused", () => {
		const row = { isSticky: true, category: "x_a", examples: 1 };
		const top = { category: "x_top", key: "top", examples: 1 };
		assert.throws(
			() => renderChatParticipants({ commands: ["a"], presentation: { a: row }, disambiguation: [] }),
			/participant contributes no disambiguation block/
		);
		assert.throws(
			() =>
				renderChatParticipants({
					commands: ["a"],
					presentation: { a: row },
					disambiguation: [{ ...top, category: "x_a" }],
				}),
			/\/a: disambiguation category x_a is used twice/
		);
		assert.throws(
			() =>
				renderChatParticipants({
					commands: ["a"],
					presentation: { a: { ...row, category: "Bad-Id" } },
					disambiguation: [top],
				}),
			/category Bad-Id is not a lower-case identifier/
		);
		assert.throws(
			() =>
				renderChatParticipants({
					commands: ["a"],
					presentation: { a: { ...row, examples: 0 } },
					disambiguation: [top],
				}),
			/category x_a shows no examples/
		);
		assert.throws(
			() => renderChatParticipants({ commands: ["a", "ghost"], presentation: { a: row }, disambiguation: [top] }),
			/slash command \/ghost has no participant presentation/
		);
	});

	test("the provider configuration keeps baseUrl required and orders each property type, flags, then prose", () => {
		const [provider] = renderLanguageModelChatProviders([
			{ id: "token", secret: true },
			{ id: "endpoint", secret: false, format: "uri" },
		]);
		assert.ok(provider !== undefined);
		const { properties, required } = provider.configuration;
		assert.deepStrictEqual(Object.keys(properties), ["baseUrl", "label", "token", "endpoint"]);
		assert.deepStrictEqual(required, ["baseUrl"]);
		// Key order is compared through the serialization, as manifest:check compares it; deepStrictEqual ignores it.
		assert.strictEqual(
			JSON.stringify(properties.baseUrl),
			JSON.stringify({
				type: "string",
				format: "uri",
				title: "%litellm.provider.baseUrl.title%",
				description: "%litellm.provider.baseUrl.description%",
			})
		);
		assert.strictEqual(
			JSON.stringify(properties.token),
			JSON.stringify({
				type: "string",
				secret: true,
				title: "%litellm.provider.token.title%",
				description: "%litellm.provider.token.description%",
			})
		);
		assert.strictEqual(
			JSON.stringify(properties.endpoint),
			JSON.stringify({
				type: "string",
				format: "uri",
				title: "%litellm.provider.endpoint.title%",
				description: "%litellm.provider.endpoint.description%",
			})
		);
	});

	test("a walkthrough step whose media file does not exist is refused by step and path, and nothing renders", () => {
		const present = new Set(["assets/a.md"]);
		const exists = (relative: string): boolean => present.has(relative);
		const [walkthrough] = renderWalkthroughs(
			[{ id: "first", media: "assets/a.md", completionEvents: ["onStepSelected"] }],
			exists
		);
		assert.deepStrictEqual(walkthrough?.steps, [
			{
				id: "litellm.walkthrough.first",
				title: "%litellm.walkthrough.first.title%",
				description: "%litellm.walkthrough.first.description%",
				media: { markdown: "assets/a.md" },
				completionEvents: ["onStepSelected"],
			},
		]);
		assert.throws(
			() =>
				renderWalkthroughs(
					[
						{ id: "first", media: "assets/a.md", completionEvents: ["onStepSelected"] },
						{ id: "second", media: "assets/missing.md", completionEvents: ["onStepSelected"] },
					],
					exists
				),
			/walkthrough step second names a media file that does not exist: assets\/missing\.md/
		);
	});
});
