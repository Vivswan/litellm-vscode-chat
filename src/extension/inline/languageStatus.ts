import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { INTERNAL_CMD } from "../../shared/config/commandIds";
import type { InlineLanguageListId } from "../../shared/config/settingSpec";
import {
	CONFIG_SECTION,
	FEATURE_MODEL_SETTING_KEYS,
	INLINE_LANGUAGE_LIST_SETTING_KEYS,
} from "../../shared/config/settingSpec";
import { getFeatureModelRef, getInlineCompletionsLanguageList } from "../../shared/config/settings";
import { createSettingsAccess } from "../settingsAccess";
import { languageAllowed } from "./languageFilter";

/**
 * The inline-completions language status row: one entry in the editor's {}
 * language status menu stating whether LiteLLM inline suggestions run for the
 * current file's language, with a toggle action writing the allow/block
 * lists. It consumes the same languageAllowed decision as the provider's
 * invoke-time filter, so the row and the filter can never disagree. Created
 * only while the feature is enabled; the wiring disposes it on disable.
 */

/** The one language-status slot this extension owns; see the slot rule below. */
let liveRow: InlineLanguageStatusRow | undefined;

/** The live row count (0 or 1 by construction) - a test seam mirroring the status bar's slot registry. */
export function liveInlineLanguageStatusRows(): number {
	return liveRow === undefined ? 0 : 1;
}

/**
 * Toggle rule, chosen so no edit can flip unrelated languages: turning a
 * language OFF always adds it to blockedLanguages (block beats allow, and
 * removing an allow-list entry could empty the list, which means "all
 * languages" and would silently turn every other language ON). Turning it
 * back ON removes it from blockedLanguages and, when an allow list is in
 * force without it, adds it there. Writes go through the shared
 * SettingsAccess scope rule (the dashboard's own): the workspace scope when
 * it already holds the value, else Global - a hardcoded Global write against
 * a workspace-held list would silently change nothing while rewriting the
 * user scope.
 */
async function toggleLanguage(languageId: string, log: (message: string, data?: unknown) => void): Promise<void> {
	const allowed = getInlineCompletionsLanguageList("allowedLanguages", log);
	const blocked = getInlineCompletionsLanguageList("blockedLanguages", log);
	const access = createSettingsAccess();
	const write = async (list: InlineLanguageListId, value: readonly string[]): Promise<void> => {
		await access.updateAuto(INLINE_LANGUAGE_LIST_SETTING_KEYS[list], [...value]);
	};
	if (languageAllowed(languageId, allowed, blocked)) {
		await write("blockedLanguages", [...blocked, languageId]);
		return;
	}
	if (blocked.includes(languageId)) {
		await write(
			"blockedLanguages",
			blocked.filter((id) => id !== languageId)
		);
	}
	if (allowed.length > 0 && !allowed.includes(languageId)) {
		await write("allowedLanguages", [...allowed, languageId]);
	}
}

/**
 * THE ONE CREATION POINT for this extension's language status row: at most
 * one live row per host, self-healing like the status bar's slot registry (a
 * double construction disposes the stale holder and logs the replacement).
 */
export class InlineLanguageStatusRow implements vscode.Disposable {
	private readonly item: vscode.LanguageStatusItem;
	private readonly subscriptions: vscode.Disposable[] = [];
	private disposed = false;

	constructor(private readonly log: (message: string, data?: unknown) => void) {
		if (liveRow !== undefined) {
			this.log("language-status slot replaced");
			liveRow.dispose();
		}
		liveRow = this;
		this.item = vscode.languages.createLanguageStatusItem("litellm.inlineCompletions", { pattern: "**" });
		this.item.name = "LiteLLM";
		this.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(CONFIG_SECTION)) {
					this.refresh();
				}
			})
		);
		this.refresh();
	}

	/** Re-render for the active editor's language and the current settings. */
	refresh(): void {
		if (this.disposed) {
			return;
		}
		const modelConfigured = getFeatureModelRef("inlineCompletions", this.log) !== undefined;
		if (!modelConfigured) {
			// Enabled without a model is fail-closed inert; the row says so and
			// its action opens the model setting instead of toggling.
			this.item.severity = vscode.LanguageStatusSeverity.Warning;
			this.item.text = l10n.t("LiteLLM inline suggestions: no model selected");
			this.item.command = {
				title: l10n.t("Select Model"),
				command: INTERNAL_CMD.openSettingKey,
				// The command takes the BARE key and prefixes the section itself.
				arguments: [FEATURE_MODEL_SETTING_KEYS.inlineCompletions],
			};
			return;
		}
		const languageId = vscode.window.activeTextEditor?.document.languageId;
		if (languageId === undefined) {
			this.item.severity = vscode.LanguageStatusSeverity.Information;
			this.item.text = l10n.t("LiteLLM inline suggestions: on");
			this.item.command = undefined;
			return;
		}
		const allowed = getInlineCompletionsLanguageList("allowedLanguages", this.log);
		const blocked = getInlineCompletionsLanguageList("blockedLanguages", this.log);
		const active = languageAllowed(languageId, allowed, blocked);
		this.item.severity = vscode.LanguageStatusSeverity.Information;
		this.item.text = active
			? l10n.t("LiteLLM inline suggestions: active for {0}", languageId)
			: l10n.t("LiteLLM inline suggestions: off for {0}", languageId);
		this.item.command = {
			title: active ? l10n.t("Disable for {0}", languageId) : l10n.t("Enable for {0}", languageId),
			command: INTERNAL_CMD.toggleInlineCompletionsLanguage,
			arguments: [languageId],
		};
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (liveRow === this) {
			liveRow = undefined;
		}
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.item.dispose();
	}
}

/**
 * The toggle command behind the row's action. Registered for the extension's
 * lifetime (command registration cannot follow the enable flag without
 * re-registration races); without the row there is nothing that invokes it,
 * and a manual invocation still just edits the lists.
 */
export function registerToggleInlineLanguageCommand(
	context: vscode.ExtensionContext,
	log: (message: string, data?: unknown) => void
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(INTERNAL_CMD.toggleInlineCompletionsLanguage, async (languageId: unknown) => {
			const id = typeof languageId === "string" && languageId.trim() !== "" ? languageId : undefined;
			const fallback = vscode.window.activeTextEditor?.document.languageId;
			const target = id ?? fallback;
			if (target === undefined) {
				return;
			}
			try {
				await toggleLanguage(target, log);
			} catch (error) {
				// A settings write can fail (readonly settings file); classification
				// only, the toggle simply does not happen.
				log("Inline completions language toggle failed", {
					error: error instanceof Error ? error.name : typeof error,
				});
			}
		})
	);
}
