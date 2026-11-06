// The session mention a DSH message carries: `@[label](dsh-session:<base64url of the JSON
// session id>)`, with `\` and `]` escaped in the label. The at-menu test checks that what
// ds-bot writes and reads is that form.

const escapeLabel = label => String(label).replace(/[\\\]]/g, mark => `\\${mark}`)
const unescapeLabel = label => label.replace(/\\([\\\]])/g, '$1')

export function formatSessionReferenceMention({ sessionId, label }) {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  return `@[${escapeLabel(label)}](dsh-session:${payload})`
}

const MENTION = /@\[((?:\\.|[^\\\]])*)\]\(dsh-session:([A-Za-z0-9_-]+)\)/g

export function parseSessionReferenceText(text) {
  const references = []
  const plain = String(text).replace(MENTION, (mention, label, payload) => {
    let sessionId
    try {
      sessionId = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      return mention
    }
    if (typeof sessionId !== 'string') return mention
    const readable = unescapeLabel(label)
    references.push({ sessionId, label: readable })
    return `@${readable}`
  })
  return { text: plain, references }
}
