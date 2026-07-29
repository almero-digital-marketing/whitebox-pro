# UI conventions

- **Editor save/discard UI**: before adding or touching any editable-draft
  form with a Save action (profile fields, permissions, a builder, anything
  with a dirty/clean state), read
  [docs/adr/0001-editor-save-discard-pattern.md](docs/adr/0001-editor-save-discard-pattern.md)
  first and follow it. Don't invent a new save/discard interaction — every
  editor in this app (Users' profile/permissions/password, Audiences'
  builder) already follows one fixed pattern: Discard + Save always
  rendered, disabled (not hidden) when clean, a fading "Unsaved changes"
  note, Discard reverts to the last-saved state.
