// Shared error-toast sink. useToast() requires an active component setup context
// (it injects PrimeVue's ToastService), so it's called once from App.vue's own
// setup — the shell that's always mounted — and the returned instance is stashed
// here for Pinia stores and any component to call into afterward.
import type { useToast } from 'primevue/usetoast'

let toast: ReturnType<typeof useToast> | null = null

export function initToast(instance: ReturnType<typeof useToast>) {
  toast = instance
}

export function notifyError(message: string) {
  toast?.add({ severity: 'error', summary: 'Something went wrong', detail: message, life: 6000 })
}
