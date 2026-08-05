<script setup lang="ts">
// Shown when a module's chunk FAILS to load — a dropped connection, a proxy that mangled the
// response, or a truncated copy sitting in the browser cache.
//
// This exists because of a real incident: before modules were split, the console was one
// 3.9 MB script served `immutable`, a browser held a partial copy, and the result was a blank
// page with nothing on screen and nothing in the log to explain it. Splitting made that
// failure smaller — one pane instead of the whole app — but "smaller and still silent" is not
// much better, so it now says what happened.
//
// The hard-reload hint is not boilerplate: `immutable` means an ordinary reload can serve the
// same broken bytes again, which is precisely why the original bug looked like a server fault.
// JS cannot clear the HTTP cache, so the honest thing is to say so.
defineProps<{ label?: string }>()

// Exposed explicitly: Vue template expressions resolve against the render context plus a
// WHITELIST of globals (Math, Date, JSON, console…), and `location` is not on it — so
// `@click="reload"` would silently be a call on undefined.
const reload = () => window.location.reload()
</script>

<template>
  <div class="module-error" role="alert">
    <span class="material-symbols-outlined">cloud_off</span>
    <p class="title">Couldn’t load {{ label || 'this module' }}</p>
    <p class="hint">
      The download didn’t finish. Reload to try again — if it keeps failing, a hard reload
      (<kbd>⇧</kbd>+reload) clears a partly-cached copy.
    </p>
    <button class="retry" @click="reload">Reload</button>
  </div>
</template>

<style scoped>
.module-error {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; height: 100%; padding: 24px; text-align: center; color: var(--text);
}
.material-symbols-outlined { font-size: 28px; color: var(--text); opacity: .5; }
.title { margin: 0; font-size: 14px; color: var(--text-strong); }
.hint { margin: 0; max-width: 340px; font-size: 12.5px; line-height: 1.5; color: var(--text); opacity: .75; }
kbd {
  font: inherit; padding: 0 4px; border: 1px solid var(--border-2);
  border-radius: 4px; background: var(--panel);
}
.retry {
  margin-top: 6px; padding: 7px 14px; border: none; border-radius: 8px;
  background: var(--accent); color: var(--p-primary-contrast-color, #fff);
  font-size: 13px; cursor: pointer;
}
.retry:hover { opacity: .92; }
</style>
