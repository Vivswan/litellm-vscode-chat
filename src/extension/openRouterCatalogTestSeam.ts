/**
 * The docker-resolution suite's catalog seam, non-production only (the same
 * gate registerTestCommands applies; it lives here because it is the catalog
 * store's own file-path contract, not a command surface).
 *
 * The store reads its globalStorage cache file exactly once, at initialize(),
 * and the only other way data enters is the network refresh - neither is
 * reachable deterministically from an extension-host test. This command writes
 * (or deletes) the cache file and re-runs initialize(), which re-reads
 * cache -> bundled -> empty through the production path. Payload `undefined`
 * restores the pre-seed state by deleting the file.
 */

import * as vscode from "vscode";
import { CATALOG_FILE_NAME, type OpenRouterCatalogStore } from "./openRouterCatalog";

export function registerOpenRouterCatalogTestSeam(
	context: vscode.ExtensionContext,
	store: OpenRouterCatalogStore
): void {
	if (context.extensionMode === vscode.ExtensionMode.Production) {
		return;
	}
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm._test.seedOpenRouterCatalog", async (payload: unknown) => {
			const target = vscode.Uri.joinPath(context.globalStorageUri, CATALOG_FILE_NAME);
			if (payload === undefined) {
				try {
					await vscode.workspace.fs.delete(target);
				} catch (error) {
					// Only "already absent" restores the pre-seed state; any other
					// failure would leave the fixture installed for a later (reused)
					// test profile, so it must fail the caller.
					if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
						throw error;
					}
				}
			} else {
				await vscode.workspace.fs.createDirectory(context.globalStorageUri);
				await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(payload)));
			}
			await store.initialize();
			return store.snapshot().models.length;
		})
	);
}
