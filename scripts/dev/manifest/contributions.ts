/**
 * Renders the contributes blocks whose identities live in code: commands, menus, languageModelTools, chatParticipants,
 * mcpServerDefinitionProviders, the provider's configuration, and walkthroughs. Identities, gates, and model-facing
 * text come from the constants (commandIds.ts, settingSpec.ts, serverEntry.ts, the slash-command tables, the agent
 * tools' envelopes); what only a manifest can say - menu placement and groups, icons, stickiness, disambiguation
 * categories, walkthrough steps and media - is authored here, typed against those constants so a renamed command or a
 * new slash command fails to compile before it renders. Prose stays in package.nls.json behind %key% names the
 * renderers derive from the ids. Builders take their inputs as parameters (the real tables are the defaults) so tests
 * render hand-written fixtures.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_TOOL_MODEL_DESCRIPTIONS } from "../../../src/extension/features/agentTools/inputSchema";
import { CONSULT_TOOL_MODEL_DESCRIPTION } from "../../../src/extension/features/consultTool/invocation";
import { builtinSlashCommands, type SlashCommandName } from "../../../src/extension/features/participant/slashCommands";
import { quickFixSlashCommands } from "../../../src/extension/features/quickFixChatCommands";
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
	PARTICIPANT_ID,
	PARTICIPANT_NAME,
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

/** The commands a feature's enable setting gates: the only ones a menu may place, since every menu `when` names the gate. */
type GatedCommandKey = {
	[K in CommandKey]: (typeof COMMAND_FEATURES)[K] extends FeatureId ? K : never;
}[CommandKey];

/** The `when` clause reading one boolean setting. */
function settingClause(key: BooleanSettingId): string {
	return `config.${CONFIG_SECTION}.${key}`;
}

/*
 * The rendered shapes below are exact interfaces, one per contribution point, because the host's schemas declare
 * additionalProperties: false: a key outside them makes VS Code reject the whole contribution, so a stray key must be
 * a compile error here rather than a silently absent participant or tool. Every object literal is annotated with its
 * shape where it is built (a map callback's return is otherwise inferred, and inference skips the excess-key check).
 */

interface ContributedCommand {
	readonly command: string;
	readonly title: string;
	readonly icon?: string;
}

/** The commands with a toolbar or title-bar icon; the rest show their title alone. */
const COMMAND_ICONS: Readonly<Partial<Record<CommandKey, string>>> = {
	generateCommitMessage: "$(sparkle)",
	reviewChanges: "$(sparkle)",
	reviewFile: "$(sparkle)",
	reviewResolveThread: "$(check)",
	reviewUnresolveThread: "$(circle-outline)",
	reviewDeleteThread: "$(trash)",
};

