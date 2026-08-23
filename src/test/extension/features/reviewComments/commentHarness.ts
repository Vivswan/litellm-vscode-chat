/**
 * The recording double for the comments API. The real controller gives no way
 * to enumerate the threads it holds, so the suites drive a double and read the
 * threads back off it; wiring.test.ts pins the recorded shapes against the
 * real API in one separate test, so the double cannot drift into fiction.
 */
import * as vscode from "vscode";

/** One thread the double created, with everything the feature sets on it. */
export interface FakeThread {
	readonly uri: vscode.Uri;
	range: vscode.Range | undefined;
	comments: readonly vscode.Comment[];
	label?: string;
	contextValue?: string;
	state?: vscode.CommentThreadState;
	collapsibleState: vscode.CommentThreadCollapsibleState;
	canReply: boolean | vscode.CommentAuthorInformation;
	disposed: boolean;
	dispose(): void;
}

/** One controller the double created, and every thread it was asked for. */
export interface FakeController {
	readonly id: string;
	readonly label: string;
	options: vscode.CommentOptions | undefined;
	commentingRangeProvider: vscode.CommentingRangeProvider | undefined;
	readonly threads: FakeThread[];
	disposed: boolean;
	/**
	 * A thread the HOST made, not the feature: what VS Code hands the reply
	 * command when the user starts a thread from the gutter. It is deliberately
	 * NOT in `threads` - the controller never created it, and the point of the
	 * adoption path is that it arrives unknown.
	 */
	createHostThread(uri: vscode.Uri, range: vscode.Range): FakeThread;
}

export interface CommentSpies {
	readonly controllers: FakeController[];
	readonly commandIds: string[];
	fireConfigChange(): void;
}

/** A context whose workspaceState is a plain map, with every write recorded in order. */
export interface FakeReviewContext extends vscode.ExtensionContext {
	readonly writes: unknown[];
}

export function fakeReviewContext(state: Readonly<Record<string, unknown>> = {}): FakeReviewContext {
	const store = new Map<string, unknown>(Object.entries(state));
	const writes: unknown[] = [];
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
		workspaceState: {
			get: (key: string) => store.get(key),
			update: (key: string, value: unknown) => {
				store.set(key, value);
				writes.push(value);
				return Promise.resolve();
			},
			keys: () => [...store.keys()],
		},
		writes,
	} as unknown as FakeReviewContext;
}

/**
 * Run `fn` with the comments API, command registration, and the configuration
 * watcher recorded instead of real: real command registrations would collide
 * across tests in the shared host, and the watcher is captured so tests fire
 * configuration changes deterministically.
 */
export async function withCommentSpies<T>(fn: (spies: CommentSpies) => T | Promise<T>): Promise<Awaited<T>> {
	const controllers: FakeController[] = [];
	const commandIds: string[] = [];
	const configListeners: ((event: vscode.ConfigurationChangeEvent) => void)[] = [];

	const originalCreateController = vscode.comments.createCommentController;
	const originalRegisterCommand = vscode.commands.registerCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;

	/** A thread object with everything the feature reads or writes on one. */
	const makeThread = (uri: vscode.Uri, range: vscode.Range, comments: readonly vscode.Comment[]): FakeThread => {
		const thread: FakeThread = {
			uri,
			range,
			comments,
			collapsibleState: vscode.CommentThreadCollapsibleState.Collapsed,
			canReply: true,
			disposed: false,
			dispose: () => {
				thread.disposed = true;
			},
		};
		return thread;
	};

	(vscode.comments as Record<string, unknown>).createCommentController = (id: string, label: string) => {
		const controller: FakeController = {
			id,
			label,
			options: undefined,
			commentingRangeProvider: undefined,
			threads: [],
			disposed: false,
			createHostThread: (uri: vscode.Uri, range: vscode.Range) => makeThread(uri, range, []),
		};
		controllers.push(controller);
		return {
			id,
			label,
			get options() {
				return controller.options;
			},
			set options(value: vscode.CommentOptions | undefined) {
				controller.options = value;
			},
			get commentingRangeProvider() {
				return controller.commentingRangeProvider;
			},
			set commentingRangeProvider(value: vscode.CommentingRangeProvider | undefined) {
				controller.commentingRangeProvider = value;
			},
			createCommentThread: (uri: vscode.Uri, range: vscode.Range, comments: readonly vscode.Comment[]) => {
				const thread = makeThread(uri, range, comments);
				controller.threads.push(thread);
				return thread as unknown as vscode.CommentThread;
			},
			dispose: () => {
				controller.disposed = true;
				for (const thread of controller.threads) {
					thread.disposed = true;
				}
			},
		} as unknown as vscode.CommentController;
	};
	(vscode.commands as Record<string, unknown>).registerCommand = (id: string) => {
		commandIds.push(id);
		return new vscode.Disposable(() => {});
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
		listener: (event: vscode.ConfigurationChangeEvent) => void
	) => {
		configListeners.push(listener);
		return new vscode.Disposable(() => {});
	};

	try {
		return await fn({
			controllers,
			commandIds,
			fireConfigChange: () => {
				for (const listener of [...configListeners]) {
					listener({ affectsConfiguration: () => true });
				}
			},
		});
	} finally {
		(vscode.comments as Record<string, unknown>).createCommentController = originalCreateController;
		(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
	}
}

/** The threads a controller still holds, in creation order. */
export function liveThreads(controller: FakeController | undefined): readonly FakeThread[] {
	return (controller?.threads ?? []).filter((thread) => !thread.disposed);
}
