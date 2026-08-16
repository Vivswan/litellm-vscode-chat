/**
 * The Settings tab below the width where its three tracks stop being tracks:
 * title, control, explanation, each on its own line, in the order the row is
 * spoken. The page stacks at 910px rather than waiting for the row to starve,
 * so the middle state never renders.
 *
 * The PANE decides, not the window, which is why this sits at 900px: the rail
 * has already collapsed here, so the container query sees 803 (the window less
 * the collapsed rail and the pane's 24px of padding a side). Counting the rail
 * but not the padding would answer it 49px wrong. It is also why this cannot be
 * a component test - happy-dom has no layout, so a container query there is just
 * a class name. settings-narrow.ts is the other side of the threshold.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 900, height: 2400 },
};

export default fixture;
