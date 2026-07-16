import { describe, expect, test } from "bun:test"
import { validateJSONSchema } from "../../src/workflow/schema"

describe("Workflow output schema", () => {
  test("accepts a matching structured result", () => {
    expect(
      validateJSONSchema(
        { type: "object", required: ["decision"], properties: { decision: { enum: ["approve", "reject"] } } },
        { decision: "approve" },
      ),
    ).toEqual([])
  })

  test("reports required and type violations", () => {
    expect(
      validateJSONSchema(
        { type: "object", required: ["passed"], properties: { passed: { type: "boolean" } } },
        { passed: "yes" },
      ),
    ).toContain("$.passed must be boolean")
    expect(validateJSONSchema({ type: "object", required: ["passed"] }, {})).toContain("$.passed is required")
  })
})
