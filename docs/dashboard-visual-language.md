# The dashboard's visual language

The rules the dashboard's surfaces follow, and where each one is embodied. This
is a contributor reference for building and reviewing dashboard UI; the code is
the source of truth, and when the two disagree, fix whichever is wrong rather
than letting them drift.

Citations are backticked and machine-checked
(`src/test/bun/docs/visualLanguageAnchors.test.ts` resolves every one): a
citation names a file, then an anchor in it - a selector or at-rule prelude
for a stylesheet (`dashboard.css .section-head .section-actions`), an
identifier or class-name token for a component
(`servers.tsx serverDiagnostics`). A bare backticked file name cites the whole
file. `dashboard.css` and `theme.css` live in `src/webview/dashboard/styles/`;
every other cited file resolves under `src/webview/dashboard/` unless it
starts with `src/`. Line numbers are banned - they rot with the next edit; an
anchor survives until the thing it names is renamed, and then the checker says
where.

## 1. Row anatomy

Three surface classes, each with one owner of its geometry.

### List rows (servers, models)

- Zone order along a row: chevron (only where the row opens), identity, machine
  text, verdict pill, numerics, badges, and a reserved actions track at the
  trailing edge. The server row is the full set: name, url, status, count,
  usage, badges, actions (`dashboard.css .server-row`).
- The LIST owns `grid-template-columns`; rows inherit it through subgrid
  (`dashboard.css .server-list` and its `dashboard.css .server-row`; the record
  matcher list's `dashboard.css .record-table` repeats the construction).
  Per-row auto tracks are banned: they size against one row's own content, so
  neighbours stop lining up and comparing values down the page - the reason
  the columns exist - stops working (the note on `dashboard.css .server-list`).
- Windowed lists cannot share tracks across a virtualized scrollport, so every
  row declares identical widths instead: the models list's columnar tier (the
  `width >= 1136px` rules on `dashboard.css button.model-disclosure`, under the
  "same track arithmetic" note) over fixed-height row lines
  (`dashboard.css .model-row-line`).

### Setting rows

- One full-bleed template: a right-aligned label in a fixed gutter, the control
  column, the explanation column growing with the pane, and a fixed trailing
  actions slot at the pane's right edge (`settings.tsx SETTING_ROW_GRID` and
  `settings.tsx SETTING_TITLE`).
