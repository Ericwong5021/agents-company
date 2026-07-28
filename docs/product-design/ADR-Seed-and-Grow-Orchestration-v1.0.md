# ADR：Seed-and-Grow Orchestration

- 状态：Accepted
- 日期：2026-07-28
- 决策：`orchestration-contract.v1.json`

## 背景

现有项目路径在开工前生成完整任务树，并以长期组织身份承担临时项目职责。复杂未知项目需要先接触真实环境，再依据 Work Receipt 和现实证据增量生长任务图与临时组织。

## 决策

- Local Control Plane 仍是唯一权威写入者；
- SQLite、Agent Runtime、Project、WorkItem、Artifact、Event 和 ApprovalGate 继续复用；
- 项目创建时固定 `legacy_full_plan | seed_and_grow`，运行中不可切换；
- `seed_and_grow` 从 Wayfinder 与 First-slice Builder 启动；
- Worker 只能提交 Receipt，Graph Supervisor 提议变更，确定性 Policy 决定是否应用；
- 临时职责写入 Project Assignment，不修改 Agent 永久身份；
- 产品运行时权限、范围和外部副作用继续由 ApprovalGate 阻断；
- Pre-Public 开发波次只由精确 SHA 机器证据裁决，人工研究仅作 advisory。

## 不采用

- 不引入第二个 Control Plane、数据库或 Agent Runtime；
- 不实现 Orca 或旧 AgentCompany 兼容层；
- 不让模型自报完成、直接改图、直接招聘或绕过权限；
- 不在当前 R0 窗口启用默认执行路径。

## 推进

实现按 A0–B5 串行 Gate。A0 只冻结契约、Flag 和自动验收基础设施，不改变默认生产执行行为。后续波次只有在所属 R3/R4 窗口开放且前一波次机器 Gate 为 `pass` 时开始。
