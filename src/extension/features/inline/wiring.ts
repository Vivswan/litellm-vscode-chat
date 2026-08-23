import * as vscode from "vscode";
import { buildFimPrompt, FIM_MAX_TOKENS, FIM_TIMEOUT_MS } from "../../../provider/transport/fim";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { ModelResolutionTable } from "../../../shared/config/resolutionTable";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { getModelParametersConfig, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { entryConnectionFor } from "../../servers/entryConnection";
import { noEntryForConfiguredServer } from "../modelSettingError";
import { CompletionCache } from "./completionCache";
import type { InlineCompletionSend } from "./inlineCompletionProvider";
import { createInlineCompletionProvider } from "./inlineCompletionProvider";
import { InlineLanguageStatusRow, registerToggleInlineLanguageCommand } from "./languageStatus";

/**
 * Inline completions wiring: the provider and the language status row exist
 * ONLY while the feature is enabled (opt-in by construction - disabled means
 * no registration and zero traffic), toggled by a configuration watcher. The
 * send binds the provider core to the one-shot /completions transport with
 * the fixed FIM bounds; the dashboard's test probe reuses the same send, so
 * the probe proves exactly what ghost text would do.
 */

/**
 * The one FIM send pipeline: label-to-connection through the shared
 * entryConnectionFor, the `_fim_template` directive read from the cached
 * resolution table (never re-resolved per request), the prompt built by
 * buildFimPrompt, and the fixed-bounds completeFim call. models.parameters
 * fields deliberately do NOT ride along - the template directive is the one
 * documented exception on this path.
 */
function createFimSend(
	secrets: vscode.SecretStorage,
	oneShot: Pick<OneShotClient, "completeFim">,
	table: ModelResolutionTable
): InlineCompletionSend {
	return async ({ modelRef, prefix, suffix, token }) => {
		const resolved = await entryConnectionFor(secrets, modelRef.server);
		if (resolved === undefined) {
			throw noEntryForConfiguredServer("inlineCompletions", modelRef.server);
		}
		const { fimTemplate } = table.resolveParameters(modelRef.server, modelRef.model, {
			globalParameters: getModelParametersConfig(),
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
			{ timeoutMs: FIM_TIMEOUT_MS, token }
		);
	};
}

/**
 * The dashboard's test-completion probe: the shared send over a fixed sample
 * context, so the probe proves exactly what ghost text would do - connection,
 * template, bounds, and parse included. The sample is a tiny function head
 * whose natural completion any code model can produce.
 */
export function createFimProbe(fimSend: InlineCompletionSend): (model: FeatureModelRef) => Promise<string | undefined> {
	return async (model) => {
		// The source exists only to satisfy the send's token seam (the fixed
		// FIM timeout bounds the call); dispose it deterministically so probes
		// cannot accumulate live sources across dashboard sessions.
		const source = new vscode.CancellationTokenSource();
		try {
			return await fimSend({
				modelRef: model,
				prefix: "function add(a, b) {\n\treturn ",
				suffix: ";\n}\n",
				token: source.token,
			});
		} finally {
			source.dispose();
		}
	};
}

/**
 * Wire the feature. Returns the send so the dashboard's test-model probe runs
 * the exact pipeline ghost text runs (one pipeline, one truth). `oneShot` is
 * the activation-shared client, so OAuth tokens cache across keystrokes and
 * across features and invalidate on 401 like the chat and usage paths.
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

	// One resolution table for the feature's lifetime, so the directive read is
	// memoized, never per-request.
	const table = new ModelResolutionTable();
	const cache = new CompletionCache();
	const fimSend = createFimSend(context.secrets, deps.oneShot, table);
	const provider = createInlineCompletionProvider({ send: fimSend, cache, log });

	let registration: vscode.Disposable | undefined;
	let statusRow: InlineLanguageStatusRow | undefined;

	const applyEnablement = (): void => {
		const enabled = isFeatureEnabled("inlineCompletions");
		if (enabled && registration === undefined) {
			// pattern "**": registration cannot express language-ID lists, so the
			// provider filters per invocation (zero requests for filtered
			// languages) and the status row explains the decision.
			registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider);
			statusRow = new InlineLanguageStatusRow(log);
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
			// Any extension setting can change what a completion would say (the
			// model ref, the language lists, a parameters record's template), so
			// a cached suggestion may no longer be true; recomputing is cheap.
			cache.invalidate();
		}),
		new vscode.Disposable(() => {
			registration?.dispose();
			statusRow?.dispose();
		})
	);
	return { fimSend };
}
