# 0001 — Editor save/discard pattern

## Status

Accepted.

## Context

Every module in this UI (Users, Audiences, Campaigns, ...) has at least one
"editor": a form buffered in a local draft that a person edits and then
commits with a Save action. Before this decision, three different editors
had independently invented three different UIs for the same concept:

- Users' profile fields: the whole save row (`v-if="profileDirty"`) vanished
  entirely when the draft was clean, and reappeared only once dirty.
- Users' permissions panel: a single "Save permissions" button, disabled
  when clean — but no way to discard an in-progress change at all.
- Audiences' builder: a single contextual button ("Save changes" /
  "Create audience"), disabled when clean, plus a `.b-saved` checkmark
  shown *after* a successful save — also no discard.

None of these agreed on whether the save affordance should be hidden or
disabled at rest, none but the first had any discard capability, and the
"is this saved?" signal was communicated three different ways (bar
presence, a checkmark, or nothing). A person moving between modules got a
different interaction contract in each one, and a new editor added to any
module had no single existing pattern to copy.

## Decision

Every editor's save/discard row follows one fixed shape, in this order:

```html
<div class="save-bar">  <!-- or .actions, if this is the last element in the
                              panel and needs its own border-top divider —
                              see the CSS note below -->
  <Button label="Discard" text severity="secondary" size="small"
          :disabled="!isDirty" @click="discard" />
  <span class="save-note" :class="{ 'save-note--hidden': !isDirty }">
    <i class="pi pi-circle-fill" /> Unsaved changes
  </span>
  <Button label="<contextual action label>" size="small"
          :disabled="!isDirty || <any other real precondition>"
          :loading="saving" @click="save" />
</div>
```

Rules this encodes:

1. **The row is always rendered — never `v-if`'d away when clean.** Both
   buttons stay in place and just become `:disabled` at rest. A control
   that disappears when you might need it (to confirm nothing's pending,
   or to re-check what Discard would do) is worse than one that's simply
   inert.
2. **Discard is mandatory, not optional**, even where the module didn't
   have one before (permissions, audiences). "You can only go forward or
   abandon the page" is not an acceptable editing experience once a Save
   button exists.
3. **The "Unsaved changes" note communicates dirty state, not save
   success.** There is no separate "saved ✓" confirmation anywhere —
   the note disappearing (and the buttons going disabled) *is* the
   confirmation. Don't add a second, redundant signal for the same fact.
4. **The note hides via `visibility: hidden`, never `display: none` or
   `v-if`.** It must keep occupying its layout space so the row's height
   doesn't jump when dirty state flips — that space is also what pushes
   the buttons to the right (`.save-note`'s `margin-right: auto` needs
   the element to still be in flow).
5. **Discard reverts to the actual last-known-server state**, not just
   "whatever the fields looked like on mount." For an existing entity,
   re-derive the draft from the store's row (the same function used to
   load it the first time — e.g. `resetDraft()` / `loadPermDraft()` /
   `openAudience(found)`). For an entity that was never saved (a brand
   new draft, `id === null`), Discard clears it back to blank (e.g.
   `newAudience()`) — there is no "last saved state" to revert to.
