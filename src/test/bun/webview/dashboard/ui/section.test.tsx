/**
 * The Section primitive: the header line's parts and, more importantly, the
 * naming contract the extension's deep links depend on.
 */
import { afterEach, expect, test } from "bun:test";
import { DOCS_LINK_SERVERS } from "../../../../../webview/dashboard/docsLinks";
import { Section, SectionHeader } from "../../../../../webview/dashboard/ui/section";
import { cleanup, mount } from "../../harness";

afterEach(() => {
	cleanup();
});

test("a section names itself once, for the deep link and for the accessible name alike", () => {
	// An in-page jump (the servers table's model-count link) scrolls to a section by id and moves focus to it, so the
	// id, the tabIndex making it focusable, the naming heading and the scroll margin clearing whatever is sticky are
	// one contract rather than four attributes each surface spells by hand.
	const root = mount(
		<Section id="models" title="Models">
			<p>body</p>
		</Section>
	);
	const section = root.querySelector("section");
	expect(section?.id).toBe("models-section");
	expect(section?.getAttribute("tabindex")).toBe("-1");
	expect(section?.getAttribute("aria-labelledby")).toBe("models-title");
	expect(root.querySelector("#models-title")?.textContent).toBe("Models");
});

test("help, docs, meta and actions are each optional and none of them appear uninvited", () => {
	const bare = mount(
		<Section id="bare" title="Bare">
			{null}
		</Section>
	);
	expect(bare.querySelector(".help-wrap")).toBeNull();
	expect(bare.querySelector(".docs-link")).toBeNull();
	expect(bare.querySelector(".section-meta")).toBeNull();
	expect(bare.querySelector(".section-actions")).toBeNull();

	const full = mount(
		<Section
			id="full"
			title="Full"
			help="what this section is"
			docs={{ href: DOCS_LINK_SERVERS, label: "Open the servers guide" }}
			meta="showing 4 of 4"
			actions={<button type="button">Add</button>}
		>
			{null}
		</Section>
	);
	expect(full.querySelector(".help-wrap")).not.toBeNull();
	expect(full.querySelector(".docs-link")?.getAttribute("href")).toBe(DOCS_LINK_SERVERS);
	expect(full.querySelector(".section-meta")?.textContent).toBe("showing 4 of 4");
	expect(full.querySelector(".section-actions")?.textContent).toBe("Add");
});

test("the header can stand alone, without minting a section id", () => {
	// Sub-headers inside a page want the line but not the landmark; a second
	// element carrying `${id}-section` would break the deep link's assumption
	// that the name identifies exactly one place.
	const root = mount(<SectionHeader title="Just a header" />);
	expect(root.querySelector("section")).toBeNull();
	expect(root.querySelector("h2")?.textContent).toBe("Just a header");
	expect(root.querySelector("h2")?.id).toBe("");
});

test("the help button is named for what it opens, not for the section", () => {
	// Help's `name` becomes the button's aria-label, so passing the title bare announces a button called "Servers"
	// that performs no action. Section-level Help passes no name and reads "Help".
	const root = mount(
		<Section id="named" title="Servers" help="what a server is">
			{null}
		</Section>
	);
	expect(root.querySelector("button.help")?.getAttribute("aria-label")).toBe("Help: Servers");
});

test("the heading level is the caller's, because a sub-header cannot be a second h2", () => {
	// The surfaces this replaces use h2, h3 and h4; pinning h2 would have made
	// the primitive unusable for the sub-headers and split the vocabulary.
	expect(mount(<SectionHeader title="Section" />).querySelector("h2")).not.toBeNull();
	expect(mount(<SectionHeader title="Sub" level={3} />).querySelector("h3")).not.toBeNull();
	expect(mount(<SectionHeader title="Deeper" level={4} />).querySelector("h4")).not.toBeNull();
});

test("a header variant does not cost the caller the id contract", () => {
	// headerClassName exists so a surface that needs one header styled
	// differently keeps using Section, instead of hand-rolling the <section>
	// and losing the naming and focus contract that is the point.
	const root = mount(
		<Section id="variant" title="Variant" headerClassName="compact">
			{null}
		</Section>
	);
	expect(root.querySelector(".section-head")?.classList.contains("compact")).toBe(true);
	expect(root.querySelector("section")?.id).toBe("variant-section");
});
