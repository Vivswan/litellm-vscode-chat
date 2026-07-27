import { render } from "preact";
import { App } from "./app";

const root = document.getElementById("root");
if (root !== null) {
	render(<App />, root);
}
