type JSONSchema = Record<string, unknown>

function valueType(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (Number.isInteger(value)) return "integer"
  return typeof value
}

export function validateJSONSchema(schema: JSONSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = []
  const expected = typeof schema.type === "string" ? schema.type : undefined
  const actual = valueType(value)
  if (expected && actual !== expected && !(expected === "number" && actual === "integer")) {
    return [`${path} must be ${expected}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of the declared enum values`)
  }
  if (expected === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
    required.forEach((key) => {
      if (!(key in record)) errors.push(`${path}.${key} is required`)
    })
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {}
    Object.entries(properties).forEach(([key, child]) => {
      if (key in record && child && typeof child === "object" && !Array.isArray(child)) {
        errors.push(...validateJSONSchema(child as JSONSchema, record[key], `${path}.${key}`))
      }
    })
    if (schema.additionalProperties === false) {
      Object.keys(record).filter((key) => !(key in properties)).forEach((key) => errors.push(`${path}.${key} is not allowed`))
    }
  }
  if (expected === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    value.forEach((item, index) => errors.push(...validateJSONSchema(schema.items as JSONSchema, item, `${path}[${index}]`)))
  }
  return errors
}
