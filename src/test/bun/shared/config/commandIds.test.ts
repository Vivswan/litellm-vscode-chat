import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CMD,
	COMMENT_CONTROLLER_ID,
	CONSULT_TOOL_READY_CONTEXT_KEY,
	generateCommitMessageCommandTitle,
	generatePrDescriptionCommandTitle,
	INTERNAL_CMD,
	MCP_PROVIDER_ID,
	manageCommandTitle,
	PARTICIPANT_ID,
	prGenerationProviderTitle,
	refreshUsageCommandTitle,
	reviewChangesCommandTitle,
	reviewFileCommandTitle,
	syncModelsCommandTitle,
	TOOL_NAME,
	VENDOR_ID,
} from "../../../../shared/config/commandIds";
import type { BooleanSettingId } from "../../../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../../../shared/config/settingSpec";
import { resolveNls } from "../../../util/nls";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * Drift guards between the shared command-ID map and package.json: the
 * palette contributions, the vendor, and the walkthrough deep-links must all
 * use exactly the IDs the code registers.
 */
/** One menus entry, named so the review pins can annotate their lookups. */
interface MenuItem {
	readonly command: string;
	readonly when?: string;
}

interface PackageJson {
	readonly contributes: {
		readonly commands: readonly { readonly command: string; readonly title?: string }[];
		readonly menus?: Readonly<Record<string, readonly MenuItem[]>>;
		readonly languageModelChatProviders: readonly [{ readonly vendor: string }];
		readonly walkthroughs?: unknown;
		readonly chatParticipants?: readonly { readonly id?: string }[];
		readonly languageModelTools?: readonly {
			readonly name?: string;
			readonly toolReferenceName?: string;
			readonly canBeReferencedInPrompt?: boolean;
			readonly when?: string;
			readonly inputSchema?: {
				readonly properties?: Readonly<Record<string, unknown>>;
				readonly required?: readonly string[];
			};
		}[];
		readonly mcpServerDefinitionProviders?: readonly { readonly id?: string }[];
	};
}

function readPackageJson(): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageJson;
}

