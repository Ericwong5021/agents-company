import {
  ValidationPolicyDecision,
  ValidationPolicyInput,
  type ValidationPolicyInput as ValidationPolicyInputValue,
} from "./schema"

export function validationPolicy(raw: ValidationPolicyInputValue) {
  const input = ValidationPolicyInput.parse(raw)
  if (input.external_side_effect) {
    return ValidationPolicyDecision.parse({
      validation_mode: "review_and_user_gate",
      reviewer_required: true,
      user_gate_required: true,
    })
  }
  if (input.risk_level === "high" || !input.deterministic_anchors) {
    return ValidationPolicyDecision.parse({
      validation_mode: "independent_review",
      reviewer_required: true,
      user_gate_required: false,
    })
  }
  return ValidationPolicyDecision.parse({
    validation_mode: "machine",
    reviewer_required: false,
    user_gate_required: false,
  })
}
