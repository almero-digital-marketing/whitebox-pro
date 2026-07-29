<script setup lang="ts">
// Add to List step — put this enrollment's passport on a static list.
//
// Only LIST segments are offered. The other two segment sources (`select`,
// `funnel`) are QUERIES: their membership is recomputed from a predicate on
// every resolve, so a step that "added" someone to one would be undone by the
// next sweep. The audiences service rejects it; this doesn't offer it.
import { computed } from 'vue'
import PickList from './PickList.vue'
import type { StepEditorProps } from './index'

const props = defineProps<StepEditorProps>()

const lists = computed(() => props.vocab.lists || [])
const pick = (id: string) => { if (!props.disabled) props.config.segment_id = id }
</script>

<template>
  <!-- `checklist` is the same glyph Audiences and People's Lists panel use for
       a static list, so one kind of thing reads the same in all three -->
  <PickList label="List" icon="checklist" :items="lists" :selected="config.segment_id"
    :disabled="disabled"
    empty="No static lists yet — create one from a person's Lists panel in People."
    @pick="pick" />
</template>
