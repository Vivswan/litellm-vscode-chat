/**
 * A trailing-edge debounced action: schedule() (re)starts the timer and the action runs once, `delayMs` after the
 * last call.
 *
 * Pure timers, no vscode.
 */
export interface DebouncedAction {
	schedule(): void;
	dispose(): void;
}

export function debounced(action: () => void, delayMs: number): DebouncedAction {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		schedule() {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = undefined;
				action();
			}, delayMs);
		},
		dispose() {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
