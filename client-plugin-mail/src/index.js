// Mail plugin — submits contact-form data to whitebox-pro-server's POST /mail/inbox.
// The route is public on the server, so no auth header is required.

export default function mailPlugin() {
  return {
    name: 'mail',
    install(core) {
      const { http, queue, logger } = core

      async function submit({ from, subject, body, files, to, data } = {}) {
        if (!from)    throw new Error('mail.submit: `from` is required')
        if (!subject) throw new Error('mail.submit: `subject` is required')

        return queue(async () => {
          // This one REJECTS on failure, unlike the fire-and-forget plugins
          // (conversions, engagement, crm all catch and warn). Deliberate, and the
          // difference is who is waiting: submit() backs a contact form that a person
          // just filled in and pressed send on. Swallowing a failed submit would show
          // them a success they did not get, and lose their message. The caller is
          // awaiting this and needs to be able to say "that didn't send, try again".
          //
          // If a future pass is making the client resilient to an unreachable server,
          // this is the call that must keep throwing.
          //
          // If files are provided, send as multipart so multer parses them server-side.
          // Otherwise plain JSON.
          if (files && files.length) {
            const fd = new FormData()
            fd.append('from', from)
            fd.append('subject', subject)
            if (body) fd.append('body', body)
            if (to) fd.append('to', to)
            if (data) fd.append('data', JSON.stringify(data))
            for (const f of files) fd.append('files', f, f.name)
            return http.request('/mail/inbox', { method: 'POST', body: fd })
          }

          return http.request('/mail/inbox', {
            method: 'POST',
            body: { from, subject, body, to, data },
          })
        })
      }

      core.attach('mail', { submit })
    },
  }
}
