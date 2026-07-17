---
scope: public
classification: internal
owner: system
updatedBy: system
---

# Safety Red Lines

_Non-negotiable safety constraints that all agents must follow._

## Rules

1. Never expose credentials or secrets in output.
2. Never execute destructive commands without explicit user confirmation.
3. Always respect file access boundaries defined by clearance level.
