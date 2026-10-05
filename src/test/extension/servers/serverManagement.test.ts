import * as assert from "node:assert";
import * as vscode from "vscode";
import { EXTENSION_SETTINGS_FILTER, registerManageCommand } from "../../../extension/servers/serverManagement";
import { expectDefined } from "../../pureHelpers";
import { resolveNls } from "../../util/nls";

suite("extension/servers/serverManagement", () => {
	// The activated extension already owns the litellm.manage command IDs, so the suite captures the handler through a
	// stubbed registerCommand and invokes it.
	function captureManageServersHandler(): () => Promise<void> {
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
		return expectDefined(
			handlers.get("litellm.manageServers"),
			"registerManageCommand must register litellm.manageServers"
		);
	}

	suite("the manageServers route", () => {
		interface RouteRun {
			executed: { command: string; args: unknown[] }[];
			quickPicksShown: number;
		}

		async function runManageServers(): Promise<RouteRun> {
			const handler = captureManageServersHandler();
			const run: RouteRun = { executed: [], quickPicksShown: 0 };
			const origExecute = vscode.commands.executeCommand;
			const origQuickPick = vscode.window.showQuickPick;
			(vscode.commands as Record<string, unknown>).executeCommand = async (command: string, ...args: unknown[]) => {
				run.executed.push({ command, args });
			};
			(vscode.window as Record<string, unknown>).showQuickPick = async () => {
				run.quickPicksShown += 1;
				return undefined;
			};
			try {
				await handler();
			} finally {
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
				(vscode.window as Record<string, unknown>).showQuickPick = origQuickPick;
			}
			return run;
		}

		test("litellm.manageServers opens the dashboard without showing the hub", async () => {
			const run = await runManageServers();
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
			// The host localizes the manifest's %key% references before exposing packageJSON; resolveNls also covers a
			// host handing back the raw manifest.
			return expectDefined(walkthroughs[0]).steps.map((step) => ({
				...step,
				description: resolveNls(step.description),
			}));
		}

		test("the Open Settings button carries the same filter the hub uses", () => {
			const steps = walkthroughSteps();
			const fineTune = expectDefined(steps.find((step) => step.id === "litellm.walkthrough.fineTune"));

			// The walkthrough renderer parses the link as a URI and JSON-decodes the query into the command's
			// arguments; replicating that makes a typo on either side fail loudly instead of silently opening an
			// unfiltered settings view.
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

			// The dashboard is the configuration surface; no walkthrough button may point at a native editor.
			assert.ok(connect.description.includes("(command:litellm.openDashboard)"), connect.description);
			assert.deepStrictEqual(connect.completionEvents, ["onCommand:litellm.openDashboard"]);
		});
	});
});
