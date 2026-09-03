import * as assert from "node:assert";
import * as vscode from "vscode";
import { EXTENSION_SETTINGS_FILTER, registerManageCommand } from "../../../extension/servers/serverManagement";
import { expectDefined } from "../../pureHelpers";
import { resolveNls } from "../../util/nls";

suite("extension/servers/serverManagement", () => {
	// The activated extension already owns the litellm.manage command IDs, so the
	// suites capture the handlers through a stubbed registerCommand and invoke them.
	function captureManageHandlers() {
		const handlers = new Map<string, () => Promise<void>>();
		const origRegister = vscode.commands.registerCommand;
		(vscode.commands as Record<string, unknown>).registerCommand = (id: string, callback: () => Promise<void>) => {
			handlers.set(id, callback);
			return { dispose() {} };
		};
		try {
			registerManageCommand({ subscriptions: [] } as unknown as vscode.ExtensionContext);
		} finally {
			(vscode.commands as Record<string, unknown>).registerCommand = origRegister;
		}
		return {
			manage: expectDefined(handlers.get("litellm.manage"), "registerManageCommand must register litellm.manage"),
			manageServers: expectDefined(
				handlers.get("litellm.manageServers"),
				"registerManageCommand must register litellm.manageServers"
			),
		};
	}

	suite("hub quick pick", () => {
		interface HubRun {
			executed: { command: string; args: unknown[] }[];
			itemLabels: string[];
			quickPicksShown: number;
		}

		async function runHub(selectLabel: string | undefined, entry: "hub" | "direct" = "hub"): Promise<HubRun> {
			const handlers = captureManageHandlers();
			const handler = entry === "hub" ? handlers.manage : handlers.manageServers;

			const run: HubRun = { executed: [], itemLabels: [], quickPicksShown: 0 };
			const origExecute = vscode.commands.executeCommand;
			const origQuickPick = vscode.window.showQuickPick;
			(vscode.commands as Record<string, unknown>).executeCommand = async (command: string, ...args: unknown[]) => {
				run.executed.push({ command, args });
			};
			(vscode.window as Record<string, unknown>).showQuickPick = async (items: { label: string }[]) => {
				run.quickPicksShown += 1;
				run.itemLabels = items.map((item) => item.label);
				return selectLabel === undefined ? undefined : items.find((item) => item.label.includes(selectLabel));
			};
			try {
				await handler();
			} finally {
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
				(vscode.window as Record<string, unknown>).showQuickPick = origQuickPick;
			}
			return run;
		}

		test("the hub lists every surface in one menu, and cancelling it executes nothing", async () => {
			const run = await runHub(undefined);
			assert.deepStrictEqual(
				{ ...run, itemLabels: run.itemLabels.map((label) => label.replace(/^\$\([^)]+\) /, "")) },
				{
					itemLabels: [
						"Manage Servers",
						"Open Dashboard",
						"Sync Models Now",
						"Test Connection",
						"Show Diagnostics",
						"Set Server Secret",
						"Open Settings",
						"Help & Feedback",
						"Report Issue",
					],
					executed: [],
					quickPicksShown: 1,
				}
			);
		});

		const routes: readonly { entry: string; command: string; args: readonly unknown[]; reason?: string }[] = [
			{
				entry: "Manage Servers",
				command: "litellm.openDashboard",
				args: [],
				reason: "the dashboard is the server-management surface, never a native editor",
			},
			{ entry: "Open Dashboard", command: "litellm.openDashboard", args: [] },
			{ entry: "Sync Models Now", command: "litellm.syncModels", args: [] },
			{ entry: "Test Connection", command: "litellm.testConnection", args: [] },
			{ entry: "Show Diagnostics", command: "litellm.showDiagnostics", args: [] },
			{ entry: "Set Server Secret", command: "litellm.setServerSecret", args: [] },
			{
				entry: "Open Settings",
				command: "workbench.action.openSettings",
				args: ["@ext:vivswan.litellm-vscode-chat"],
				reason: "the settings view opens filtered to this extension",
			},
			{ entry: "Help & Feedback", command: "litellm.helpAndFeedback", args: [] },
			{ entry: "Report Issue", command: "litellm.reportIssue", args: [] },
		];
		for (const { entry, command, args, reason } of routes) {
			test(`${entry} routes to ${command}`, async () => {
				const run = await runHub(entry);
				assert.deepStrictEqual(run.executed, [{ command, args }], reason ?? `${entry} must execute exactly ${command}`);
			});
		}

		test("litellm.manageServers opens the dashboard without showing the hub", async () => {
			// The direct route for callers that promise configuration; the legacy
			// quick-pick flows retired with the registry, so the dashboard is the
			// only server-management surface.
			const run = await runHub(undefined, "direct");
			assert.deepStrictEqual(run.executed, [{ command: "litellm.openDashboard", args: [] }]);
			assert.strictEqual(run.quickPicksShown, 0, "configuration routes must not land on the hub menu");
		});
	});

	suite("walkthrough contribution", () => {
		interface WalkthroughStep {
			id: string;
			description: string;
			completionEvents?: string[];
		}

		function walkthroughSteps(): WalkthroughStep[] {
			const extension = expectDefined(vscode.extensions.getExtension("vivswan.litellm-vscode-chat"));
			const walkthroughs = (extension.packageJSON as { contributes: { walkthroughs: { steps: WalkthroughStep[] }[] } })
				.contributes.walkthroughs;
			// The host localizes the manifest's %key% references before exposing
			// packageJSON; resolveNls also covers a host handing back the raw manifest.
			return expectDefined(walkthroughs[0]).steps.map((step) => ({
				...step,
				description: resolveNls(step.description),
			}));
		}

		test("the Open Settings button carries the same filter the hub uses", () => {
			const steps = walkthroughSteps();
			const fineTune = expectDefined(steps.find((step) => step.id === "litellm.walkthrough.fineTune"));

			// The walkthrough renderer parses the link as a URI and JSON-decodes the query
			// into the command's arguments; replicating that makes a typo on either side
			// fail loudly instead of silently opening an unfiltered settings view.
			const match = expectDefined(
				fineTune.description.match(/\(command:workbench\.action\.openSettings\?([^)]+)\)/) ?? undefined,
				"the fine-tune step must carry an openSettings button with arguments"
			);
			const args: unknown = JSON.parse(decodeURIComponent(expectDefined(match[1])));
			assert.deepStrictEqual(args, [EXTENSION_SETTINGS_FILTER]);
		});

		test("the connect-server step's button and completion event open the dashboard", () => {
			const steps = walkthroughSteps();
			const connect = expectDefined(steps.find((step) => step.id === "litellm.walkthrough.connectServer"));

			// The dashboard is the configuration surface; no walkthrough button
			// may point at a native editor.
			assert.ok(connect.description.includes("(command:litellm.openDashboard)"), connect.description);
			assert.deepStrictEqual(connect.completionEvents, ["onCommand:litellm.openDashboard"]);
		});
	});
});
