<script setup lang="ts">
// Lands here after the /authorize redirect, either ?code=&state= (success)
// or ?error=&state= (server-plugin-oauth's redirectWithError, e.g. wrong
// password). Exchanges the code for tokens via a plain JSON fetch — this leg
// doesn't need a real navigation the way /authorize's login form does.
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const message = ref('Signing you in…')

onMounted(async () => {
  const code = route.query.code as string | undefined
  const state = route.query.state as string | undefined
  if (!code) {
    router.replace({ path: '/login', query: { error: '1' } })
    return
  }
  try {
    await authStore.completeLogin(code, state || '')
    router.replace('/')
  } catch (e: any) {
    message.value = e.message
    setTimeout(() => router.replace({ path: '/login', query: { error: '1' } }), 800)
  }
})
</script>

<template>
  <div class="callback-screen">{{ message }}</div>
</template>

<style scoped>
.callback-screen { display: grid; place-items: center; height: 100vh; color: var(--muted); font-size: 14px; }
</style>
