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
  <span class="save-note" :class="{ 'save-note--hidden': !isDirty }">
    <i class="pi pi-circle-fill" /> Unsaved changes
  </span>
  <Button label="Discard" text severity="secondary" size="small"
          :disabled="!isDirty" @click="discard" />
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
6. **`.save-bar` vs `.actions`:** both classes render the same
   note+discard+save row and behave identically. Which one to use is
   purely about whether something *else* already owns the divider above
   this row:
   - Use `.save-bar` (no border of its own) when this row is followed by
     another section that already has its own `border-top` (so `.save-bar`
     stacking its own `border-bottom` on top would double the divider —
     see ui/src/modules/users/Users.vue's `.password-block`/`.meta`).
   - Use `.actions` (has its own `border-top`) when this row is the last
     element in the panel, with nothing below it to provide a divider.

`.save-note` / `.save-note--hidden` are plain CSS, duplicated verbatim in
each SFC's `<style scoped>` block (Vue scoped styles don't share across
files) — keep the values identical across components rather than
introducing per-module variations.

## Reference implementations

- `ui/src/modules/users/Users.vue` — three editors in one file, all
  following this shape: profile fields (`.save-bar`), the password
  change block (`.save-bar`), and the permissions panel (`.actions`,
  since it's the last element in that pane).
- `ui/src/modules/audiences/Audiences.vue` — the builder's `.b-actions`
  (also last-element-in-panel, hence no border needed since `.b-actions`
  itself carries no divider — see that file for the exact rule) plus
  `discardAudience()` for the revert-to-last-saved-or-clear-to-blank logic.

## Consequences

- A new editor in any module should copy this shape directly rather than
  inventing a new save/discard UI. If a genuinely new variant seems
  necessary, update this ADR rather than letting a fourth pattern
  accumulate silently.
- Every editor now costs one extra function (a `discard`/`reset` handler)
  it might not have had before — this is deliberate; "no way to discard"
  is the specific defect this decision closes.
