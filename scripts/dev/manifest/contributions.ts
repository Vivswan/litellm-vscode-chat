/**
 * Identities, gates, and model-facing text come from the constants (commandIds.ts, settingSpec.ts, serverEntry.ts, the
 * agent tools' envelopes); what only a manifest can say - menu placement and groups, icons, walkthrough steps and
 * media - is authored here, typed against those constants so a renamed command fails to compile before it renders.
 * Prose stays in package.nls.json behind %key% names the renderers derive from the ids.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_TOOL_MODEL_DESCRIPTIONS } from "../../../src/extension/features/agentTools/inputSchema";
import { CONSULT_TOOL_MODEL_DESCRIPTION } from "../../../src/extension/features/consultTool/invocation";
import {
	AGENT_TOOL_IDS,
	AGENT_TOOLS,
	type AgentToolContribution,
	type AgentToolId,
	CMD,
	COMMAND_FEATURES,
	COMMENT_CONTROLLER_ID,
	CONSULT_TOOL_READY_CONTEXT_KEY,
	MCP_PROVIDER_ID,
	SKILL_NAME,
	TOOL_NAME,
	VENDOR_ID,
} from "../../../src/shared/config/commandIds";
import {
	AGENT_TOOL_TOGGLE_KEYS,
	type BooleanSettingId,
	CONFIG_SECTION,
	FEATURE_ENABLE_SETTING_KEYS,
	type FeatureId,
} from "../../../src/shared/config/settingSpec";
import { OPTIONAL_ENTRY_FIELDS } from "../../../src/shared/serverEntry";
import { renderConfiguration } from "./configuration";
import type { JsonObject } from "./serversEntrySchema";
import { manifestInputSchema } from "./toolSchemas";

type CommandKey = keyof typeof CMD;
type CommandId = (typeof CMD)[CommandKey];

/**
 * The commands a feature's enable setting gates: the only ones a menu may place, since every menu `when` names the
 * gate.
 */
type GatedCommandKey = {
	[K in CommandKey]: (typeof COMMAND_FEATURES)[K] extends FeatureId ? K : never;
}[CommandKey];

function settingClause(key: BooleanSettingId): string {
	return `config.${CONFIG_SECTION}.${key}`;
}

/*
 * The rendered shapes below are exact interfaces, one per contribution point, because the host's schemas declare
 * additionalProperties: false: a key outside them makes VS Code reject the whole contribution, so a stray key must be
 * a compile error here rather than a silently absent tool or skill. Every object literal is annotated with its
 * shape where it is built (a map callback's return is otherwise inferred, and inference skips the excess-key check).
 */

interface ContributedCommand {
	readonly command: string;
	readonly title: string;
	readonly icon?: string;
}

const COMMAND_ICONS: Readonly<Partial<Record<CommandKey, string>>> = {
	generateCommitMessage: "$(sparkle)",
	reviewChanges: "$(sparkle)",
	reviewFile: "$(sparkle)",
	reviewResolveThread: "$(check)",
	reviewUnresolveThread: "$(circle-outline)",
	reviewDeleteThread: "$(trash)",
};

function renderCommands(): ContributedCommand[] {
	return (Object.keys(CMD) as CommandKey[]).map((key): ContributedCommand => {
		const icon = COMMAND_ICONS[key];
		return {
			command: CMD[key],
			title: `%litellm.command.${key}.title%`,
			...(icon === undefined ? {} : { icon }),
		};
	});
}

interface MenuItem {
	readonly command: string;
	readonly when: string;
	readonly group: string;
}

type PaletteItem = Omit<MenuItem, "group">;

interface ContributedMenus {
	readonly "scm/title": readonly MenuItem[];
	readonly "comments/commentThread/context": readonly MenuItem[];
	readonly "comments/commentThread/title": readonly MenuItem[];
	readonly commandPalette: readonly PaletteItem[];
}

interface CommentThreadItem<Key extends string = string> {
	readonly command: Key;
	readonly group: `inline@${number}`;
	readonly thread?: "resolved" | "unresolved";
}

export interface MenuInputs<Key extends string = string> {
	readonly commands: Readonly<Record<string, string>>;
	readonly features: Readonly<Record<string, FeatureId | undefined>>;
	readonly scmTitle: readonly Key[];
	readonly commentThreadContext: readonly CommentThreadItem<Key>[];
	readonly commentThreadTitle: readonly CommentThreadItem<Key>[];
	/**
	 * Gated commands contributed only so a menu may name them; the palette hides them, they need a thread to act on.
	 */
	readonly paletteHidden: readonly Key[];
}

