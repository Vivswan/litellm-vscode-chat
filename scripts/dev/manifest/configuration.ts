/**
 * The builders take their inputs as parameters (the real tables are the defaults) so a test can render a mini-spec and
 * pin the key order and the nls key convention.
 *
 *   package.nls.json -> keeps the prose behind `%litellm.config.<id>.description%`
 */
import { WIRE_LIMITS } from "../../../src/dashboard/endpoints";
import {
	BOOLEAN_SETTING_SPECS,
	type BooleanSettingId,
	type BooleanSettingValueSpec,
	CONFIG_SECTION,
	CONFIGURATION_SECTIONS,
	DEFAULT_CURRENCY_SYMBOL,
	DEFAULT_INLINE_LANGUAGE_FILTER,
	DEFAULT_TOKEN_ESTIMATION_MODE,
	DEFAULT_UI_ACCENT,
	DEFAULT_UI_THEME,
	DEFAULT_USAGE_ALERT_THRESHOLDS,
	DEFAULT_USAGE_STATUS_BAR_MODE,
	FEATURE_MODEL_IDS,
	FEATURE_MODEL_SETTING_KEYS,
	type FeatureModelSettingKey,
	LANGUAGE_FILTER_MODES,
	NUMBER_SETTING_SPECS,
	type NumberSettingId,
	type NumberSettingValueSpec,
	SETTING_PRESENTATION,
	type SettingId,
	type SettingPresentation,
	TOKEN_ESTIMATION_MODES,
	UI_ACCENTS,
	UI_THEMES,
	USAGE_STATUS_BAR_MODES,
} from "../../../src/shared/config/settingSpec";
import { assertServersSchemaCoversEntryFields, type JsonObject, SERVERS_ENTRY_SCHEMA } from "./serversEntrySchema";

export type SettingShape =
	| { readonly kind: "number"; readonly spec: NumberSettingValueSpec }
	| { readonly kind: "boolean"; readonly spec: BooleanSettingValueSpec }
	| { readonly kind: "enum"; readonly values: readonly string[]; readonly default: string }
	| { readonly kind: "boundedString"; readonly maxLength: number; readonly default: string }
	| { readonly kind: "featureModel" }
	| { readonly kind: "modelRecord" }
	| { readonly kind: "keywordList" }
	| { readonly kind: "thresholdList" }
	| { readonly kind: "languageFilter" }
	| { readonly kind: "servers" };

/** The renderer's inputs, string-keyed so a test can inject a mini-spec; the spec's own tables are the defaults. */
export interface ConfigurationInputs {
	readonly sections: readonly { readonly id: string; readonly settings: readonly string[] }[];
	readonly shapes: Readonly<Record<string, SettingShape>>;
	readonly presentation: Readonly<Record<string, SettingPresentation>>;
}

type StructuredSettingId = Exclude<SettingId, NumberSettingId | BooleanSettingId | FeatureModelSettingKey>;

const STRUCTURED_SHAPES = {
	servers: { kind: "servers" },
	"models.parameters": { kind: "modelRecord" },
	"models.capabilities": { kind: "modelRecord" },
	"chat.additionalToolSchemaKeywords": { kind: "keywordList" },
	"chat.tokenEstimation": { kind: "enum", values: TOKEN_ESTIMATION_MODES, default: DEFAULT_TOKEN_ESTIMATION_MODE },
	"usage.alertThresholds": { kind: "thresholdList" },
	"usage.statusBar": { kind: "enum", values: USAGE_STATUS_BAR_MODES, default: DEFAULT_USAGE_STATUS_BAR_MODE },
	"usage.currencySymbol": {
		kind: "boundedString",
		maxLength: WIRE_LIMITS.currencySymbol,
		default: DEFAULT_CURRENCY_SYMBOL,
	},
	"ui.theme": { kind: "enum", values: UI_THEMES, default: DEFAULT_UI_THEME },
	"ui.accent": { kind: "enum", values: UI_ACCENTS, default: DEFAULT_UI_ACCENT },
	"inlineCompletions.languageFilter": { kind: "languageFilter" },
	"commitGeneration.prompt": { kind: "boundedString", maxLength: WIRE_LIMITS.commitPrompt, default: "" },
} as const satisfies Record<StructuredSettingId, SettingShape>;

/** Every setting's shape: the spec tables plus the structured shapes, each total over its own slice of SettingId. */
function settingShapes(): Readonly<Record<SettingId, SettingShape>> {
	const shapes: Record<string, SettingShape> = { ...STRUCTURED_SHAPES };
	for (const [id, spec] of Object.entries(NUMBER_SETTING_SPECS)) {
		shapes[id] = { kind: "number", spec };
	}
	for (const [id, spec] of Object.entries(BOOLEAN_SETTING_SPECS)) {
		shapes[id] = { kind: "boolean", spec };
	}
	for (const feature of FEATURE_MODEL_IDS) {
		shapes[FEATURE_MODEL_SETTING_KEYS[feature]] = { kind: "featureModel" };
	}
	return shapes as Record<SettingId, SettingShape>;
}

const SPEC_INPUTS: ConfigurationInputs = {
	sections: CONFIGURATION_SECTIONS,
	shapes: settingShapes(),
	presentation: SETTING_PRESENTATION,
};

/** The manifest omits `scope` for the default (window) scope. */
function scope(presentation: SettingPresentation): JsonObject {
	return presentation.scope === "window" ? {} : { scope: presentation.scope };
}

