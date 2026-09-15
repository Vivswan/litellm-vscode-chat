/**
 * The lm-tool wirings' shared host-surface spies. A wiring under test must not
 * touch the real host: a real registerTool collides with the activated
 * extension's own under the same name, a real setContext leaks into the
 * live-host suites whose contributions gate on the key, and the real
 * configuration watcher fires when the host decides rather than when the test
 * does. Every patch is restored in finally, so a failing suite cannot leave
 * the shared host patched for every later one.
 */
import * as vscode from "vscode";
import { Logger } from "../../../shared/logger";

interface RecordedRegistration {
	readonly name: string;
	readonly tool: vscode.LanguageModelTool<unknown>;
	disposed: boolean;
}

export interface WiringSpies {
	readonly registrations: RecordedRegistration[];
	/** Every value the wiring published per context key, in order; a wiring that sets no key leaves this empty. */
	readonly contextStates: Map<string, unknown[]>;
	fireConfigChange(): void;
}

/** Run `fn` with tool registration, setContext, and the configuration watcher recorded instead of real. */
export async function withWiringSpies<T>(fn: (spies: WiringSpies) => T | Promise<T>): Promise<Awaited<T>> {
	const registrations: RecordedRegistration[] = [];
	const contextStates = new Map<string, unknown[]>();
	const configListeners: ((event: vscode.ConfigurationChangeEvent) => void)[] = [];
	const originalRegisterTool = vscode.lm.registerTool;
	const originalExecuteCommand = vscode.commands.executeCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;

	(vscode.lm as Record<string, unknown>).registerTool = (name: string, tool: vscode.LanguageModelTool<unknown>) => {
		const record: RecordedRegistration = { name, tool, disposed: false };
		registrations.push(record);
		return new vscode.Disposable(() => {
			record.disposed = true;
		});
	};
	(vscode.commands as Record<string, unknown>).executeCommand = (command: string, ...args: unknown[]) => {
		if (command === "setContext" && typeof args[0] === "string") {
			const states = contextStates.get(args[0]) ?? [];
			states.push(args[1]);
			contextStates.set(args[0], states);
			return Promise.resolve(undefined);
		}
		return (originalExecuteCommand as (command: string, ...args: unknown[]) => Thenable<unknown>)(command, ...args);
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
		listener: (event: vscode.ConfigurationChangeEvent) => void
	) => {
		configListeners.push(listener);
		return new vscode.Disposable(() => {});
	};

	try {
		return await fn({
			registrations,
			contextStates,
			fireConfigChange: () => {
				for (const listener of [...configListeners]) {
					listener({ affectsConfiguration: () => true });
				}
			},
		});
	} finally {
		(vscode.lm as Record<string, unknown>).registerTool = originalRegisterTool;
		(vscode.commands as Record<string, unknown>).executeCommand = originalExecuteCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
	}
}

export function fakeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
	} as unknown as vscode.ExtensionContext;
}

export function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}