6. **`.save-bar` vs `.actions`/`.b-actions`:** all these classes render the
   same note+discard+save row and behave identically. Which to use is
   purely about whether something *else* already owns the divider above
   this row:
   - Use `.save-bar` (no border of its own) when this row is followed by
     another section that already has its own `border-top` (so `.save-bar`
     stacking its own `border-bottom` on top would double the divider —
     see ui/src/modules/users/Users.vue's `.password-block`/`.meta`).
   - Use `.actions`/`.b-actions` (has its own `border-top`) when this row
     is the last element in the panel, with nothing below it to provide a
     divider. This is the common case — every reference implementation
     below except the two `.save-bar` rows in Users.vue uses this variant.
7. **A right-pane row (a secondary/side pane, not the center pane) always
   uses the `.actions`/`.b-actions` variant, never `.save-bar`, and its
   buttons never carry an icon.** Spacing is `margin-top: 16px`,
   `padding-top: 14px`, `gap: 10px` (copy these verbatim; see
   `.usr-side .b-actions` or `.ppl-console .b-actions` for the override
   shape when the row lives inside a scrolling/accordion container rather
   than a fixed-height pane). Icons are dropped in this variant even where
   the equivalent center-pane button has one (compare
   `.usr-doc .b-actions`'s Save, which has a check icon, against
   `.usr-side .b-actions`'s Publish, which doesn't) — the row's position
   already makes its purpose unambiguous.

   **No `border-top`.** This rule used to require one, on the reasoning
   that a scrolling pane isn't guaranteed to terminate visually the way a
   fixed center-pane bar does. In an ACCORDION — which is what every right
   pane in this app now is — that doesn't hold: the next panel's header
   already draws a `border-top` a few pixels below, so the row's own rule
   was a second line doing the same job. In a short panel with a hint
   paragraph above the buttons it put three horizontal rules into one
   small box. The `margin-top` alone separates the row from the fields.
   Changed in `.ppl-console .b-actions` and `.usr-side .b-actions`; the
   center-pane variants (`.usr-doc`, Campaigns, Audiences) keep theirs,
   because there a fixed bar genuinely does terminate the pane.
8. **"Discard" is reserved for revert-in-place.** Use it only when the
   editor stays open and its fields snap back to the last-known state
   (rule 5). Where the equivalent action instead closes or unmounts the
   whole editor — no "still open but reverted" state exists to land on
   (e.g. Analytics' `QueryBuilder.vue` Cancel, which backs out to the
   Agent tab entirely) — keep the verb that actually describes it instead
   of relabeling it "Discard" for row-shape consistency. Everything else
   about the row (spacing, border, dirty note, Save-side disabled logic)
   still applies identically regardless of which verb this button uses.
9. **In a right-pane row, every button is `flex-shrink: 0`; `.save-note`
   is the row's one flexible element**, via `flex: 1 1 auto; min-width: 0`
   — not the base `.save-note` rule's plain `margin-right: auto`, and not
   a fixed pixel gap or the `:first-child`-gets-`margin-right:auto` trick
   used by wider center-pane rows. `flex: 1 1 auto` still grows to push
   the Save-side buttons to the right when there's slack (same visual
   result as the plain auto-margin), but — critically — can also *shrink*,
   even wrapping the note's own "Unsaved changes" text onto a second line,
   if the row's total content ever exceeds the pane's width. That
   combination (a long contextual Save label, e.g. "Add to report",
   appearing alongside the note) is a real, recurring case in a 400px-wide
   pane, not a hypothetical: without `flex-shrink:0` on the buttons, the
   default flex-shrink instead squeezes a *button* narrower than its own
   label needs, wrapping the button's text — visually broken in a way a
   plain descriptive label reflowing is not. Never chase this by hand-
   tuning a gap/margin pixel value to "just barely fit at 1280px" — that
   silently breaks again the moment a label or pane width changes; flex
   grow+shrink on the note is the one fix that holds at any width.

10. **Right-pane field/section title labels — the small uppercase "eyebrow"
    labels above a field or group, e.g. "Target", "Topic", "Conditions",
    "Campaign", "Audience" — never carry a leading icon**, same reasoning as
    rule 7's button icons: the label's position and text already make its
    purpose unambiguous, so a decorative icon is pure noise. This was an
    inconsistency, not a deliberate design split — Journeys/Users/Campaigns/
    Audiences' own field labels (`.fld-l`, `.event-group-label`, and every
    other module-local eyebrow-label class) never had icons; only
    Analytics' query-builder field components (`.lab`) and
    `ConditionsBuilder.vue`'s `.cb-title` had drifted into adding them.
    Removed for consistency with the rest of the app, not added elsewhere.

