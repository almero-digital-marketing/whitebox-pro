<script setup lang="ts">
// Campaign step — pick the campaign whose message this enrollment receives.
import PickList from './PickList.vue'
import type { StepEditorProps } from './index'

const props = defineProps<StepEditorProps>()

// mutate the passed-in draft config in place: it IS the step draft the pane's
// dirty-check compares against, so writing through is what enables Save.
const pick = (id: string) => { if (!props.disabled) props.config.campaign_id = id }
</script>

<template>
  <PickList label="Campaign" icon="send" :items="vocab.campaigns" :selected="config.campaign_id"
    :disabled="disabled" empty="No campaigns yet — create one in the Campaigns module." @pick="pick" />
</template>
