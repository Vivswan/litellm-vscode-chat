import * as vscode from "vscode";
import { buildFimPrompt, FIM_MAX_TOKENS, FIM_TIMEOUT_MS } from "../../../provider/transport/fim";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { ModelResolutionTable } from "../../../shared/config/resolutionTable";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { getModelParametersConfig, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { entryConnectionFor } from "../../servers/entryConnection";
import { configuredServerUnavailable } from "../modelSettingError";
import { withProbeToken } from "../probeToken";
import { CompletionCache } from "./completionCache";
import type { InlineCompletionSend } from "./inlineCompletionProvider";
import { createInlineCompletionProvider } from "./inlineCompletionProvider";
import { InlineLanguageStatusRow, registerToggleInlineLanguageCommand } from "./languageStatus";

/**
 * The send binds the provider core to the one-shot /completions transport with the fixed FIM bounds; the dashboard's
 * test probe reuses the same send, so the probe proves exactly what ghost text would do.
 */

/**
 * models.parameters fields deliberately do NOT ride along - the template directive is the one documented exception on
 * this path.
 */
function createFimSend(
	secrets: vscode.SecretStorage,
	oneShot: Pick<OneShotClient, "completeFim">,
	table: ModelResolutionTable,
	advise: (message: string, data?: unknown) => void
): InlineCompletionSend {
	return async ({ modelRef, prefix, suffix, token }) => {
		const resolved = await entryConnectionFor(secrets, modelRef.server);
		if (resolved.kind !== "resolved") {
			throw configuredServerUnavailable("inlineCompletions", modelRef.server, resolved.kind);
		}
		const { fimTemplate } = table.resolveParameters(modelRef.server, modelRef.model, {
			globalParameters: getModelParametersConfig(advise),
			entryParameters: resolved.entry.modelParameters,
		});
		const wire = buildFimPrompt({ prefix, suffix, fimTemplate });
		return oneShot.completeFim(
			resolved.connection,
			{
				model: modelRef.model,
				prompt: wire.prompt,
				...(wire.suffix !== undefined ? { suffix: wire.suffix } : {}),
				maxTokens: FIM_MAX_TOKENS,
			},
			// The FIM bound is fixed in code, so no setting rides the budget: timeout advice naming one would point at
			// a setting that cannot raise this bound.
			{ timeout: { ms: FIM_TIMEOUT_MS, setting: undefined }, token }
		);
	};
}

/**
 * The dashboard's test-completion probe: the shared send over a fixed sample context, so the probe proves exactly what
 * ghost text would do - connection, template, bounds, and parse included. The sample is a tiny function head whose
 * natural completion any code model can produce.
 */
export function createFimProbe(fimSend: InlineCompletionSend): (model: FeatureModelRef) => Promise<string | undefined> {
	return (model) =>
		withProbeToken((token) =>
			fimSend({
				modelRef: model,
				prefix: "function add(a, b) {\n\treturn ",
				suffix: ";\n}\n",
				token,
			})
		);
}

/**
 * Returns the send so the dashboard's test-model probe runs the exact pipeline ghost text runs (one pipeline, one
 * truth). `oneShot` is the activation-shared client, so OAuth tokens cache across keystrokes and across features and
 * invalidate on 401 like the chat and usage paths.
 */
export function wireInlineCompletions(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly oneShot: OneShotClient }
): { readonly fimSend: InlineCompletionSend } {
	const log = (message: string, data?: unknown): void => {
		logger.log(message, data);
	};
	registerToggleInlineLanguageCommand(context, log);

	//   One resolution table for the feature's lifetime -> the directive read is memoized
	const table = new ModelResolutionTable();
	const cache = new CompletionCache();
	const fimSend = createFimSend(context.secrets, deps.oneShot, table, (message, data) =>
		logger.advisory(message, data)
	);
	const provider = createInlineCompletionProvider({ send: fimSend, cache, log });

	let registration: vscode.Disposable | undefined;
	let statusRow: InlineLanguageStatusRow | undefined;

	const applyEnablement = (): void => {
		const enabled = isFeatureEnabled("inlineCompletions");
		if (enabled && registration === undefined) {
			registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider);
			statusRow = new InlineLanguageStatusRow(logger);
		} else if (!enabled && registration !== undefined) {
			registration.dispose();
			registration = undefined;
			statusRow?.dispose();
			statusRow = undefined;
		}
	};
	applyEnablement();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) {
				return;
			}
			applyEnablement();
			cache.invalidate();
		}),
		new vscode.Disposable(() => {
			registration?.dispose();
			statusRow?.dispose();
		})
	);
	return { fimSend };
}
