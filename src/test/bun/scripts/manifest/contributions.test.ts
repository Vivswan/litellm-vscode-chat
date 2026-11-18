import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	renderAgentTool,
	renderChatSkills,
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

	test("the provider configuration keeps baseUrl required and orders each descriptor property type, flags, then prose", () => {
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

	test("a skill with no file, or one whose frontmatter names another skill, is refused: the host would drop it silently", () => {
		const files = new Map([
			["skills/demo/SKILL.md", "---\nname: demo\ndescription: Use when demonstrating.\n---\n"],
			["skills/renamed/SKILL.md", "---\nname: demo\ndescription: Use when demonstrating.\n---\n"],
		]);
		const read = (relative: string): string | undefined => files.get(relative);
		assert.deepStrictEqual(renderChatSkills("demo", read), [{ path: "./skills/demo/SKILL.md" }]);
		assert.throws(() => renderChatSkills("absent", read), /the absent skill has no file at skills\/absent\/SKILL\.md/);
		assert.throws(
			() => renderChatSkills("renamed", read),
			/skills\/renamed\/SKILL\.md must open with the frontmatter line "name: renamed"/
		);
	});
});