function restricted(presentation: SettingPresentation): JsonObject {
	return presentation.restricted === true ? { restricted: true } : {};
}

function editPresentation(presentation: SettingPresentation): JsonObject {
	return presentation.editPresentation === undefined ? {} : { editPresentation: presentation.editPresentation };
}

function description(id: string, presentation: SettingPresentation): JsonObject {
	const key = presentation.description === "markdown" ? "markdownDescription" : "description";
	return { [key]: `%litellm.config.${id}.description%` };
}

function enumDescriptions(id: string, values: readonly string[], presentation: SettingPresentation): JsonObject {
	return presentation.enumDescriptions === true
		? { enumDescriptions: values.map((value) => `%litellm.config.${id}.${value}%`) }
		: {};
}

const FEATURE_MODEL_PROPERTIES: JsonObject = {
	server: { type: "string", description: "%litellm.config.featureModel.server.description%" },
	model: { type: "string", description: "%litellm.config.featureModel.model.description%" },
};

/** One property's schema, keys in the order the manifest carries them. */
export function renderProperty(id: string, shape: SettingShape, presentation: SettingPresentation): JsonObject {
	switch (shape.kind) {
		case "number": {
			const scalar = shape.spec.integer === true ? "integer" : "number";
			return {
				type: shape.spec.nullable ? [scalar, "null"] : scalar,
				...scope(presentation),
				default: shape.spec.default,
				...restricted(presentation),
				// The schema admits the off switch as its floor (the settings UI must take 0); the gap up to the real minimum
				// is the readers' contract, stated by the nls description and the generated docs bounds sentence.
				minimum: shape.spec.offValue ?? shape.spec.minimum,
				maximum: shape.spec.maximum,
				...description(id, presentation),
			};
		}
		case "boolean":
			return {
				type: "boolean",
				...scope(presentation),
				default: shape.spec.default,
				...restricted(presentation),
				...description(id, presentation),
			};
		case "enum":
			return {
				type: "string",
				...scope(presentation),
				enum: shape.values,
				default: shape.default,
				...restricted(presentation),
				...enumDescriptions(id, shape.values, presentation),
				...description(id, presentation),
			};
		case "boundedString":
			return {
				type: "string",
				...scope(presentation),
				maxLength: shape.maxLength,
				default: shape.default,
				...restricted(presentation),
				...editPresentation(presentation),
				...description(id, presentation),
			};
		case "featureModel":
			return {
				type: ["object", "null"],
				...scope(presentation),
				default: null,
				...restricted(presentation),
				required: ["server", "model"],
				properties: FEATURE_MODEL_PROPERTIES,
				additionalProperties: false,
				...description(id, presentation),
			};
		case "modelRecord":
			return {
				type: "object",
				...scope(presentation),
				default: {},
				...restricted(presentation),
				...description(id, presentation),
				additionalProperties: { type: "object" },
			};
		case "keywordList":
			return {
				type: "array",
				...scope(presentation),
				default: [],
				...restricted(presentation),
				items: { type: "string", minLength: 1 },
				uniqueItems: true,
				...description(id, presentation),
			};
		case "thresholdList":
			return {
				type: "array",
				...scope(presentation),
				default: DEFAULT_USAGE_ALERT_THRESHOLDS,
				...restricted(presentation),
				// The bound is isUsableThreshold's: finite, in (0, 1].
				items: { type: "number", exclusiveMinimum: 0, maximum: 1 },
				uniqueItems: true,
				...description(id, presentation),
			};
		case "languageFilter":
			return {
				type: "object",
				...scope(presentation),
				additionalProperties: false,
				required: ["mode"],
				properties: {
					mode: {
						type: "string",
						enum: LANGUAGE_FILTER_MODES,
						description: `%litellm.config.${id}.mode.description%`,
					},
					languages: {
						type: "array",
						maxItems: WIRE_LIMITS.languageList,
						items: { type: "string", maxLength: WIRE_LIMITS.languageId },
						description: `%litellm.config.${id}.languages.description%`,
					},
				},
				default: { mode: DEFAULT_INLINE_LANGUAGE_FILTER.mode, languages: DEFAULT_INLINE_LANGUAGE_FILTER.languages },
				...restricted(presentation),
				...description(id, presentation),
			};
		case "servers":
			assertServersSchemaCoversEntryFields();
			return {
				type: "array",
				...scope(presentation),
				default: [],
				...restricted(presentation),
				...description(id, presentation),
				items: SERVERS_ENTRY_SCHEMA,
			};
	}
}

/**
 * Refuses a setting listed in two sections, and one with no shape or presentation (for the spec's own inputs the
 * latter two are compile errors; injected inputs reach the check).
 */
export function renderConfiguration(inputs: ConfigurationInputs = SPEC_INPUTS): readonly JsonObject[] {
	const seen = new Set<string>();
	return inputs.sections.map((section) => {
		const properties: Record<string, JsonObject> = {};
		for (const id of section.settings) {
			if (seen.has(id)) {
				throw new Error(`setting ${id} is listed in two configuration sections`);
			}
			seen.add(id);
			const shape = inputs.shapes[id];
			const presentation = inputs.presentation[id];
			if (shape === undefined || presentation === undefined) {
				throw new Error(`setting ${id} has no ${shape === undefined ? "shape" : "presentation"} to render`);
			}
			properties[`${CONFIG_SECTION}.${id}`] = renderProperty(id, shape, presentation);
		}
		return { title: `%litellm.config.section.${section.id}%`, properties };
	});
}
