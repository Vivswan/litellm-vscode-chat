import "./styles/theme.css";
import "./styles/dashboard.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { bootstrapL10n } from "./l10nBootstrap";

bootstrapL10n();

const root = document.getElementById("root");
if (root !== null) {
	createRoot(root).render(<App />);
}
