---
name: create-founding-team
description: Create a founding team of 2-3 agents based on the user's business scope and company goals. Use this during onboarding to assemble the initial team.
---

# Create Founding Team

## Overview

This skill creates a founding team of 2-3 Company Agents tailored to the user's business. It searches the agent template library for relevant roles, customizes their system prompts for the user's specific business context, and creates them via the Company Agent API.

## When to Use

Use this skill when:
- The user has completed the onboarding interview (name, assistant name, business scope, mission/goals)
- You need to assemble their founding team
- The user has confirmed their company profile

## Process

### 1. Analyze the Business Context

Review the user's:
- **Business scope(s)**: What industry/domain they're in
- **Company description**: What they do
- **Vision**: Where they want to be
- **Goals**: Immediate milestones
- **Challenges**: Anticipated obstacles

### 2. Select Founding Roles

Based on the business scope, select 2-3 complementary founding roles. Here's a mapping guide:

| Business Scope | Recommended Roles |
|---|---|
| SaaS | CTO (engineering), CPO (product) |
| Content | Content Strategist (marketing), Growth Lead (marketing) |
| Consulting | Chief of Staff (specialized), Financial Analyst (finance) |
| E-commerce | Project Manager (project-management), Growth Hacker (marketing) |
| Agency | Creative Director (design), Account Executive (sales) |

For multi-scope selections, pick the most relevant roles across scopes. Aim for 2 roles minimum, 3 maximum.

### 3. Search Templates

Use the template library to find matching agent templates:

```
Search for agents by division and keywords:
- Engineering division: for technical roles (CTO, architect, etc.)
- Marketing division: for growth, content, strategy roles
- Product division: for product management roles
- Finance division: for financial analysis roles
- Design division: for creative direction roles
- Sales division: for business development roles
- Specialized division: for cross-functional roles (chief of staff, etc.)
- Project Management division: for operations roles
```

Pick templates that best match the needed roles. Use the template's `system_prompt` as the base.

### 4. Customize System Prompts

For each selected template, customize the system prompt to include:
- The user's company name/description
- Their specific business scope
- Their stated vision and goals
- Their anticipated challenges
- Their role as a founding team member (not just any employee)

Add a section at the top of each agent's system prompt:

```markdown
## 🏢 Your Company Context

You are a founding team member of **[Company Name/Description]**.

**Business Focus**: [User's selected scopes]
**Vision**: [User's stated vision]
**Immediate Goals**: [User's goals]
**Key Challenges**: [User's challenges]

As a founder, you have ownership and agency. You don't wait for instructions — you proactively identify what needs to be done and take initiative. You collaborate with the other founding team members and the principal (the user).
```

### 5. Create Company Agents

For each founding team member, create a Company Agent via the API:

```
POST /company-agent
{
  "id": "[division]-[slug]-founder",
  "name": "[Role Name]",
  "description": "[Brief description of their role in the company]",
  "system_prompt": "[Customized system prompt]",
  "color": "[Template's color]",
  "icon": "[Template's emoji]"
}
```

Use unique, descriptive IDs like `engineering-cto-founder`, `marketing-growth-lead-founder`, etc.

### 6. Return Results

After creating all agents, output a summary in this format:

```
Founding team created:

1. **[Role Name]** ([emoji]) — [One-line description of their focus]
   - Agent ID: [id]
   - Base template: [division/slug]

2. **[Role Name]** ([emoji]) — [One-line description of their focus]
   - Agent ID: [id]
   - Base template: [division/slug]

[Optional 3rd member]

Total: [N] founding team members ready.
```

Then output the completion marker:
```
[ONBOARDING_COMPLETE:id_1,id_2[,id_3]]
```

## Important Notes

- **Quality over quantity.** 2 well-chosen roles beat 3 poorly matched ones.
- **Complementary skills.** The founding team should cover different aspects of the business.
- **Founder mindset.** Customize prompts to emphasize ownership, proactivity, and collaboration.
- **Keep it concise.** Don't overwhelm with too many agents or overly long prompts.
- **Use existing templates.** Don't create agents from scratch — leverage the template library's battle-tested personas.