- The description wears the hint measure, 72ch (`dashboard.css p.hint`'s own),
  as a reading cap inside its growing track: structure goes full-bleed, prose
  stops where lines stay readable (`settings.tsx setting-hint`).
- The gutter marker is always present and transparent when clean, so marking a
  row modified never shifts it (`settings.tsx SettingRow`).
- An error COVERS the description, never displaces it: the description stays in
  flow, merely invisible, so the form's height does not change while you type
  (`settings.tsx SettingRow`).

### Form rows (slide-over panels, the server form)

- `.rows` owns the column tracks and each `.row` subgrids onto them
  (`dashboard.css .rows`; the matcher editor's copy at
  `dashboard.css .matcher-editor .rows`).
- Rows stack to one column below the 700px pane tier
  (`dashboard.css .slide-over .rows`, in the `width < 700px` container block).

### Numeric columns vs phrase columns

- A NUMERIC column (bare numbers) right-aligns with tabular figures
  (`dashboard.css td.num`; the model inspector restates the rationale on
  `dashboard.css td.res-value.num`), and where rows do not share tracks its
  declared width carries a minimum so the figures still stack (the models
  list's columnar minimums on `dashboard.css button.model-disclosure`).
- A PHRASE column (numbers inside localized templates, units, or prose)
  left-aligns. The distinction is the content, not the position: right-aligning
  a word only pushes it away from the name it belongs to
  (`modelInspector.tsx ValueCell`), and a localized template's shape changes
  with the locale, so its right edge is not a stable alignment axis.

### Gaps and edge paddings measure ink

- A container's gap - and its own padding where a Button sits at its edge -
  measures ink-to-ink, never box-to-box: both Button sizes hand their
  horizontal padding back to the layout, so the label lines up with the text
  around it and only the hover fill overhangs
  (`ui/button.tsx buttonVariants`). The failure mode this rule names: a gap
  sized against the border box ships looking right in dark and collapses in
  forced colors, where the bordered modes zero the hand-back and the boxes
  the mode draws merge into one segmented control.
- The contract at a call site: overriding a Button's padding restates the
  hand-back beside it (`[--btn-mx:-0.25rem]` beside `px-1`), and a site pinned
  to a box rather than to its ink - an absolutely positioned close, the rail
  footer's glyph arithmetic - takes plain `mx-0`.
- A cluster whose bordered-mode fallback is tight restates the box separation
  those modes showed, as a forced-colors twin plus the high-contrast pair
  (`dashboard.css .server-actions`); the twins are pinned by
  `src/test/bun/webview/dashboard/styles/theme.test.ts`.

## 2. The reveal affordance

One idiom for actions that rest hidden on a row, and it has one home:
`ui/reveal.tsx`.

- A wrapper span carrying `opacity-0` - never `visibility`, which drops the
  control from the Tab order so `:focus-within` can never fire for it - with a
  120ms opacity transition, revealed by `group-hover` and `group-focus-within`,
  always painted below the 560px pane tier (hover does not exist on touch), and
  `motion-reduce:transition-none` (`ui/reveal.tsx Reveal`; the rationale also
  on `dashboard.css .server-actions`). The wrapper, not the button, carries the
  reveal, because the button's own disabled opacity would outrank it
  (`models.tsx model-row-actions`). A new reveal site uses the primitive or,
  where its group scope does not fit, copies an existing embodiment exactly - a
  variant spelling is a bug, not a house style.
- Revealing something never moves anything. A transient either has its space
  reserved or covers what it replaces: the server row's actions occupy a
  reserved track so revealing them cannot reflow the row
  (`dashboard.css .server-row`), a settings error covers the description
  instead of displacing it (`settings.tsx SettingRow`), and the reveal wrapper
  itself keeps the hidden control's box (opacity, not display). In a prose zone
  the transient trails what is visible: nothing visible follows the "?" at
  rest, so the settings row's hover-only note renders after the glyph rather
  than holding a gap open mid-sentence (`settings.tsx ModifiedNote`).
- One placement per element class, zero exceptions within the class: an element
  class has exactly one home on its surface. Row actions sit in the reserved
  trailing track (`dashboard.css .server-row`; the settings rows' actions slot,
  `settings.tsx setting-actions`), section actions trail the header line
  (`dashboard.css .section-head .section-actions`), and the heading
  settings.json jump sits directly after the heading it opens, everywhere
  (`recordEditors.tsx HeadingRevealButton`).

## 3. Annotations: what is visible at rest

- Visible at rest: identity, the value, a state SHAPE, and the row's problem
  lines beneath it - ranked worst first, each leading with one consequence
  sentence (`servers.tsx serverDiagnostics`). Everything else waits behind a
  tip, a disclosure, or an inspector.
- An annotation earns rest-visibility by being news. A User-scope setting value
  shows no note at rest - the gutter bar already says "set", and the scope is
  the expected one - while a workspace-scope value names its scope, the one
  case the bar cannot disambiguate (`settings.tsx ModifiedNote`). "Showing 3 of
  3" at rest is a tautology (`diagnostics.tsx ResolvedModels`); and when the
  narrow server row must shed something, the `https://` scheme goes first while
  insecure `http://` stays painted - insecure is news
  (`dashboard.css .server-url .url-scheme.quiet`).
- Exemption: debugging surfaces where provenance IS the content. The model
  inspector's whole vocabulary is provenance (`dashboard.css .model-inspector`),
  and the resolved-models table renders a provenance chip beside every value at
  rest (`diagnostics.tsx chip-prov`; `dashboard.css .chip-prov`).

## 4. Chips and pills

Two registers: a soft fill wraps prose words; an outline with the mono face
wraps machine text (the note on
`dashboard.css .model-inspector .inspector-orientation`). Five families, one
job each:

- Status pill: state, with one SHAPE per tone - circle ok, triangle warn,
  square error, hollow ring muted - because hue alone cannot rank the tones
  (`dashboard.css .pill .dot`).
- Badge: soft-fill prose facts beside names and counts
  (`ui/badge.tsx badgeVariants`).
- Filter pill: an outlined toggle, filled when pressed, with `aria-pressed`
  carrying the state (`dashboard.css .filter-pill`; `models.tsx FilterPill`).
- Provenance chip: outline plus mono, and never severity-toned - provenance
  says where a value came from, never whether that is a problem
  (`dashboard.css .chip-prov`, `dashboard.css .model-inspector .prov`, and
  `dashboard.css .row-diagnostic-where`).
- Field chip: a record row's key/value cell (`recordEditors.tsx chip-field`).

Chip radius never mints a fresh literal. The named tokens live in theme.css
(`theme.css --radius-chip`, `theme.css --radius-pill`,
`theme.css --radius-field`, declared at runtime on `:root` beside `--radius`),
and every plain-CSS chip, pill, or field rule reads its token: the machine-text
chips wear `--radius-chip` (the same arithmetic the `rounded-sm` utility bakes
in), and the toggle pills wear `--radius-pill`, the one near-pill radius that
makes filled-vs-outline read as a toggle rather than a chip.

## 5. Disclosure

One idiom for detail that opens in place:

- A leading chevron rotates 90 degrees in 120ms and stands down under reduced
  motion (`dashboard.css .model-chevron`; the server rows' copy at
  `dashboard.css .server-chevron`).
- The whole readable block is the button, styled out of button chrome - the
  chevron is the part that says it opens
  (`dashboard.css button.model-disclosure`).
- The detail indents under a 2px accent left border tying it to its opener
  (`dashboard.css .model-detail`; the server drawer's copy at
  `dashboard.css .server-drawer`).
- Collapsed, a row keeps its ranked problem lines painted beneath it
  (`servers.tsx ServerDiagnosticLine` renders what
  `servers.tsx serverDiagnostics` ranks); expanded, the drawer carries the full
  inventory (`dashboard.css .server-drawer`).
- Explanatory figures stay always open: a collapse nobody wants on the figure
  that explains the model is a click tax (`dashboard.css .record-tree-title`
  and `dashboard.css .model-inspector .page-section`).

## 6. Copy

- Descriptions are one or two short sentences, example first (the style note in
  `helpText.ts`), inside the 72ch hint measure (`dashboard.css p.hint`).
- A problem leads with ONE consequence sentence; technical detail rides a
  dimmed second line under it, and the guide lives behind Learn more
  (`dashboard.css .row-diagnostic-headline`;
  `diagnostics.tsx legacyProblemText`).
- Standing prose is a hint line, not a paragraph: the section's "?" carries the
  long explanation (`helpText.ts`), and counts and filter state ride the
  section header's meta slot (`ui/section.tsx SectionHeader`;
  `diagnostics.tsx ResolvedModels`).
- Before shipping copy, self-audit it: broken grammar, unclear referents,
  filler verbs, and cute-but-wrong phrasing all read fine to their author on
  the first pass.
- Error placement follows scope:
  - field-level stands in the description's slot: where the surface promises
    stable height it covers the still-present description
    (`settings.tsx SettingRow`), and the server form swaps hint for error under
    the same id so the field's advice stays announced
    (`serverEditPage.tsx errorId`);
  - row-level is a `.row-diagnostic` under the owning row
    (`dashboard.css .row-diagnostic`);
  - operation-level is a dismissible banner with `role="alert"`
    (`servers.tsx banner-error`; `dashboard.css .banner`);
  - success is a transient toast only where nothing updates in place - the
    three server intents (`app.tsx toastText`; `dashboard.css .toasts`); a
    setting edit's success IS the value visibly updating, and a record Apply
    reports beside its own button (`recordEditors.tsx ApplyStatus`).

## 7. Width

- Lists run full-bleed to the surface measure; forms and prose are measured
  (the width-policy note on `dashboard.css .pane`). Hints and setting
  descriptions share the 72ch measure (`dashboard.css p.hint`;
  `settings.tsx setting-hint`); a prose surface with its own reading problem
  states its own cap and why (the diagnostic headline's 84ch,
  `dashboard.css .row-diagnostic-headline`).
- ONE right edge per surface: either a shared measure worn by header and body
  together (the diagnostics page's 64rem, `diagnostics.tsx DIAGNOSTICS_MEASURE`
  and `dashboard.css .resolved-scroll`), or a trailing actions track on a
  full-bleed surface - reserved on the server list
  (`dashboard.css .server-list`), fixed on the settings rows so clean and
  modified rows share one explanation edge (`settings.tsx SETTING_ROW_GRID`).
- Breakpoints are container queries on the pane, never viewport media queries
  (`dashboard.css .pane`). The one exception is the rail, whose question is the
  window's own width - and asking the pane would be circular
  (`dashboard.css @media (width < 1000px)`).
- Range syntax only: `width < N` and `width >= N` partition at N, where
  `max-width: N` and a `< N` variant disagree for exactly one pixel (the
  range-syntax note on the matcher editor's stacking block,
  `dashboard.css @container pane (width < 700px)`). Components spell the same
  pair as the `@max-[Npx]/pane:` and `@min-[Npx]/pane:` variants, which compile
  to the two legal forms. The spelling is enforced, and every threshold is
  kept out of the band the rail's collapse makes ambiguous, by
  `src/test/bun/webview/dashboard/narrowThresholds.test.ts`.
- Reuse the existing tiers before minting a new one: 400, 560, 620, 640, 700,
  910, 920, and 1136 on the pane; 1000 on the window is the rail's alone.
- A derived sizing number carries its derivation in a comment, so the next
  editor re-derives instead of guessing: the models list's 1136 threshold
  arithmetic (above `dashboard.css @container pane (width >= 1136px)`), the
  rail collapse's own budget (`dashboard.css @media (width < 1000px)`), and the
  collapsed rail's 49-not-48 (`dashboard.css .slide-over`, in the rail's narrow
  block) are the canonical precedents.
