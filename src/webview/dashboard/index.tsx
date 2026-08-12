import "./styles/dashboard.css";
import { render } from "preact";
import { App } from "./app";
import { bootstrapL10n } from "./l10nBootstrap";

bootstrapL10n();

const root = document.getElementById("root");
if (root !== null) {
	render(<App />, root);
}
