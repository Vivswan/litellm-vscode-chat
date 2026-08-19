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

- One full-bleed template: a right-aligned label in a shared gutter, the
  control column, the explanation column growing with the pane, and a fixed
  trailing actions slot at the pane's right edge. The PAGE owns the wide
  tier's tracks and every row adopts them through subgrid
  (`settings.tsx SETTING_GRID_TRACKS`; `settings.tsx SETTING_ROW_GRID`), so
  the label gutter is one measured width that grows to the longest visible
  title instead of wrapping it, capped by the label cell's max-width so a
  pathological title cannot starve the control column
  (`settings.tsx SETTING_TITLE`). Below the stack threshold the row costs two
  lines, not three: the label turns left and keeps its control beside it, the
  description takes the line under them, and the actions pin to the row's
  top-right corner. Only under the 560px tier, where the widest controls
  cannot share a line with any title without overflowing the pane, does a
  row with such a control stack to one column; a compact control (a
  checkbox) keeps the title's line at every width.
- The description wears the hint measure, 72ch (`dashboard.css p.hint`'s own),
  as a reading cap inside its growing track: structure goes full-bleed, prose
  stops where lines stay readable (`settings.tsx setting-hint`). The one
  carve-out is a STATUS cluster standing in the description slot (the catalog
  row's counts, Refresh, and verdict): status is not prose, so it sheds the
  reading cap rather than wrap its own controls.
- The gutter marker is always present and transparent when clean, so marking a
  row modified never shifts it (`settings.tsx SettingRow`).
- An error COVERS the description, never displaces it: the description stays in
  flow, merely invisible, so the form's height does not change while you type
  (`settings.tsx SettingRow`).

### Form rows (slide-over panels, the server form)

- `.rows` owns the column tracks and each `.row` subgrids onto them
  (`dashboard.css .rows`); the matcher editor's field rows ride those same
  shared tracks, and its own `dashboard.css .matcher-editor .rows` adjusts
  only spacing, never the template.
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
  (`dashboard.css .server-row`), the two-step remove confirm - wider than that
  track - leaves the flow and covers the row's own cells rather than resizing
  anything (`dashboard.css .server-actions.armed`), a settings error covers
  the description instead of displacing it (`settings.tsx SettingRow`), a
  record card's validation verdict and its write refusal share an always-mounted
  slot over the footer row's free space - zero flex basis, so a message mounting
  there moves neither button group and a quiet footer stays exactly one row
  (`dashboard.css .editor-status`), and the reveal wrapper
  itself keeps the hidden control's box (opacity, not display). Reserving is
  the answer only where a line has somewhere of its own to sit: a per-row
  reservation cost every quiet ROW a blank strip, and a reserved footer band
  cost every quiet CARD one - the slot in the buttons' own row reserves
  nothing the row did not already have. Where nothing
  pre-exists to cover, the message's line is reserved outright: every field
  row mounts its one status slot whether or not it speaks
  (`dashboard.css .row .row-status`), the matcher editor's grammar reading and
  the JSON side door's verdict share the same rule
  (`dashboard.css .matcher-status`; `dashboard.css .json-status`), and a note
  whose sentence is known at rest holds its own box as an invisible spacing
  twin until it speaks - aria-hidden where opacity holds the box
  (`settings.tsx ModifiedNote`), or visibility-hidden, which removes the words
  from the accessibility tree itself (the server form's connection note,
  `serverEditPage.tsx connectionEdited`, and its label consequence notes,
  `serverEditPage.tsx rename-note`). In a prose zone
  the transient trails what is visible: nothing visible follows the "?" at
  rest, so the settings row's hover-only note renders after the glyph rather
  than holding a gap open mid-sentence (`settings.tsx ModifiedNote`) - and the
  row's help glyph is ONE live control at the visible sentence's tail
  (`settings.tsx glyphTrail`): a covering error joins the glyph's own inline
  flow while the resting text's invisible twin - aria-hidden and
  visibility-hidden, its copies inert - holds the cell's box
  (`settings.tsx SettingRow`), because a glyph painted through an overlay
  collides with the error's text in every theme and is buried whole under
  forced colors' text backplate - and a glyph remounted per tenant drops the
  keyboard focused on it.
- One placement per element class, zero exceptions within the class: an element
  class has exactly one home on its surface. Row actions sit in the reserved
  trailing track (`dashboard.css .server-row`; the settings rows' actions slot,
  `settings.tsx setting-actions`), section actions trail the header line
  (`dashboard.css .section-head .section-actions`) - except that a section
  whose ONLY content is its actions renders them as its body, because parked
  in the header slot of an otherwise empty section they read as tucked-away
  chrome (`settings.tsx settings-transfer`) - and the heading
  settings.json jump sits directly after the heading it opens, everywhere
  (`recordEditors.tsx HeadingRevealButton`). The Diagnostics page is the other
  section-actions exception, because a destination whose whole subject is
  acting on this install leads with its actions, and eight of them cannot
  share a header line: they open the body as one vertical list, tools first at
  the primary rank (section 9), with the Support links continuing the stack
  one rank quieter - the link hue's quiet tier at rest, so the escape hatches
  never outshine the actions above them
  (`diagnostics.tsx DiagnosticsSection`; `dashboard.css .feedback-links`).

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
  (`servers.tsx urlParts`).
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
  The registers' one ruled carve-out: these chips carry mono machine text on
  the soft fill, because they are controls, not labels - the fill is what says
  "these are the fields", and pointer or focus brings the border and input
  fill that prove the row editable (`recordEditors.tsx chipClass`). Outline
  plus mono stays the rule for inert machine text. The chip's two marks rank
  by a solid-vs-dashed channel of their own where forced colors repaints
  their red and amber borders: 2px solid reads invalid, 2px dashed
  reads hint (`theme.css .chip-field.hinted`).

Chip radius never mints a fresh literal. The named tokens live in theme.css
(`theme.css --radius-chip`, `theme.css --radius-pill`,
`theme.css --radius-field`, declared at runtime on `:root` beside `--radius`),
and every chip, pill, or field rule reads its token: the plain-CSS rules
through var(), and the tsx sites - the badge, the record editors' chips, and
the input, select, and textarea chrome - as var utilities
(`ui/badge.tsx rounded-(--radius-chip)`,
`ui/input.tsx rounded-(--radius-field)`) rather than restating the arithmetic.
The machine-text chips wear `--radius-chip`, and the filter bar's chrome wears
`--radius-pill` - the toggle pills and the dismissible server-scope chip
beside them (`dashboard.css .filter-pill`, `dashboard.css .chip`) - the one
near-pill radius that keeps that transient row reading as controls rather
than chips.

## 5. Disclosure

One idiom for detail that opens in place:

- A leading chevron rotates 90 degrees in 120ms and stands down under reduced
  motion, and the behavior has ONE embodiment: rotation, timing, and the
  reduced-motion stand-down all live on `dashboard.css .disclosure-chevron`,
  keyed off the disclosure button's own aria-expanded
  (`ui/disclosureChevron.tsx DisclosureChevron`).
  `dashboard.css .model-chevron` and `dashboard.css .server-chevron` are grid
  seats only, and the hidden-groups line under the server list is the idiom's
  third member (`dashboard.css .hidden-groups`).
- The whole readable block is the button, styled out of button chrome - the
  chevron is the part that says it opens
  (`dashboard.css button.model-disclosure`).
- The detail indents under a 2px accent left border tying it to its opener
  (`dashboard.css .model-detail`; the server drawer's copy at
  `dashboard.css .server-drawer`).
- Collapsed, a row keeps its ranked problem lines painted beneath it
  (`servers.tsx ServerDiagnosticLine` renders what
  `servers.tsx serverDiagnostics` ranks); expanded, the drawer carries the full
  inventory (`dashboard.css .server-drawer`). The warn-tier budget gloss is
  its own line class with its own single home, the drawer: between the user's
  warning and error thresholds the row's tinted meter already carries the
  signal, so the sentence LEADS the drawer's inventory as a fact-register row -
  the warn triangle plus tone-coloured text, never a band nested inside the
  drawer card (`servers.tsx DrawerNoticeLine`; `dashboard.css .drawer-notice`).
  A crossed error threshold or an overrun budget keeps its line on the
  collapsed surface and paints the error tier - the same presentation a
  blocking failure wears, because error-tier money reads as an error
  everywhere it renders - while the severity, the pill, and the hidden tier
  word keep carrying the rank
  (`servers.tsx usageDiagnostics` sets the tone; the lift is
  `problemBand.tsx bandTier`). A closed
  drawer keeps the gloss in the accessible tree - the
  meter's tone is colour, which a screen reader never gets
  (`servers.tsx drawerDiagnostics`).
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
    (`settings.tsx SettingRow`), and the server form covers the still-present
    hint the same way under one id, so the field's advice stays announced at
    rest and the error alone is announced while it stands
    (`serverEditPage.tsx errorId`);
  - row-level is a `.row-diagnostic` under the owning row
    (`dashboard.css .row-diagnostic`);
  - a refused setting write follows a fallback chain so it stays visible from
    any tab: the owning row first, named by the fail envelope itself (the
    extension derives the row from the refused payload,
    `src/dashboard/endpoints.ts settingWriteRow`; placement is
    `settings.tsx writeFailures`); a section-top line when the failure carries
    no row or the owning row is filter-hidden
    (`settings.tsx unclaimedFailure`); and a pane-top line while another tab
    is active, because a hidden subtree neither paints nor announces
    (`app.tsx awaySettingFailure`). Only executeCommand keeps a pane-top line
    always: it is posted from every tab and owns no row anywhere
    (`app.tsx PaneFailureLine`);
  - operation-level is a dismissible banner with `role="alert"`
    (`servers.tsx banner-error`; `dashboard.css .banner`);
  - success is a transient toast only where nothing updates in place - the
    three server intents (`app.tsx toastText`; `dashboard.css .toasts`); a
    setting edit's success IS the value visibly updating, and a record Apply
    reports beside its own button (`recordEditors.tsx ApplyStatus`).

## 7. Width

- Structure runs full-bleed to the pane; forms and prose are measured (the
  width-policy note on `dashboard.css .pane`, whose own 1560px cap is the one
  structural bound). Hints and setting descriptions share the 72ch measure
  (`dashboard.css p.hint`; `settings.tsx setting-hint`); a prose surface with
  its own reading problem states its own cap and why (the diagnostic
  headline's 84ch, `dashboard.css .row-diagnostic-headline`; the notice
  card's, `dashboard.css .notice p`).
- ONE right edge per surface, and for structural content that edge is the
  pane's: header and body share it by both running full-bleed - tables,
  lists, and rows fill the pane at every window size - with a trailing
  actions track where a row needs one, reserved on the server list
  (`dashboard.css .server-list`), fixed on the settings rows so clean and
  modified rows share one explanation edge (`settings.tsx SETTING_ROW_GRID`).
  The surface measure is retired for page bodies: the diagnostics page's
  64rem cap left ~500px of dead pane beside the resolution table at a ~2000px
  window, and `src/test/bun/webview/dashboard/styles/measure.test.ts` fails
  closed on its return - a resurrected `_MEASURE` constant, a capped section
  header, or a max-width landing on a structural surface - while pinning the
  prose reading caps still present.
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
- A missing datum is a dim dash plus its reason, never a zero - one embodiment,
  `ui/absent.tsx AbsentDatum` (`dashboard.css .model-inspector .absent`;
  `servers.tsx Absent` wraps the primitive in the facts' register). A SCANNED
  list is the carve-out: the model rows drop the absent segment whole, separator
  included, rather than repeating a placeholder down every row
  (`models.tsx priced`), and the filter pill that selects the class names it in
  words instead (`models.tsx priceFilterLabel`).
- Sections never appear or disappear under the reader: the clean state says so
  in a sentence rather than leaving a gap where a heading was
  (`diagnostics.tsx ConfigDiagnostics`).

## 9. Action colour

An action's colour is assigned by scenario, never per site, and the whole
vocabulary is declared once: the Button's variant map
(`ui/button.tsx buttonVariants`) for buttons, the link rules for anchors.
Flat grey is not in it - a control that carries WORDS and rests on the page's
prose colour reads as prose.

- Three hue families, one job each. The ACCENT is action: the primary rank
  rests on the readable tier, semibold (`theme.css --accent-text`), the
  supporting rank on the quiet tier (`theme.css --accent-quiet`), so a
  Save and the Edit beside it read as two volumes of one voice rather than
  two vocabularies. The ERROR hue is destructive: quiet at rest, so a Remove
  is tellable from its neighbours before the pointer arrives without putting
  a column of alarm down a calm table (`theme.css --err-quiet`). The theme's
  LINK colour is leaving the app: anchors wear it with the external glyph
  (`dashboard.css a.docs-link`), and links subordinated to a stack of actions
  rest on its quiet tier (`theme.css --link-quiet`;
  `dashboard.css .feedback-links`).
- A quiet tier is the hue leaned into a neutral, and WHICH neutral, in what
  share, is measured rather than assumed. The accent hues take the full
  foreground because the muted lean misses AA on the page itself - their blue
  is the darkest thing the dark page paints - and their share answers to the
  lightest surface a supporting action rests on, which is the error banner a
  Dismiss sits in rather than the page. The error hue on light takes the
  foreground too, where the derived muted tier is too light to carry a hue.
  The link hue keeps the muted lean, which clears every surface it lands on.
  The error hue on dark keeps it too, for a reason older than this
  measurement - a table of Removes has to stay calm - and pays 4.19:1 for it
  on a hovered row, named here rather than hidden.
- The readable tier is not derived here and carries misses of its own: the
  selected rail tab at 4.34:1, a warn band under an emphasized band action at
  4.49:1, the chip's fill at 4.05:1. Recorded as a sample rather than a
  census, because a prose list cannot stay exhaustive - what that tier wants
  is its own derivation pass, against the same surface enumeration this
  section applies to the quiet tiers.
- Contrast is therefore a floor to derive against, not the axis rank travels
  on. A supporting action carries LESS OF THE HUE than a primary one, and
  less weight, which is the axis that already separated the two ranks when
  the supporting one rested on flat grey. On a dark page it has to be: the
  accent hues are darker than the body text, so below the readable tier there
  is no compliant step down left to take.
- Hover strengthens AWAY from the surface, never toward the raw hue, because
  a hue gains no contrast on its own wash. Both accent ranks deepen to
  `theme.css --accent-strong`, derived against the deepest stack a label
  reaches - a hovered button on a chip, then one in an error banner, then one
  in a washed row - and danger to `theme.css --err-strong`, derived earlier
  against its own wash on the page. The subordinated links take the host's
  active link colour.
- Rank is the scenario's, not the label's: a surface whose whole content is
  its actions renders them at the primary rank (the settings transfer pair,
  `settings.tsx settings-transfer`; the Diagnostics tools,
  `diagnostics.tsx DiagnosticsTools`), while the same action on a crowded
  surface stays supporting - the rail's own Report a bug is a quiet compact
  secondary (`rail.tsx reportIssue`).
- High contrast pins all three RESTING quiet tiers to their plain hue (the HC
  block's `theme.css --accent-quiet`): a lean toward a neutral only dilutes,
  exactly where the reader chose legibility, and the hues named there are ones
  an HC theme guarantees. The hover tiers keep their derivation, because HC
  nulls the ghost wash and a rest tier equal to its hover tier would leave a
  hovered button with no feedback at all. Under forced colours author colour
  is not a channel, and the destructive rank rides width and weight instead
  (section 10).
- Three controls sit outside the vocabulary because a hue would say the wrong
  thing about them, and each already carries a mark colour is not doing: the
  help glyph is a bordered circle whose ring IS its affordance, and painting
  every heading's "?" accent would spend the accent on annotation
  (`dashboard.css button.help`); the model-ID catalog suggestions are listbox
  OPTIONS, not ranked actions, and their mark is the selection fill that says
  which one Enter takes (`dashboard.css .catalog-results button`); and the
  models list's sort direction is a bare arrow rather than an action, taking
  the plain foreground per site - the one place that is sanctioned - because
  at any quieter tier the ENABLED arrow read as its own disabled state
  (`models.tsx sort-dir`).

## 10. Tone parity and forced colors

- Every member of a tone vocabulary carries comparable perceptual weight at the
  same nominal size: the warn triangle scales up because a triangle inside a
  circle's box reads a size smaller (`dashboard.css .pill.tone-warn .dot`), and
  every problem band renders through ONE pipeline - `problemBand.tsx ProblemBand`
  turns a severity, plus the spend scale's one tier lift, into the band's whole
  presentation, and nothing else may mint the band classes
  (`src/test/bun/webview/dashboard/problemBandPipeline.test.ts`), because three
  hand-rolled band treatments once coexisted on one page as visible drift.
- In color modes every toned band wears the SAME 2px solid bar, and the tier
  rides hue plus the headline's text colour: error red for blocking failures
  and error-tier money alike, warn amber for degraded
  (`dashboard.css .row-diagnostic.tier-error`,
  `dashboard.css .row-diagnostic.tier-warn`); the advisory tier keeps its
  quieter 1px dash, no wash, and untinted text
  (`dashboard.css .row-diagnostic.tier-advisory`). Two "error" treatments with
  different bar weights on one page read as a mistake, not a rank: the ranking
  lives in the order, the pill, and the hidden tier word, and the headline
  alone takes the tier colour - detail lines stay muted everywhere a band
  renders (`dashboard.css .row-diagnostic-detail`). Deliberate trade, named:
  this spends the in-band geometry channel in color modes, so error against
  warn there rides hue alone for a red/amber-blind reader - on server rows
  the pill's one-shape-per-tone dot backstops the rank (section 4), and on
  the Diagnostics page, which renders bare bands, the worst-first order and
  the sentence itself carry it; the bordered modes below restore geometry
  outright.
- The bordered modes - forced colors, and the HC themes that never trip its
  media query - re-rank the tiers by stroke geometry, because that is exactly
  where hue and wash stop existing: 6px double over 2px solid over 1px dashed,
  more ink and a different shape per step, restated in both spellings (the
  `@media (forced-colors: active)` override and the
  `body.vscode-high-contrast` twins on
  `dashboard.css .row-diagnostic.tier-error`). The error tier is 6px because
  `double` cuts the width into three equal parts: a 4px double is two ~1.33px
  antialiased strands that read LIGHTER than the 2px solid below it - the
  loudest tier rendering quietest. One compensation formula keeps every tier's
  text on one x whatever width the rule takes
  (`dashboard.css --band-x`).
- The 2px state floor: a stroke that carries a state by itself never falls
  below 2px per strand, because thinner snaps to a hairline at some display
  densities - the muted ring meets it (`dashboard.css .pill.tone-muted .dot`),
  as does each strand of the bordered error tier's double. A stroke under the
  floor carries a state only as part of an ensemble beside its words: the
  advisory tier's 1px dash under its ranked sentence
  (`dashboard.css .row-diagnostic.tier-advisory`).
- Under forced colors, author colour is not a channel: every state that must
  survive there carries at least one of width, weight, shape, spacing, or a
  system colour keyword. The keyword clause is not a hedge -
  `Highlight`/`GrayText`/`Canvas`/`CanvasText` are the mode's own vocabulary
  and ARE the correct way to name a state there. Instances: the danger button's
  2px border plus weight
  (`theme.css [data-slot="button"][data-variant="danger"]`), the pressed filter
  pill's border width (`dashboard.css .filter-pill[aria-pressed="true"]`), the
  one-shape-per-tone dots (`dashboard.css .pill .dot`), the drawer notice's
  warn triangle - the tier as a shape, not only a colour
  (`servers.tsx DrawerNoticeLine`; `icons.tsx IconWarning`), the problem tone-text
  registers' wavy underline - the editor's own problem mark, worn by `.error`
  and `.state-warn`, never by `.state-ok`, because ok is not a problem
  (`theme.css .state-warn`) - the problem bands' bordered
  geometry ranking (`dashboard.css .row-diagnostic.tier-error`), and the
  selected rail tab's Highlight edge bar
  (`dashboard.css .rail-nav .rail-tab[aria-selected="true"]`).
- A visually-hidden string never repairs a visual defect: forced-colors and
  high-contrast readers are sighted. Screen-reader text keeps the accessible
  tree whole when paint changes (the collapse contract in `rail.tsx`); a defect
  in the paint is fixed in the paint.
- A standing failure is spoken once per failure, however many surfaces render
  its line: a bare `role="alert"` re-announces on every remount, so the role
  rides only the first render of each failure seq and stands down after - the
  visible line always renders, only the announcement dedupes
  (`announceOnce.tsx useAlertOnce`; carriers remount by keying the line on
  the seq, `app.tsx PaneFailureLine`).

## 11. Deliberate deviations

Frontend-design guidance written for landing pages and marketing surfaces -
including the design checklists reviewers bring - does not govern dashboards;
only its craft layer (alignment, rhythm, restraint) applies here. Two of its
common defaults are deliberately not followed:

- Labels sit in a right-aligned gutter beside their controls, the host Settings
  editor's idiom, not above the inputs. When the pane is too narrow for the
  gutter, a setting row turns its label left and keeps the control beside it on
  one line (`settings.tsx SETTING_TITLE`), while the forms stack the label
  above the input (`serverEditPage.tsx label-row`).
- Skeletons are for content and button spinners are for actions - two different
  jobs, not two treatments of one job (`app.tsx LoadingSkeleton`;
  `dashboard.css .spinner`).