const MENU_INPUTS = {
	commands: CMD,
	features: COMMAND_FEATURES,
	scmTitle: ["generateCommitMessage", "reviewChanges"],
	commentThreadContext: [{ command: "reviewReply", group: "inline@1" }],
	commentThreadTitle: [
		{ command: "reviewResolveThread", group: "inline@1", thread: "unresolved" },
		{ command: "reviewUnresolveThread", group: "inline@1", thread: "resolved" },
		{ command: "reviewDeleteThread", group: "inline@2" },
	],
	paletteHidden: ["reviewReply", "reviewResolveThread", "reviewUnresolveThread", "reviewDeleteThread"],
} satisfies MenuInputs<GatedCommandKey>;

/**
 * The SCM buttons read the feature gate first; the comment menus name this extension's controller first, so our
 * actions never appear on another extension's threads.
 *
 * An ungated command in a menu is a compile error for the real tables and a refusal for injected ones.
 */
export function renderMenus(inputs: MenuInputs = MENU_INPUTS): ContributedMenus {
	const id = (key: string): string => {
		const command = inputs.commands[key];
		if (command === undefined) {
			throw new Error(`command ${key} is not contributed, so no menu can place it`);
		}
		return command;
	};
	const gate = (key: string): string => {
		const feature = inputs.features[key];
		if (feature === undefined) {
			throw new Error(`command ${key} has no feature to gate its menu entry on`);
		}
		return settingClause(FEATURE_ENABLE_SETTING_KEYS[feature]);
	};
	const threadItem = (item: CommentThreadItem): MenuItem => ({
		command: id(item.command),
		when: [
			`commentController == ${COMMENT_CONTROLLER_ID}`,
			...(item.thread === undefined ? [] : [`commentThread == ${item.thread}`]),
			gate(item.command),
		].join(" && "),
		group: item.group,
	});
	const hidden = new Set(inputs.paletteHidden);
	for (const key of hidden) {
		gate(key);
	}
	return {
		"scm/title": inputs.scmTitle.map(
			(key): MenuItem => ({
				command: id(key),
				when: `${gate(key)} && scmProvider == git`,
				group: "navigation",
			})
		),
		"comments/commentThread/context": inputs.commentThreadContext.map(threadItem),
		"comments/commentThread/title": inputs.commentThreadTitle.map(threadItem),
		commandPalette: Object.keys(inputs.commands)
			.filter((key) => inputs.features[key] !== undefined)
			.map((key): PaletteItem => ({ command: id(key), when: hidden.has(key) ? "false" : gate(key) })),
	};
}

const AGENT_TOOL_ICONS = {
	diagnostics: "$(pulse)",
	configuration: "$(settings-gear)",
	inspectModel: "$(search)",
	searchCatalog: "$(book)",
	setSetting: "$(edit)",
	editModelRecords: "$(symbol-property)",
	saveServer: "$(server)",
	removeServer: "$(trash)",
	runAction: "$(play)",
} as const satisfies Record<AgentToolId, string>;

/**
 * The consult tool's input schema, authored: its parser (consultTool/invocation.ts readConsultInput) is hand-rolled,
 * so there is no envelope to derive it from. The property descriptions are model-facing English.
 */
const CONSULT_TOOL_INPUT_SCHEMA: JsonObject = {
	type: "object",
	properties: {
		question: {
			type: "string",
			description:
				"The self-contained question to ask. State what you want to know and what a useful answer would look like; the other model sees only this and 'context'.",
		},
		context: {
			type: "string",
			description:
				"Optional background the question depends on: the relevant code, an error message, the constraints, what you already tried. Include what a colleague would need to answer without asking follow-up questions.",
		},
	},
	required: ["question"],
};

interface ToolEntry {
	readonly name: string;
	readonly referenceName: string;
	readonly nlsId: string;
	readonly modelDescription: string;
	readonly icon: string;
	readonly when: string;
	readonly inputSchema: unknown;
}

interface ContributedTool {
	readonly name: string;
	readonly toolReferenceName: string;
	readonly displayName: string;
	readonly userDescription: string;
	readonly modelDescription: string;
	readonly canBeReferencedInPrompt: true;
	readonly icon: string;
	readonly when: string;
	readonly inputSchema: unknown;
}

/** One languageModelTools entry, keys in the order the manifest carries them; every tool is #-referenceable. */
function toolEntry(entry: ToolEntry): ContributedTool {
	return {
		name: entry.name,
		toolReferenceName: entry.referenceName,
		displayName: `%litellm.tool.${entry.nlsId}.displayName%`,
		userDescription: `%litellm.tool.${entry.nlsId}.userDescription%`,
		modelDescription: entry.modelDescription,
		canBeReferencedInPrompt: true,
		icon: entry.icon,
		when: entry.when,
		inputSchema: entry.inputSchema,
	};
}

