<script setup lang="ts">
// Shown while a module's chunk downloads. Modules load on demand (see modules.ts), and the
// heavy ones are large — Campaigns carries tinymce and codemirror — so on a first open there
// is a real gap that would otherwise be an empty pane.
//
// It only ever appears ONCE per module per session: App.vue wraps the module host in
// <keep-alive>, so a module that has loaded stays mounted and switching back to it is
// instant.
defineProps<{ label?: string }>()
</script>

<template>
  <div class="module-loading" role="status" aria-live="polite">
    <div class="spinner" />
    <p>Loading{{ label ? ` ${label}` : '' }}…</p>
  </div>
</template>

<style scoped>
.module-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; height: 100%; color: var(--text);
}
.spinner {
  width: 22px; height: 22px; border-radius: 50%;
  /* Two-tone ring rather than a filled shape: it reads as motion at 22px, where a spinning
     glyph just looks like it is vibrating. */
  border: 2px solid var(--border-2);
  border-top-color: var(--accent);
  animation: spin .7s linear infinite;
}
.module-loading p { margin: 0; font-size: 13px; color: var(--text); }
@keyframes spin { to { transform: rotate(360deg) } }

/* Respect the OS setting: a perpetual spinner is exactly the kind of motion this asks to
   stop. The ring stays as a static progress affordance. */
@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
}
</style>
