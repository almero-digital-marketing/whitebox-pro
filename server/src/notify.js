export default ({ webhooksConfig, events, webhooks, eventRegistry }) => {
  async function notify(type, payload) {
    await events.publish(type, payload)
    eventRegistry?.record(type, payload).catch(() => {})
    const key = type.split('.').pop()
    if (webhooksConfig?.[key]) {
      await webhooks.send({ ...webhooksConfig[key], data: payload })
    }
  }

  return { notify }
}