/** contributes.commands: every CMD member in declaration order, its title behind `litellm.command.<key>.title`. */
export function renderCommands(): ContributedCommand[] {
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

/** The palette entry carries no group. */
type PaletteItem = Omit<MenuItem, "group">;

interface ContributedMenus {
	readonly "scm/title": readonly MenuItem[];
	readonly "comments/commentThread/context": readonly MenuItem[];
	readonly "comments/commentThread/title": readonly MenuItem[];
	readonly commandPalette: readonly PaletteItem[];
}

/** One item of a comment-thread menu. */
export interface CommentThreadItem<Key extends string = string> {
	readonly command: Key;
	readonly group: `inline@${number}`;
	/** Restricts the item to threads in one state; absent, it shows on both. */
	readonly thread?: "resolved" | "unresolved";
}

export interface MenuInputs<Key extends string = string> {
	/** Command key to id, in contribution order; the palette lists the gated commands in this order. */
	readonly commands: Readonly<Record<string, string>>;
	readonly features: Readonly<Record<string, FeatureId | undefined>>;
	/** The SCM title-bar buttons, one `navigation` entry each, shown on git repositories only. */
	readonly scmTitle: readonly Key[];
	readonly commentThreadContext: readonly CommentThreadItem<Key>[];
	readonly commentThreadTitle: readonly CommentThreadItem<Key>[];
	/** Gated commands contributed only so a menu may name them; the palette hides them, they need a thread to act on. */
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
 * contributes.menus. The SCM buttons read the feature gate first; the comment menus name this extension's controller
 * first, so our actions never appear on another extension's threads. The palette carries an entry for every gated
 * command: its gate, or `false` for the thread actions. An ungated command in a menu is a compile error for the real
 * tables and a refusal for injected ones.
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

/** Each agent tool's codicon. */
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
	/** The nls key segment: `litellm.tool.<nlsId>.displayName` and `.userDescription`. */
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
 * One agent tool's entry. Its `when` says what the registration says: the feature switch for a read, the feature
 * switch AND the tool's own toggle for a write. The contribution is a parameter so a test can render a read and a
 * write shape without the real table.
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
export function renderLanguageModelTools(): ContributedTool[] {
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

/** A disambiguation block: the classifier's category id and how many examples the nls table carries for it. */
export interface Disambiguation {
	/** Machine-readable and stable, so deliberately not localized. */
	readonly category: string;
	readonly examples: number;
}

export interface SlashCommandPresentation extends Disambiguation {
	/** Whether the command stays in the chat input after an answer. */
	readonly isSticky: boolean;
}

export interface ParticipantInputs {
	/** The live slash-command names in registration order: what the host's "/" picker lists. */
	readonly commands: readonly string[];
	readonly presentation: Readonly<Record<string, SlashCommandPresentation>>;
	/** The participant's own disambiguation, each block's prose behind `litellm.participant.disambiguation.<key>`. */
	readonly disambiguation: readonly (Disambiguation & { readonly key: string })[];
}

/** /models lists from the snapshots and takes no prompt, so it does not stay in the input the way the prompt commands do. */
const SLASH_COMMANDS = {
	tests: { isSticky: true, category: "litellm_test_generation", examples: 2 },
	docs: { isSticky: true, category: "litellm_documentation_writing", examples: 2 },
	models: { isSticky: false, category: "litellm_model_listing", examples: 2 },
	fix: { isSticky: true, category: "litellm_fix_diagnostic", examples: 2 },
	explain: { isSticky: true, category: "litellm_explain_diagnostic", examples: 2 },
} as const satisfies Record<SlashCommandName, SlashCommandPresentation>;

/** The live tables, read at render time: the slash-command factories resolve their descriptions through l10n per call. */
function liveParticipantInputs(): ParticipantInputs {
	return {
		commands: [...builtinSlashCommands(), ...quickFixSlashCommands()].map((command) => command.name),
		presentation: SLASH_COMMANDS,
		disambiguation: [
			{ category: "litellm_model_catalog", key: "catalog", examples: 2 },
			{ category: "litellm_own_model_answer", key: "ownModel", examples: 2 },
		],
	};
}

const CATEGORY_ID = /^[a-z][a-z0-9_]+$/;

interface ContributedDisambiguation {
	readonly category: string;
	readonly description: string;
	readonly examples: readonly string[];
}

interface ContributedSlashCommand {
	readonly name: string;
	readonly description: string;
	readonly isSticky: boolean;
	readonly sampleRequest: string;
	readonly disambiguation: readonly ContributedDisambiguation[];
}

interface ContributedParticipant {
	readonly id: string;
	readonly name: string;
	readonly fullName: string;
	readonly description: string;
	readonly when: string;
	readonly isSticky: boolean;
	readonly sampleRequest: string;
	readonly disambiguation: readonly ContributedDisambiguation[];
	readonly commands: readonly ContributedSlashCommand[];
}

/**
 * contributes.chatParticipants. The categories are the classifier's intent ids: each must be a lower-case identifier
 * and unique across the participant and its commands, or routing is ambiguous by our own making; a block with no
 * example, or a participant with no block, gives the classifier nothing to route on. A live command without a
 * presentation row is a compile error for the real table and a refusal for injected inputs.
 */
export function renderChatParticipants(inputs: ParticipantInputs = liveParticipantInputs()): ContributedParticipant[] {
	if (inputs.disambiguation.length === 0) {
		throw new Error("the participant contributes no disambiguation block");
	}
	const categories = new Set<string>();
	const block = (where: string, keyPrefix: string, disambiguation: Disambiguation): ContributedDisambiguation => {
		if (!CATEGORY_ID.test(disambiguation.category)) {
			throw new Error(`${where}: disambiguation category ${disambiguation.category} is not a lower-case identifier`);
		}
		if (categories.has(disambiguation.category)) {
			throw new Error(`${where}: disambiguation category ${disambiguation.category} is used twice`);
		}
		categories.add(disambiguation.category);
		if (disambiguation.examples < 1) {
			throw new Error(`${where}: disambiguation category ${disambiguation.category} shows no examples`);
		}
		return {
			category: disambiguation.category,
			description: `%${keyPrefix}.description%`,
			examples: Array.from({ length: disambiguation.examples }, (_, index) => `%${keyPrefix}.example${index + 1}%`),
		};
	};
	return [
		{
			id: PARTICIPANT_ID,
			name: PARTICIPANT_NAME,
			fullName: "LiteLLM",
			description: "%litellm.participant.description%",
			// Without this gate the host keeps offering @litellm after the setting is off, with no handler behind it.
			when: settingClause(FEATURE_ENABLE_SETTING_KEYS.chatParticipant),
			// Off, @litellm drops out of the input after every answer and the user re-types it.
			isSticky: true,
			sampleRequest: "%litellm.participant.sampleRequest%",
			disambiguation: inputs.disambiguation.map((entry) =>
				block("participant", `litellm.participant.disambiguation.${entry.key}`, entry)
			),
			commands: inputs.commands.map((name): ContributedSlashCommand => {
				const presentation = inputs.presentation[name];
				if (presentation === undefined) {
					throw new Error(`slash command /${name} has no participant presentation`);
				}
				const keyPrefix = `litellm.participant.command.${name}`;
				return {
					name,
					description: `%${keyPrefix}.description%`,
					isSticky: presentation.isSticky,
					sampleRequest: `%${keyPrefix}.sampleRequest%`,
					disambiguation: [block(`/${name}`, `${keyPrefix}.disambiguation`, presentation)],
				};
			}),
		},
	];
}

export function renderMcpServerDefinitionProviders(): { readonly id: string; readonly label: string }[] {
	return [{ id: MCP_PROVIDER_ID, label: "%litellm.mcp.label%" }];
}

/** One field of the provider group's configuration; the descriptor's entries are this shape. */
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

/** One configuration property; `secret` and `format` sit between the type and the prose. */
function providerProperty(field: ProviderField): ProviderProperty {
	return {
		type: "string",
		...(field.secret === true ? { secret: true } : {}),
		...(field.format === undefined ? {} : { format: field.format }),
		title: `%litellm.provider.${field.id}.title%`,
		description: `%litellm.provider.${field.id}.description%`,
	};
}

/**
 * contributes.languageModelChatProviders: the vendor and the group configuration's schema. baseUrl is the one
 * required field; label mirrors the servers entry label serverSync stamps in, giving groups that share a URL and
 * credentials distinct identities; then the descriptor's optional fields in its order, secret flags as it declares
 * them.
 */
export function renderLanguageModelChatProviders(
	optionalFields: readonly ProviderField[] = OPTIONAL_ENTRY_FIELDS
): ContributedChatProvider[] {
	const properties: Record<string, ProviderProperty> = {};
	for (const field of [{ id: "baseUrl", format: "uri" } as const, { id: "label" }, ...optionalFields]) {
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
	/** The step's id and nls key segment: `litellm.walkthrough.<id>`. */
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

/** The checkout these sources were loaded from, three levels above scripts/dev/manifest; the media ships from here. */
const SOURCE_CHECKOUT = path.resolve(__dirname, "..", "..", "..");

/** Whether a repo-relative path exists in the source checkout (not under the --root output directory). */
function mediaInSourceCheckout(relative: string): boolean {
	return fs.existsSync(path.join(SOURCE_CHECKOUT, relative));
}

/** contributes.walkthroughs: the one getting-started walkthrough. A step whose media file does not exist is refused. */
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

/** Every generated block, keyed as contributes carries it. */
export function renderContributes(): Record<string, unknown> {
	return {
		languageModelChatProviders: renderLanguageModelChatProviders(),
		chatParticipants: renderChatParticipants(),
		languageModelTools: renderLanguageModelTools(),
		mcpServerDefinitionProviders: renderMcpServerDefinitionProviders(),
		commands: renderCommands(),
		menus: renderMenus(),
		walkthroughs: renderWalkthroughs(),
		configuration: renderConfiguration(),
	};
}