- There is no preflight. Every control states what a UA stylesheet would
  otherwise supply - margin, box-sizing, font - and shared resets live once in
  theme.css's base layer, never as per-component patches
  (`theme.css @layer base`). The UA's checkbox margin (now a base-layer rule
  there), the rail's content-box drift (`dashboard.css .rail`), and the
  49-not-48 arithmetic above are what forgetting this costs.

## 8. Empty, loading, and error states

- A filter that matches nothing says so in the emptied surface itself - a
  colSpan cell inside the table body (`diagnostics.tsx colSpan`), or the list's
  own empty line (`models.tsx clearFilters`; `settings.tsx nothingMatches`) -
  with the way back beside it when this surface's own filters caused the
  nothing (`models.tsx clearFilters`).
- Nothing configured yet is a guided card: a welcome, the steps in plain words,
  and the primary action (`servers.tsx noServers`;
  `dashboard.css .empty-start`).
- An absence that is not the reader's fault gets a sentence plus the reason
  (`servers.tsx Absent` and its `Why`).
- Loading is a hint with `role="status"` (`modelInspector.tsx ModelInspector`);
  the first paint is a skeleton (`app.tsx LoadingSkeleton`).
- An in-flight action marks the control that started it: a busy Save or Adopt
  carries the spinner naming the work (`dashboard.css .spinner`), and an Apply
  says so beside itself (`recordEditors.tsx ApplyStatus`).
