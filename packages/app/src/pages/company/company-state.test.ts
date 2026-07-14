import { describe, expect, test } from "bun:test"
import {
  canSubmit,
  createDraft,
  reduceDraft,
  restoreDraft,
  serializeDraft,
  type CompanyDraftAction,
} from "./company-state"

describe("company bootstrap draft", () => {
  test("starts balanced and becomes submittable only with provider, model and inspected git", () => {
    const initial = createDraft("018f84f8-9c21-7d4d-a850-d63f8f9344cc")
    expect(initial.approval_preset).toBe("balanced")
    expect(canSubmit(initial)).toBe(false)
    const actions = [
      { type: "provider.selected", provider_id: "openai", model_id: "gpt-5" },
      {
        type: "repository.inspected",
        repository: {
          project_id: "project-1",
          root_path: "/repo",
          default_branch: "main",
          bootstrap_head_commit: "abc",
          dirty: false,
        },
      },
    ] satisfies CompanyDraftAction[]
    const ready = actions.reduce(reduceDraft, initial)
    expect(canSubmit(ready)).toBe(true)
  })

  test("does not persist provider secrets in draft", () => {
    const draft = {
      ...createDraft("018f84f8-9c21-7d4d-a850-d63f8f9344cc"),
      provider_id: "openai",
      model_id: "gpt-5",
      api_key: "must-not-persist",
    }
    const saved = serializeDraft(draft)
    expect(saved).not.toContain("must-not-persist")
    expect(restoreDraft(saved)).toMatchObject({
      request_id: "018f84f8-9c21-7d4d-a850-d63f8f9344cc",
      provider_id: "openai",
      model_id: "gpt-5",
    })
  })
})
