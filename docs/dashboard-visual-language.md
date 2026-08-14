# The dashboard's visual language

The rules the dashboard's surfaces follow, and where each one is embodied. This
is a contributor reference for building and reviewing dashboard UI; the code is
the source of truth, and when the two disagree, fix whichever is wrong rather
than letting them drift.

Citations name files under `src/webview/dashboard/`; `dashboard.css` and
`theme.css` are its `styles/` stylesheets, and line numbers are as of this
document's introduction. The named selectors and constants are the durable
anchors - if a line number has rotted, grep the name.

## 1. Row anatomy

Three surface classes, each with one owner of its geometry.

### List rows (servers, models, usage)

- Zone order along a row: chevron (only where the row opens), identity, machine
  text, verdict pill, numerics, badges, and a reserved actions track at the
  trailing edge. The server row is the full set: name, url, status, count,
  usage, badges, actions (dashboard.css:582-601).
- The LIST owns `grid-template-columns`; rows inherit it through subgrid
  (`.server-list`/`.server-row`, dashboard.css:559-601; the record matcher
  list's `.record-table` repeats the construction, dashboard.css:1278-1322).
  Per-row auto tracks are banned: they size against one row's own content, so
  neighbours stop lining up and comparing values down the page - the reason
  the columns exist - stops working (dashboard.css:559-565).
- Windowed lists cannot share tracks across a virtualized scrollport, so every
  row declares identical widths instead: the models list's columnar tier
  (dashboard.css:2265-2325, the "same track arithmetic" note at 2272-2277) over
  fixed-height row lines (`.model-row-line`, dashboard.css:347-366).

### Setting rows

- One full-bleed template: a right-aligned label in a fixed gutter, the control
  column, the explanation column growing with the pane, and a fixed trailing
  actions slot at the pane's right edge (`SETTING_ROW_GRID` and
  `SETTING_TITLE`, settings.tsx:127-170).
- The description wears the hint measure, 72ch (`p.hint`'s own,
  dashboard.css:210-219), as a reading cap inside its growing track: structure
  goes full-bleed, prose stops where lines stay readable
  (settings.tsx:321-327).
- The gutter marker is always present and transparent when clean, so marking a
  row modified never shifts it (settings.tsx:247-252 and 294-298).
- An error COVERS the description, never displaces it: the description stays in
  flow, merely invisible, so the form's height does not change while you type
  (settings.tsx:309-311 and 359-363).

### Form rows (slide-over panels, the server form)

- `.rows` owns the column tracks and each `.row` subgrids onto them
  (dashboard.css:1071-1094 and 1150-1156; the matcher editor's copy at
  2829-2846).
- Rows stack to one column below the 700px pane tier (dashboard.css:2895-2942).

### Numeric columns vs phrase columns