- A missing datum is a dim dash plus its reason, never a zero
  (`dashboard.css .model-inspector .absent`; `servers.tsx Absent`).
- Sections never appear or disappear under the reader: the clean state says so
  in a sentence rather than leaving a gap where a heading was
  (`diagnostics.tsx ConfigDiagnostics`).

## 9. Tone parity and forced colors

- Every member of a tone vocabulary carries comparable perceptual weight at the
  same nominal size: the warn triangle scales up because a triangle inside a
  circle's box reads a size smaller (`dashboard.css .pill.tone-warn .dot`), and
  severity rides hue, wash, AND geometry so it survives a reader who cannot
  separate red from amber (`dashboard.css .row-diagnostic`). A thin stroke may
  carry a state only as part of an ensemble beside its words (the muted ring,
  `dashboard.css .pill.tone-muted .dot`; the advisory dash,
  `dashboard.css .row-diagnostic.sev-advisory`) - and a stroke that must
  survive forced colors never falls below 2px per strand, which is why the
  blocking tier's 4px `double` (two ~1.3px strands reading lighter than
  degraded's 2px solid) widens to 6px there
  (`dashboard.css .row-diagnostic.sev-blocking`, base and forced-colors rules).
- Under forced colors, author colour is not a channel: every state that must
  survive there carries at least one of width, weight, shape, spacing, or a
  system colour keyword. The keyword clause is not a hedge -
  `Highlight`/`GrayText`/`Canvas`/`CanvasText` are the mode's own vocabulary
  and ARE the correct way to name a state there. Instances: the danger button's
  2px border plus weight
  (`theme.css [data-slot="button"][data-variant="danger"]`), the pressed filter
  pill's border width (`dashboard.css .filter-pill[aria-pressed="true"]`), the
  one-shape-per-tone dots (`dashboard.css .pill .dot`), the severity rules'
  stroke geometry (`dashboard.css .row-diagnostic.sev-blocking`), and the
  selected rail tab's Highlight edge bar
  (`dashboard.css .rail-nav .rail-tab[aria-selected="true"]`).
- A visually-hidden string never repairs a visual defect: forced-colors and
  high-contrast readers are sighted. Screen-reader text keeps the accessible
  tree whole when paint changes (the collapse contract in `rail.tsx`); a defect
  in the paint is fixed in the paint.

## 10. Deliberate deviations

Frontend-design guidance written for landing pages and marketing surfaces -
including the design checklists reviewers bring - does not govern dashboards;
only its craft layer (alignment, rhythm, restraint) applies here. Two of its
common defaults are deliberately not followed:

- Labels sit in a right-aligned gutter beside their controls, the host Settings
  editor's idiom, not above the inputs; above-the-input appears only when the
  pane is too narrow for the gutter (`settings.tsx SETTING_TITLE`;
  `serverEditPage.tsx label-row`).
- Skeletons are for content and button spinners are for actions - two different
  jobs, not two treatments of one job (`app.tsx LoadingSkeleton`;
  `dashboard.css .spinner`).