/**
 * Its `when` says what the registration says: the feature switch for a read, the feature switch AND the tool's own
 * toggle for a write.
 */
export function renderAgentTool(
	id: AgentToolId,
	contribution: AgentToolContribution = AGENT_TOOLS[id]
): ContributedTool {
	const featureSwitch = settingClause(FEATURE_ENABLE_SETTING_KEYS.agentTools);
	return toolEntry({
		name: contribution.name,
		referenceName: contribution.referenceName,
		nlsId: id,
		modelDescription: AGENT_TOOL_MODEL_DESCRIPTIONS[id],
		icon: AGENT_TOOL_ICONS[id],
		when:
			contribution.toggle === undefined
				? featureSwitch
				: `${featureSwitch} && ${settingClause(AGENT_TOOL_TOGGLE_KEYS[contribution.toggle])}`,
		inputSchema: manifestInputSchema(id),
	});
}

/**
 * contributes.languageModelTools: the consult tool, gated on the readiness context key the wiring publishes (the
 * enable boolean alone would advertise the half-configured state), then the agent tools in table order.
 */
function renderLanguageModelTools(): ContributedTool[] {
	return [
		toolEntry({
			name: TOOL_NAME,
			referenceName: "litellmConsult",
			nlsId: "consult",
			modelDescription: CONSULT_TOOL_MODEL_DESCRIPTION,
			icon: "$(comment-discussion)",
			when: CONSULT_TOOL_READY_CONTEXT_KEY,
			inputSchema: CONSULT_TOOL_INPUT_SCHEMA,
		}),
		...AGENT_TOOL_IDS.map((id) => renderAgentTool(id)),
	];
}

function renderMcpServerDefinitionProviders(): { readonly id: string; readonly label: string }[] {
	return [{ id: MCP_PROVIDER_ID, label: "%litellm.mcp.label%" }];
}

export interface ProviderField {
	readonly id: string;
	readonly secret?: boolean;
	readonly format?: "uri";
}

interface ProviderProperty {
	readonly type: "string";
	readonly secret?: true;
	readonly format?: "uri";
	readonly title: string;
	readonly description: string;
}

interface ContributedChatProvider {
	readonly vendor: string;
	readonly displayName: string;
	readonly configuration: {
		readonly properties: Readonly<Record<string, ProviderProperty>>;
		readonly required: readonly string[];
	};
}

/** One descriptor field's property; `secret` and `format` sit between the type and the prose, as the manifest reads. */
function providerProperty(field: ProviderField): ProviderProperty {
	return {
		type: "string",
		...(field.secret === true ? { secret: true } : {}),
		...(field.format === undefined ? {} : { format: field.format }),
		title: `%litellm.provider.${field.id}.title%`,
		description: `%litellm.provider.${field.id}.description%`,
	};
}

/** The two non-descriptor properties, in the manifest's own key order (baseUrl carries its format flag last). */
const BASE_PROVIDER_PROPERTIES: Readonly<Record<string, ProviderProperty>> = {
	baseUrl: {
		type: "string",
		title: "%litellm.provider.baseUrl.title%",
		description: "%litellm.provider.baseUrl.description%",
		format: "uri",
	},
	label: {
		type: "string",
		title: "%litellm.provider.label.title%",
		description: "%litellm.provider.label.description%",
	},
};

/**
 *   label -> mirrors the servers entry label serverSync stamps in, giving groups that share a URL and credentials
 *            distinct identities
 */
export function renderLanguageModelChatProviders(
	optionalFields: readonly ProviderField[] = OPTIONAL_ENTRY_FIELDS
): ContributedChatProvider[] {
	const properties: Record<string, ProviderProperty> = { ...BASE_PROVIDER_PROPERTIES };
	for (const field of optionalFields) {
		properties[field.id] = providerProperty(field);
	}
	return [
		{
			vendor: VENDOR_ID,
			displayName: "%litellm.provider.displayName%",
			configuration: { properties, required: ["baseUrl"] },
		},
	];
}

/**
 * What completes a walkthrough step: one of this extension's commands, a host command (the walkthrough only listens
 * for them, so they stay literals here rather than growing HOST_CMD), a boolean setting changing, or opening the step.
 */
type CompletionEvent =
	| `onCommand:${CommandId}`
	| `onCommand:workbench.${string}`
	| `onSettingChanged:${typeof CONFIG_SECTION}.${BooleanSettingId}`
	| "onStepSelected";

export interface WalkthroughStep {
	readonly id: string;
	/** The step's markdown, repo-relative; shipped with the extension, so it must exist in the checkout. */
	readonly media: string;
	readonly completionEvents: readonly CompletionEvent[];
}