describe("shared/config/commandIds: package.json drift guard", () => {
	test("CMD names exactly the contributed command set", () => {
		const contributed = readPackageJson().contributes.commands.map((entry) => entry.command);
		assert.deepStrictEqual([...Object.values(CMD)].sort(), [...contributed].sort());
	});

	test("internal commands stay out of contributes.commands", () => {
		// manageServers is registered but deliberately palette-less (the hub is
		// the palette entry); contributing it later must move it into CMD.
		const contributed = new Set(readPackageJson().contributes.commands.map((entry) => entry.command));
		for (const id of Object.values(INTERNAL_CMD)) {
			assert.ok(!contributed.has(id), `${id} is contributed; it belongs in CMD, not INTERNAL_CMD`);
		}
	});

	test("the manage command is contributed under manageCommandTitle()", () => {
		// User-facing messages interpolate the title when telling the user to run
		// the command, so it must be exactly what the palette shows.
		const entry = readPackageJson().contributes.commands.find((candidate) => candidate.command === CMD.manage);
		assert.ok(entry?.title !== undefined, "the manage command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), manageCommandTitle());
	});

	test("the sync-models command is contributed under syncModelsCommandTitle()", () => {
		// Same contract as the manage title: the chat-404 guidance interpolates it.
		const entry = readPackageJson().contributes.commands.find((candidate) => candidate.command === CMD.syncModels);
		assert.ok(entry?.title !== undefined, "the sync-models command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), syncModelsCommandTitle());
	});

	test("the refresh-usage command is contributed under refreshUsageCommandTitle()", () => {
		const entry = readPackageJson().contributes.commands.find((candidate) => candidate.command === CMD.refreshUsage);
		assert.ok(entry?.title !== undefined, "the refresh-usage command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), refreshUsageCommandTitle());
	});

	test("the generate-commit-message command is contributed under generateCommitMessageCommandTitle()", () => {
		const entry = readPackageJson().contributes.commands.find(
			(candidate) => candidate.command === CMD.generateCommitMessage
		);
		assert.ok(entry?.title !== undefined, "the generate-commit-message command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), generateCommitMessageCommandTitle());
	});

	test("the generate-pr-description command is contributed under generatePrDescriptionCommandTitle()", () => {
		const entry = readPackageJson().contributes.commands.find(
			(candidate) => candidate.command === CMD.generatePrDescription
		);
		assert.ok(entry?.title !== undefined, "the generate-pr-description command is contributed with a title");
		assert.strictEqual(resolveNls(entry.title), generatePrDescriptionCommandTitle());
	});

	test("the generate-pr-description palette entry is gated on the enable setting", () => {
		// Opt-in by contribution: the palette entry hides until the boolean
		// flips. The key is typed so a rename in BOOLEAN_SETTING_SPECS breaks
		// this compile instead of leaving the manifest gating a dead setting.
		const enabledKey: BooleanSettingId = "prGeneration.enabled";
		const palette = readPackageJson().contributes.menus?.commandPalette?.find(
			(item) => item.command === CMD.generatePrDescription
		);
		assert.ok(palette !== undefined, "the palette visibility is contributed explicitly");
		assert.strictEqual(palette.when, `config.${CONFIG_SECTION}.${enabledKey}`);
	});

	test("the GitHub Pull Requests provider title never claims the Copilot slot, in any locale", () => {
		// That extension picks a provider by case-insensitive substring, and
		// "Copilot" is the search term of its own slot: a title carrying that
		// word would hijack a request this extension has no business answering.
		// Every translation is checked, because the registered title is the
		// localized one.
		assert.ok(!/copilot/i.test(prGenerationProviderTitle()));
		const key = prGenerationProviderTitle();
		for (const file of ["bundle.l10n.json", "bundle.l10n.zh-cn.json", "bundle.l10n.zh-tw.json"]) {
			const bundle = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "l10n", file), "utf8")) as Record<
				string,
				string | { message: string }
			>;
			const entry = bundle[key];
			assert.ok(entry !== undefined, `${file} carries the provider title key`);
			const text = typeof entry === "string" ? entry : entry.message;
			assert.ok(!/copilot/i.test(text), `${file} translates the provider title with a Copilot substring: ${text}`);
		}
	});

	test("the generate-commit-message menus are gated on the enable setting", () => {
		// The command surfaces are opt-in by contribution: both menu items hide
		// until the boolean flips, and the SCM button only shows on git repos.
		// The key is typed so a rename in BOOLEAN_SETTING_SPECS breaks this
		// compile instead of leaving the manifest gating a dead setting.
		const enabledKey: BooleanSettingId = "commitGeneration.enabled";
		const enabledClause = `config.${CONFIG_SECTION}.${enabledKey}`;
		const menus = readPackageJson().contributes.menus;
		assert.ok(menus !== undefined, "the manifest contributes menus");
		const scmTitle = menus["scm/title"]?.find((item) => item.command === CMD.generateCommitMessage);
		assert.ok(scmTitle !== undefined, "the SCM title bar carries the command");
		assert.strictEqual(scmTitle.when, `${enabledClause} && scmProvider == git`);
		const palette = menus.commandPalette?.find((item) => item.command === CMD.generateCommitMessage);
		assert.ok(palette !== undefined, "the palette visibility is contributed explicitly");
		assert.strictEqual(palette.when, enabledClause);
	});

	test("the review commands are contributed under their shared titles", () => {
		const commands = readPackageJson().contributes.commands;
		const pins: readonly [string, string][] = [
			[CMD.reviewChanges, reviewChangesCommandTitle()],
			[CMD.reviewFile, reviewFileCommandTitle()],
		];
		for (const [command, title] of pins) {
			const entry = commands.find((candidate) => candidate.command === command);
			assert.ok(entry?.title !== undefined, `${command} is contributed with a title`);
			assert.strictEqual(resolveNls(entry.title), title);
		}
	});

	test("every review surface is gated on the enable setting and the controller id", () => {
		// The comment menus must name THIS controller: without the
		// `commentController ==` clause our actions would appear on every
		// extension's comment threads. The palette entries for the thread
		// actions are explicitly hidden - they are meaningless without a thread.
		const enabledKey: BooleanSettingId = "reviewComments.enabled";
		const enabledClause = `config.${CONFIG_SECTION}.${enabledKey}`;
		const controllerClause = `commentController == ${COMMENT_CONTROLLER_ID}`;
		const menus = readPackageJson().contributes.menus;
		assert.ok(menus !== undefined, "the manifest contributes menus");

		const scmTitle = menus["scm/title"]?.find((item) => item.command === CMD.reviewChanges);
		assert.ok(scmTitle !== undefined, "the SCM title bar carries the review command");
		assert.strictEqual(scmTitle.when, `${enabledClause} && scmProvider == git`);

		for (const [location, command, extra] of [
			["comments/commentThread/context", CMD.reviewReply, ""],
			["comments/commentThread/title", CMD.reviewResolveThread, " && commentThread == unresolved"],
			["comments/commentThread/title", CMD.reviewUnresolveThread, " && commentThread == resolved"],
			["comments/commentThread/title", CMD.reviewDeleteThread, ""],
		] as const) {
			const item: MenuItem | undefined = menus[location]?.find((candidate) => candidate.command === command);
			assert.ok(item !== undefined, `${command} is contributed to ${location}`);
			assert.strictEqual(item.when, `${controllerClause}${extra} && ${enabledClause}`, command);
		}

		for (const command of [CMD.reviewChanges, CMD.reviewFile]) {
			const palette: MenuItem | undefined = menus.commandPalette?.find((item) => item.command === command);
			assert.ok(palette !== undefined, `${command} declares its palette visibility`);
			assert.strictEqual(palette.when, enabledClause, command);
		}
		for (const command of [
			CMD.reviewReply,
			CMD.reviewResolveThread,
			CMD.reviewUnresolveThread,
			CMD.reviewDeleteThread,
		]) {
			const palette: MenuItem | undefined = menus.commandPalette?.find((item) => item.command === command);
			assert.ok(palette !== undefined, `${command} declares its palette visibility`);
			assert.strictEqual(palette.when, "false", `${command} is meaningless without a thread`);
		}
	});

	test("the docs and walkthrough prose name the manage command by its contributed title", () => {
		// Presence-only guard: a retitled command must at least reach every doc
		// that tells the user to run it.
		for (const file of [
			path.join("docs", "getting-started.md"),
			path.join("docs", "servers.md"),
			path.join("docs", "troubleshooting.md"),
			path.join("assets", "walkthrough", "fine-tune.md"),
		]) {
			const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			assert.ok(text.includes(manageCommandTitle()), `${file} names the manage command title`);
		}
	});

	test("every contributed command title appears in the getting-started commands table", () => {
		// The docs pin the English titles, so %key% references resolve through
		// package.nls.json first.
		const text = fs.readFileSync(path.join(REPO_ROOT, "docs", "getting-started.md"), "utf8");
		for (const entry of readPackageJson().contributes.commands) {
			assert.ok(entry.title !== undefined, `${entry.command} is contributed with a title`);
			const title = resolveNls(entry.title);
			assert.ok(text.includes(title), `docs/getting-started.md names "${title}"`);
		}
	});

	test("VENDOR_ID is the contributed language-model vendor", () => {
		const [provider] = readPackageJson().contributes.languageModelChatProviders;
		assert.strictEqual(VENDOR_ID, provider.vendor);
	});

	test("the feature contribution identities are pinned fail-closed: empty until contributed, then exactly the constants", () => {
		// The constants exist AHEAD of their features: each manifest section stays
		// absent-or-empty until the feature lands, and any entry it ever carries
		// must use exactly the shared identity - a contribution under another id
		// (or a second entry) fails here rather than shipping a drifting mirror.
		const contributes = readPackageJson().contributes;
		const pins: readonly { section: string; ids: readonly (string | undefined)[]; constant: string }[] = [
			{
				section: "chatParticipants",
				ids: (contributes.chatParticipants ?? []).map((entry) => entry.id),
				constant: PARTICIPANT_ID,
			},
			{
				section: "languageModelTools",
				ids: (contributes.languageModelTools ?? []).map((entry) => entry.name),
				constant: TOOL_NAME,
			},
			{
				section: "mcpServerDefinitionProviders",
				ids: (contributes.mcpServerDefinitionProviders ?? []).map((entry) => entry.id),
				constant: MCP_PROVIDER_ID,
			},
		];
		for (const pin of pins) {
			assert.ok(pin.ids.length <= 1, `${pin.section} contributes more than one entry`);
			for (const id of pin.ids) {
				assert.strictEqual(id, pin.constant, `${pin.section} must contribute exactly the shared constant`);
			}
		}
	});

	test("the consult tool contribution is gated on readiness, not on the enable setting alone", () => {
		// The when-clause must express what REGISTRATION expresses - the enable
		// boolean AND a model ref - so the agent's tool picker never advertises
		// the half-configured state, where every call could only fail. A
		// `config.` clause cannot say that, so the wiring publishes a context key
		// and the manifest reads it; the two spellings live in one constant.
		const [tool] = readPackageJson().contributes.languageModelTools ?? [];
		assert.ok(tool !== undefined, "the consult tool is contributed");
		assert.strictEqual(tool.when, CONSULT_TOOL_READY_CONTEXT_KEY);
		assert.notStrictEqual(
			tool.when,
			`config.${CONFIG_SECTION}.consultTool.enabled`,
			"the enable setting alone is not the gate"
		);
		assert.strictEqual(tool.canBeReferencedInPrompt, true, "the tool is #-referenceable in prompts");
		assert.ok(
			typeof tool.toolReferenceName === "string" && tool.toolReferenceName.length > 0,
			"a #-referenceable tool needs its reference name"
		);
		// The schema is the model's whole contract with the core's input shape:
		// the required question plus the optional context, and nothing else. It
		// documents rather than enforces - the host forwards a missing required
		// property as-is - so readConsultInput parses it again at invoke.
		assert.deepStrictEqual(Object.keys(tool.inputSchema?.properties ?? {}).sort(), ["context", "question"]);
		assert.deepStrictEqual(tool.inputSchema?.required, ["question"]);
	});

	test("walkthrough command: and onCommand: deep-links use registered command IDs", () => {
		const registered = new Set<string>([...Object.values(CMD), ...Object.values(INTERNAL_CMD)]);
		// The command: links sit inside externalized step descriptions, so every
		// manifest string resolves through package.nls.json before the scan.
		const walkthroughs = JSON.stringify(readPackageJson().contributes.walkthroughs ?? "", (_key, value: unknown) =>
			typeof value === "string" ? resolveNls(value) : value
		);
		const references = [...walkthroughs.matchAll(/(?:onCommand|command):(litellm\.[\w.]+)/g)].map(
			(match) => match[1] as string
		);
		assert.ok(references.length > 0, "the walkthrough deep-links at least one extension command");
		for (const id of references) {
			assert.ok(registered.has(id), `walkthrough references unregistered command ${id}`);
		}
	});
});
