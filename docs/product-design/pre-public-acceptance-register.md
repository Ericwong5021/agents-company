# Pre-Public 弱门禁登记

> 状态：开放
> 更新日期：2026-07-30
> 作用：登记人工研究、主观验收与真实样本，不阻塞产品开发、集成或阶段机器 Gate

本文取代按开发批次追加的 R1–R4 人工测试留档。详细产品验收标准仍以[产品 PRD](../Agent%20Company%20产品%20PRD.md)和[体验重构计划](Agent-Company-Experience-Refactor-Plan-v1.0.md)为准。

隔离 Subagent 的模拟 Persona 流程见 [Persona UX Test 真实环境盲测 Runbook](../persona-ux-test-runbook.md)。该流程用于发现问题，不替代真人研究、SUS 或真实样本。

## 1. 判定规则

- 机器 Gate 只能证明代码、迁移、契约、恢复和确定性场景。
- 人工授权、用户研究、SUS、视觉偏好和真实样本必须保存独立来源，不得由 Agent、Fixture、截图数量或自动化结果代替。
- Pre-Public 开发阶段的未确认项记录为 `not_confirmed / blocking=false`。
- 面向公众发布时，体验重构计划明确列为硬门禁的项目恢复阻断属性。
- Founder OS 的人工授权未确认时，模式保持全局上限约束；机器 Gate 通过不自动提高模式。

## 2. 当前登记

| 范围 | 验收主题 | 状态 | 开发阶段阻塞 |
|---|---|---|---|
| Experience R0 | 用户语言、品牌认知、候选截图与场景抽查 | `not_confirmed` | 否 |
| Experience R1 | Goal 理解、澄清、Provider 首次配置与启动可理解性 | `not_confirmed` | 否 |
| Experience R2 | 实时状态、干预、Gate、失败与恢复的可理解性 | `not_confirmed` | 否 |
| Experience R3 | Artifact/Delivery 可消费性、返工、无障碍、性能与 SUS | `not_confirmed` | 否 |
| Experience R4 | 动态选人、能力证据、临时角色生命周期与组织规模 | `not_confirmed` | 否 |
| Founder OS | 六项治理 ADR 的产品负责人确认 | `not_confirmed` | 否 |
| Founder OS | 真实决策、Taste、Commons 多模态与 Learning Loop 样本 | `not_confirmed` | 否 |

## 3. 最低证据

一次有效人工或真实样本验收至少记录：

- 验收对象、候选完整 SHA 与构建来源；
- 参与者或确认人的匿名 ID/具名身份及角色；
- 原始输入、操作步骤、观察结果和失败；
- 不由 Agent 补写的结论；
- 对应产品标准、日期与证据位置。

未满足时保持 `not_confirmed`。若机器实现失败，回到对应计划和 Gate 修复，不用弱门禁登记掩盖。

## 4. Founder OS 完成记录

候选 `b7aca6b87ecc7722a3a3fff8b5d027cf66463fa8` 的 W0–W7、E0、K0–K2 机器 Gate 均为 `pass`，每阶段两次运行摘要一致。该轮没有执行部署、上传或 OTA；这些动作不属于本登记的完成条件。
