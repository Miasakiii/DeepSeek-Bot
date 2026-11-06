// A tool spec as DSH's tool runtime reads it: the parameter map becomes a JSON schema,
// the entries marked required are listed, and the rest is kept as given.
export function defineTool({ name, description, parameters = {}, output, execute }) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...schema } = spec ?? {}
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  return {
    name,
    description,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output,
    execute,
  }
}