11. **In a centre bottom bar, the negative action goes hard left.**
    Discard is the first child, before `.save-note` — so the flexible note
    pushes the confirming action(s) to the right and the row reads
    *destructive … reversible … commit* across the pane. This separates the
    two by the full width of the bar, which is the point: Discard and Save
    are adjacent in intent but opposite in consequence, and a 10px gap is
    the only thing that was distinguishing them.
    Where the negative action is a Cancel rather than a Discard (rule 8) the
    same placement applies. Where the row has no `.save-note` to do the
    pushing — Users' invite form, which has no dirty state to report — the
    spacer is explicit: `.actions > .p-button:first-child { margin-right:
    auto }`. Where a destructive *record* action also exists (Users' profile
    row's "Remove"), it stays leftmost and Discard follows it, grouping both
    negatives.
    **Right panes keep the note-first order** (`.save-note`, Discard,
    action). They're 400px, not a full pane width, so hard-left placement
    reads as a stray button rather than a deliberate separation — and rule
    9's shrink behaviour depends on the note being the flexible element
    between the pane edge and the buttons.

`.save-note` / `.save-note--hidden` are plain CSS, duplicated verbatim in
each SFC's `<style scoped>` block (or, for Analytics' non-scoped `qb.css`,
under its `.qb` root) — Vue scoped styles don't share across files, so
keep the values identical across components rather than introducing
per-module variations.

## Reference implementations

- `ui/src/modules/users/Users.vue` — three editors in one file: profile
  fields (`.save-bar`), the password change block (`.save-bar`), and the
  permissions panel (`.actions`, last element in that pane) — all in the
  center `.usr-doc` pane (this center-pane row still uses the
  `:first-child`-gets-`margin-right:auto` trick at Users.vue:440-441,
  since its leading element varies — Remove is present or not). Its
  separate right-side `.usr-side` permissions pane is the canonical
  right-pane example (rules 7 and 9): `.usr-side .b-actions` /
  `.usr-side .save-note` at Users.vue:449-451.
- `ui/src/modules/audiences/Audiences.vue` — the builder's `.b-actions`
  (last-element-in-panel, `border-top` per rule 6) plus `discardAudience()`
  for the revert-to-last-saved-or-clear-to-blank logic.
- `ui/src/modules/journeys/Journeys.vue` — the Node editor accordion
  panel's `.b-actions` (right pane, rules 7 and 9): border-top inherited
  unmodified from the shared base `.b-actions` rule (Journeys.vue:895),
  spacing + the flex-shrink/flex-grow split overridden per-pane via
  `.jrn-accordion .b-actions` / `.jrn-accordion .save-note`
  (Journeys.vue:815-822).
- `ui/src/modules/analytics/components/QueryBuilder.vue` /
  `query/qb.css` — the Query tab's `.qb-actions` (right pane, rules 7 and
  9 — the one place rule 9's shrink/wrap case is hit in practice, since
  "Add to report" is long enough to overflow a 400px pane alongside the
  note): Cancel (rule 8's close-not-discard case) + Run (a domain-specific
  preview action, not part of this pattern) + Save/"Add to report". Its
  `dirty` computed just wraps `useQueryModel`'s already-existing
  `isDirty()` reactively so the shared `.save-note` can bind to it.

## Consequences

- A new editor in any module should copy this shape directly rather than
  inventing a new save/discard UI. If a genuinely new variant seems
  necessary, update this ADR rather than letting a fourth pattern
  accumulate silently.
- Every editor now costs one extra function (a `discard`/`reset` handler)
  it might not have had before — this is deliberate; "no way to discard"
  is the specific defect this decision closes.
- Rules 7 and 8 were added after an audit of every right-pane action row in
  the app (Users, Audiences, Campaigns, Journeys, Analytics) turned up
  exactly the drift this ADR exists to prevent: Analytics' `QueryBuilder.vue`
  had independently shipped its own `.qb-actions` row with no border, no
  dirty-state note, and 8px/16px spacing instead of the established
  10px/16px/14px — a fourth pattern accumulating silently, per the warning
  above. It's been brought in line and the exact right-pane shape (rule 7)
  and the Discard-vs-domain-verb distinction (rule 8) were written down so
  the next new editor copies a documented rule instead of copying
  whichever nearby component happened to be open at the time.
- Rule 10 came from the same kind of audit, scoped to field/section title
  labels instead of action rows: Analytics' query-builder field components
  (`.lab`) and `ConditionsBuilder.vue`'s `.cb-title` had leading icons
  (flag/explore/bolt/tune/etc.) that no other module's right-pane field
  labels carried. Removed rather than added everywhere, since the
  icon-less version was already the app-wide majority.