- A NUMERIC column (bare numbers) right-aligns with tabular figures (`td.num`,
  dashboard.css:818-822; the rationale at 1504-1513), and where rows do not
  share tracks its declared width carries a minimum so the figures still stack
  (the models list's columnar minimums, dashboard.css:2313-2325).
- A PHRASE column (numbers inside localized templates, units, or prose)
  left-aligns. The distinction is the content, not the position: right-aligning
  a word only pushes it away from the name it belongs to
  (modelInspector.tsx:331-352), and a localized template's shape changes with
  the locale, so its right edge is not a stable alignment axis.

## 2. The reveal affordance

One idiom for actions that rest hidden on a row, and it has one home:
`ui/reveal.tsx`.

- A wrapper span carrying `opacity-0` - never `visibility`, which drops the
  control from the Tab order so `:focus-within` can never fire for it - with a
  120ms opacity transition, revealed by `group-hover` and `group-focus-within`,
  always painted below the 560px pane tier (hover does not exist on touch), and
  `motion-reduce:transition-none` (ui/reveal.tsx:1-52; the rationale also at
  dashboard.css:660-686). The wrapper, not the button, carries the reveal,
  because the button's own disabled opacity would outrank it
  (models.tsx:904-930). A new reveal site uses the primitive or, where its
  group scope does not fit, copies an existing embodiment exactly - a variant
  spelling is a bug, not a house style.
- Revealing something never moves anything. A transient either has its space
  reserved or covers what it replaces: the server row's actions occupy a
  reserved track so revealing them cannot reflow the row
  (dashboard.css:582-586), a settings error covers the description instead of
  displacing it (settings.tsx:309-311), and the reveal wrapper itself keeps the
  hidden control's box (opacity, not display). In a prose zone the transient
  trails what is visible: nothing visible follows the "?" at rest, so the
  settings row's hover-only note renders after the glyph rather than holding a
  gap open mid-sentence (settings.tsx:329-339).
- One placement per element class, zero exceptions within the class: an element
  class has exactly one home on its surface. Row actions sit in the reserved
  trailing track (dashboard.css:582-586; the settings rows' actions slot,
  settings.tsx:365-374), section actions trail the header line
  (`.section-actions`, dashboard.css:2164-2171), and the heading settings.json
  jump sits directly after the heading it opens, everywhere
  (recordEditors.tsx:83-95).

## 3. Annotations: what is visible at rest

- Visible at rest: identity, the value, a state SHAPE, and at most one ranked
  consequence phrase (the usage row's `tailFact`, usage.tsx:257-264).
  Everything else waits behind a tip, a disclosure, or an inspector.
- An annotation earns rest-visibility by being news. A User-scope setting value
  shows no note at rest - the gutter bar already says "set", and the scope is
  the expected one - while a workspace-scope value names its scope, the one
  case the bar cannot disambiguate (settings.tsx:221-245). "Showing 3 of 3" at
  rest is a tautology (diagnostics.tsx:1031-1035); and when the narrow server
  row must shed something, the `https://` scheme goes first while insecure
  `http://` stays painted - insecure is news (dashboard.css:3161-3175).
- Exemption: debugging surfaces where provenance IS the content. The model
  inspector's whole vocabulary is provenance (dashboard.css:1355-1361), and the
  resolved-models table renders a provenance chip beside every value at rest
  (diagnostics.tsx:835-876; dashboard.css:2510-2518).

## 4. Chips and pills

Two registers: a soft fill wraps prose words; an outline with the mono face
wraps machine text (dashboard.css:1382-1386). Five families, one job each:

- Status pill: state, with one SHAPE per tone - circle ok, triangle warn,
  square error, hollow ring muted - because hue alone cannot rank the tones
  (dashboard.css:247-271).
- Badge: soft-fill prose facts beside names and counts (ui/badge.tsx:5-22).
- Filter pill: an outlined toggle, filled when pressed, with `aria-pressed`
  carrying the state (dashboard.css:2063-2094; models.tsx:355).
- Provenance chip: outline plus mono, and never severity-toned - provenance
  says where a value came from, never whether that is a problem
  (dashboard.css:2510-2529, 1576-1580, 2390-2394).
- Field chip: a record row's key/value cell (recordEditors.tsx:2382).

Chip radius never mints a fresh literal. The named tokens live in theme.css
(`--radius-chip`, `--radius-pill`, `--radius-field`, declared at runtime on
`:root` beside `--radius`), and every plain-CSS chip, pill, or field rule reads
its token: the machine-text chips wear `--radius-chip` (the same arithmetic the
`rounded-sm` utility bakes in), and the toggle pills wear `--radius-pill`, the
one near-pill radius that makes filled-vs-outline read as a toggle rather than
a chip.

## 5. Disclosure

One idiom for detail that opens in place:

- A leading chevron rotates 90 degrees in 120ms and stands down under reduced
  motion (dashboard.css:391-404 and 2622-2636).
- The whole readable block is the button, styled out of button chrome - the
  chevron is the part that says it opens (dashboard.css:370-390).
- The detail indents under a 2px accent left border tying it to its opener
  (dashboard.css:471-486 and 2637-2647).
- Collapsed, the row shows one ranked consequence line (usage.tsx:257-264);
  expanded, it carries the detail.
- Explanatory figures stay always open: a collapse nobody wants on the figure
  that explains the model is a click tax (dashboard.css:2403-2409 and
  1408-1410).

## 6. Copy

- Descriptions are one or two short sentences, example first
  (helpText.ts:11-13), inside the 72ch hint measure (dashboard.css:210-219).
- A problem leads with ONE consequence sentence; technical detail rides a
  dimmed second line under it, and the guide lives behind Learn more
  (dashboard.css:771-784; diagnostics.tsx:378 and 406-408).
- Standing prose is a hint line, not a paragraph: the section's "?" carries the
  long explanation (helpText.ts:1-14), and counts and filter state ride the
  section header's meta slot (ui/section.tsx:46-75; diagnostics.tsx:1031-1040).
- Before shipping copy, self-audit it: broken grammar, unclear referents,
  filler verbs, and cute-but-wrong phrasing all read fine to their author on
  the first pass.
- Error placement follows scope:
  - field-level stands in the description's slot: where the surface promises
    stable height it covers the still-present description
    (settings.tsx:309-311), and the server form swaps hint for error under the
    same id so the field's advice stays announced (serverEditPage.tsx:437-445);
  - row-level is a `.row-diagnostic` under the owning row
    (dashboard.css:693-717);
  - operation-level is a dismissible banner with `role="alert"`
    (servers.tsx:1253; dashboard.css:1942-1968);
  - success is a transient toast only where nothing updates in place - the
    three server intents (app.tsx:89-108 and 161; dashboard.css:1970-1993); a
    setting edit's success IS the value visibly updating, and a record Apply
    reports beside its own button (recordEditors.tsx:284-296).

## 7. Width

- Lists run full-bleed to the surface measure; forms and prose are measured
  (dashboard.css:153-165). Hints and setting descriptions share the 72ch
  measure (dashboard.css:210-219; settings.tsx:321-327); a prose surface with
  its own reading problem states its own cap and why (the diagnostic headline's
  84ch, dashboard.css:771-784).
- ONE right edge per surface: either a shared measure worn by header and body
  together (the diagnostics page's 64rem, dashboard.css:2530-2537), or a
  trailing actions track on a full-bleed surface - reserved on the server list
  (dashboard.css:566-572), fixed on the settings rows so clean and modified
  rows share one explanation edge (settings.tsx:135-138).
- Breakpoints are container queries on the pane, never viewport media queries
  (dashboard.css:166-181). The one exception is the rail, whose question is the
  window's own width - and asking the pane would be circular
  (dashboard.css:3372-3395).
- Range syntax only: `width < N` and `width >= N` partition at N, where
  `max-width: N` and a `< N` variant disagree for exactly one pixel
  (dashboard.css:2883-2894). Components spell the same pair as the
  `@max-[Npx]/pane:` and `@min-[Npx]/pane:` variants, which compile to the two
  legal forms. The spelling is enforced, and every threshold is
  kept out of the band the rail's collapse makes ambiguous, by
  `src/test/bun/webview/dashboard/narrowThresholds.test.ts`.
- Reuse the existing tiers before minting a new one: 400, 560, 620, 640, 700,
  910, 920, and 1136 on the pane; 1000 on the window is the rail's alone.
- A derived sizing number carries its derivation in a comment, so the next
  editor re-derives instead of guessing: the models list's 1136 threshold
  arithmetic (dashboard.css:2295-2312), the rail collapse's own budget
  (dashboard.css:3372-3394), and the collapsed rail's 49-not-48
  (dashboard.css:3504-3513) are the canonical precedents.
- There is no preflight. Every control states what a UA stylesheet would
  otherwise supply - margin, box-sizing, font - and shared resets live once in
  theme.css's base layer, never as per-component patches (theme.css:19-56).
  The UA's checkbox margin (ui/checkbox.tsx:9-13), the rail's content-box
  drift (dashboard.css:68-73), and the 49-not-48 arithmetic above are what
  forgetting this costs.

## 8. Empty, loading, and error states

- A filter that matches nothing says so in the emptied surface itself - a
  colSpan cell inside the table body (diagnostics.tsx:1093-1101), or the list's
  own empty line (models.tsx:959-974; settings.tsx:1488) - with the way back
  beside it when this surface's own filters caused the nothing
  (models.tsx:962-964).
- Nothing configured yet is a guided card: a welcome, the steps in plain words,
  and the primary action (servers.tsx:1334-1346; dashboard.css:2189-2208).
- An absence that is not the reader's fault gets a sentence plus the reason
  (usage.tsx:5-9).
- Loading is a hint with `role="status"` (modelInspector.tsx:1035-1037); the
  first paint is a skeleton (app.tsx:315-336).
- An in-flight action marks the control that started it: a busy Save or Adopt
  carries the spinner naming the work (dashboard.css:1901-1914), and an Apply
  says so beside itself (recordEditors.tsx:284-296).
- A missing datum is a dim dash plus its reason, never a zero
  (dashboard.css:1659-1669; usage.tsx:604-609).
- Sections never appear or disappear under the reader: the clean state says so
  in a sentence rather than leaving a gap where a heading was
  (diagnostics.tsx:586-591).

## 9. Tone parity and forced colors

- Every member of a tone vocabulary carries comparable perceptual weight at the
  same nominal size: the warn triangle scales up because a triangle inside a
  circle's box reads a size smaller (dashboard.css:255-264), and severity rides
  hue, wash, AND geometry so it survives a reader who cannot separate red from
  amber (dashboard.css:698-704). A thin stroke may carry a state only as part
  of an ensemble beside its words (the muted ring, dashboard.css:268-271; the
  advisory dash, dashboard.css:738-750) - and a stroke that must survive forced
  colors never falls below 2px per strand, which is why the blocking tier's 4px
  `double` (two ~1.3px strands reading lighter than degraded's 2px solid)
  widens to 6px there (dashboard.css:718-727 and 751-770).
- Under forced colors, author colour is not a channel: every state that must
  survive there carries at least one of width, weight, shape, spacing, or a
  system colour keyword. The keyword clause is not a hedge -
  `Highlight`/`GrayText`/`Canvas`/`CanvasText` are the mode's own vocabulary
  and ARE the correct way to name a state there. Instances: the danger button's
  2px border plus weight (theme.css:73-86), the pressed filter pill's border
  width (dashboard.css:2118-2123), the one-shape-per-tone dots
  (dashboard.css:247-286), the severity rules' stroke geometry
  (dashboard.css:751-770), and the selected rail tab's Highlight edge bar
  (dashboard.css:3000-3014).
- A visually-hidden string never repairs a visual defect: forced-colors and
  high-contrast readers are sighted. Screen-reader text keeps the accessible
  tree whole when paint changes (rail.tsx:23-27); a defect in the paint is
  fixed in the paint.

## 10. Deliberate deviations

Frontend-design guidance written for landing pages and marketing surfaces -
including the design checklists reviewers bring - does not govern dashboards;
only its craft layer (alignment, rhythm, restraint) applies here. Two of its
common defaults are deliberately not followed:

- Labels sit in a right-aligned gutter beside their controls, the host Settings
  editor's idiom, not above the inputs; above-the-input appears only when the
  pane is too narrow for the gutter (settings.tsx:156-170;
  serverEditPage.tsx:417-421).
- Skeletons are for content and button spinners are for actions - two different
  jobs, not two treatments of one job (app.tsx:315-336;
  dashboard.css:1901-1914).