const WALKTHROUGH_STEPS: readonly WalkthroughStep[] = [
	{
		id: "connectServer",
		media: "assets/walkthrough/connect-server.md",
		completionEvents: [`onCommand:${CMD.openDashboard}`],
	},
	{
		id: "pickModel",
		media: "assets/walkthrough/pick-model.md",
		completionEvents: ["onCommand:workbench.action.chat.open"],
	},
	{ id: "configureModel", media: "assets/walkthrough/configure-model.md", completionEvents: ["onStepSelected"] },
	{
		id: "verifyConnection",
		media: "assets/walkthrough/verify-connection.md",
		completionEvents: [`onCommand:${CMD.testConnection}`],
	},
	{
		id: "fineTune",
		media: "assets/walkthrough/fine-tune.md",
		completionEvents: ["onCommand:workbench.action.openSettings"],
	},
	{
		id: "generateCommit",
		media: "assets/walkthrough/generate-commit.md",
		completionEvents: [`onCommand:${CMD.generateCommitMessage}`],
	},
	{
		id: "generatePr",
		media: "assets/walkthrough/generate-pr.md",
		completionEvents: [`onCommand:${CMD.generatePrDescription}`],
	},
	{
		id: "inlineCompletions",
		media: "assets/walkthrough/inline-completions.md",
		completionEvents: [`onSettingChanged:${CONFIG_SECTION}.${FEATURE_ENABLE_SETTING_KEYS.inlineCompletions}`],
	},
	{
		id: "reviewComments",
		media: "assets/walkthrough/review-comments.md",
		completionEvents: [`onCommand:${CMD.reviewChanges}`],
	},
];

interface ContributedWalkthroughStep {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly media: { readonly markdown: string };
	readonly completionEvents: readonly string[];
}

interface ContributedWalkthrough {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly steps: readonly ContributedWalkthroughStep[];
}

const SOURCE_CHECKOUT = path.resolve(__dirname, "..", "..", "..");

/** Whether a repo-relative path exists in the source checkout (not under the --root output directory). */
function mediaInSourceCheckout(relative: string): boolean {
	return fs.existsSync(path.join(SOURCE_CHECKOUT, relative));
}

export function renderWalkthroughs(
	steps: readonly WalkthroughStep[] = WALKTHROUGH_STEPS,
	mediaExists: (relative: string) => boolean = mediaInSourceCheckout
): ContributedWalkthrough[] {
	return [
		{
			id: "litellm.gettingStarted",
			title: "%litellm.walkthrough.title%",
			description: "%litellm.walkthrough.description%",
			steps: steps.map((step): ContributedWalkthroughStep => {
				if (!mediaExists(step.media)) {
					throw new Error(`walkthrough step ${step.id} names a media file that does not exist: ${step.media}`);
				}
				return {
					id: `litellm.walkthrough.${step.id}`,
					title: `%litellm.walkthrough.${step.id}.title%`,
					description: `%litellm.walkthrough.${step.id}.description%`,
					media: { markdown: step.media },
					completionEvents: step.completionEvents,
				};
			}),
		},
	];
}

interface ContributedSkill {
	readonly path: string;
}

/** A repo-relative file's text in the source checkout, or undefined when the checkout has no such file. */
function sourceCheckoutText(relative: string): string | undefined {
	const file = path.join(SOURCE_CHECKOUT, relative);
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

/**
 * The host loads a skill only from skills/<name>/SKILL.md whose frontmatter `name` equals the folder, and drops any
 * other silently, so both are refused here rather than shipped as an absent /litellm. The name is required as the
 * frontmatter's first line, which makes the rule a prefix test with no YAML to parse.
 */
export function renderChatSkills(
	name: string = SKILL_NAME,
	readSkill: (relative: string) => string | undefined = sourceCheckoutText
): ContributedSkill[] {
	const relative = `skills/${name}/SKILL.md`;
	const skill = readSkill(relative);
	if (skill === undefined) {
		throw new Error(`the ${name} skill has no file at ${relative}`);
	}
	if (!skill.startsWith(`---\nname: ${name}\n`)) {
		throw new Error(`${relative} must open with the frontmatter line "name: ${name}", its folder's name`);
	}

	return [{ path: `./${relative}` }];
}

export function renderContributes(): Record<string, unknown> {
	return {
		languageModelChatProviders: renderLanguageModelChatProviders(),
		chatSkills: renderChatSkills(),
		languageModelTools: renderLanguageModelTools(),
		mcpServerDefinitionProviders: renderMcpServerDefinitionProviders(),
		commands: renderCommands(),
		menus: renderMenus(),
		walkthroughs: renderWalkthroughs(),
		configuration: renderConfiguration(),
	};
}
