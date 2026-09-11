import * as l10n from "@vscode/l10n";
import { IconArrowLeft } from "./icons";
import { Button } from "./ui/button";

/**
 * This breadcrumb is the way back at the top of the add, edit, and adopt forms.
 * It routes through the same request the rail and Esc do.
 * A dirty draft therefore gets the same discard-confirm question from all three.
 */
export function BackToServers({ onRequestClose }: { onRequestClose: () => void }) {
	return (
		<nav className="page-trail mb-1 text-[12px]" aria-label={l10n.t("Breadcrumb")}>
			<Button variant="secondary" size="compact" onClick={onRequestClose}>
				<IconArrowLeft /> {l10n.t("Servers")}
			</Button>
		</nav>
	);
}
