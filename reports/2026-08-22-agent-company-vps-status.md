# Agent Company VPS 远程访问状态

日期：2026-08-22

## 结论

Agent Company 已经采用与 Better Codex 相同的核心思路完成 VPS 远程访问，并且当前正在运行，不需要再从零开发或部署。

- 公网地址：<https://cumora.talktodo.cn/>
- 版本：`v0.1.5-beta.3`
- 源提交：`3f5aed0194642d116491274016cc7897d02fdf4e`
- 协议：`agent-company-remote/v1`
- 公网健康检查：通过
- 登录页：HTTP 200
- 实际账号登录：HTTP 200
- 登录后 Snapshot API：HTTP 200
- 本地 Control Plane：已连接
- VPS 容器：Relay 与 WebUI 均为 healthy

## 架构边界

VPS 运行 Relay、WebUI 和 HTTPS 入口，本地 Control Plane 通过出站 WebSocket 连接 Relay。VPS 不取代本地 Control Plane 的权威写入职责，浏览器请求由 Relay 转发给本地服务。

这与 Better Codex 的远程架构一致：远端提供 Web 访问与中继，本地 Runtime/Control Plane 保持权威数据源。

## 登录

- 登录账号：`970699442@qq.com`
- 登录密码：VPS 私有环境变量中配置的 32 位随机值

实际密码已按要求直接交付在本次对话中。为避免把现网凭据提交到 Git 历史，密码不写入仓库报告。

## 发布与恢复能力

当前实现使用 GitHub Preview Release 的固定镜像摘要和受验证发布制品。VPS 部署脚本会校验 attestation 与 checksum，升级前备份 Relay/WebUI 数据卷，并在失败时恢复上一版本。

## 当前缺口

仓库已有完整部署代码和发布制品，但缺少一份面向使用者、与 Better Codex `SELF_HOSTING.md` 同等级的 Agent Company 自托管说明。这个文档缺口不影响当前实例运行。
