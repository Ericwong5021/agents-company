# Founder OS v1 信息架构

- 状态：Implemented / Frozen
- 日期：2026-07-30
- 任务：FOS-IA-001

Founder OS 保留现有五项一级导航，不新增平行入口：

| 一级导航 | 路径 | Founder OS 承载面 |
|---|---|---|
| Inbox | `/inbox` | Decision Center |
| Work | `/work` | Board Room |
| Team | `/team` | 不新增 Founder OS 一级页面 |
| Library | `/library` | Company Commons、Belief Lab、Learning Patches |
| Settings | `/settings` | Founder Control Center、Founder Studio |

页面归属冻结如下：

| 页面 | 最早波次 | 承载位置 |
|---|---|---|
| Decision Center | W2 | Inbox 内 Decision 视图 |
| Founder Studio | W3-W4 | Settings 内 Founder 区 |
| Board Room | W5 | Work 内真实 Board 工作区 |
| Founder Control Center | W5 | Settings 内治理区 |
| Company Commons | K0-K1 | Library 内 Commons 工作区 |
| Belief Lab | K2 | Library 内 Belief 标签页 |
| Learning Patches | K2 | Library 内 Patches 标签页 |

所有页面读取 Control Plane 的持久化事实或可重建投影，不维护前端第二套治理状态。`/company/board` 已承载真实 Board 治理投影、Shadow/Advisor 依据和人工接管入口。Founder Twin 模式提高、红灯授权和核心治理资产确认不能由导航或客户端状态绕过。
