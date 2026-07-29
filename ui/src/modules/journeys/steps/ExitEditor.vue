<script setup lang="ts">
// Exit step — end the enrollment, optionally recording why.
import InputText from 'primevue/inputtext'
import './step-editor.css'
import type { StepEditorProps } from './index'

defineProps<StepEditorProps>()
</script>

<template>
  <label class="fld"><span class="fld-l">Reason (optional)</span>
    <InputText v-model="config.reason" class="full" :disabled="disabled" />
  </label>
</template>
