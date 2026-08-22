# Agent Company v0.1.5-beta.4 本地与 VPS 部署报告

日期：2026-08-23

## 结论

Agent Company `v0.1.5-beta.4` 已部署到本机和 VPS。VPS 继续只运行 Relay 与 WebUI，本机 Control Plane 保持唯一权威运行时。公网和本地均已取得真实认证会话与真实 Snapshot，连接状态为 `ready`，当前可见 3 名 Agent。

本报告不记录登录密码。密码只在最终交付消息中直接提供给负责人。

## 发布制品

- Preview：`v0.1.5-beta.4`
- 发布源提交：`f5fa3da3846d85059e39898660191f5444405a72`
- Preview workflow：`32582219189`，成功
- Relay 镜像：`ghcr.io/ericwong5021/agents-company-relay@sha256:d933511338db830eaab0c2d6cc851fade8bd97dd229a64a85afa0af6a209267d`
- WebUI 镜像：`ghcr.io/ericwong5021/agents-company-webui@sha256:ba2b1a4ba7d6d5a75e39978ce8e513c0d9197d2e950b16e6aa5336c719759102`
- 本地 CLI、安装脚本、VPS 脚本和远程配置均通过 GitHub Attestation 与 `checksums.txt` 校验

## 本地部署

- Control Plane 版本：`0.1.5-beta.4`
- Control Plane：`http://127.0.0.1:4096`
- Control Plane 健康检查：`/global/health` 返回 `healthy: true`
- Control Plane 服务：`cn.talktodo.agentcompany.runtime`，由 `launchd` 常驻管理
- WebUI：`http://127.0.0.1:3210`
- WebUI 服务：`cn.talktodo.agentcompany.webui`，由 `launchd` 常驻管理
- WebUI 生产构建目录：`~/.local/share/agent-company/webui/v0.1.5-beta.4/.output`
- 本地登录页：HTTP 200
- 本地自动认证：HTTP 200，仅接受可信 loopback 请求
- 本地 Snapshot：HTTP 200，`connection: ready`，3 名 Agent，无运行时问题

## VPS 部署

- 公网地址：<https://cumora.talktodo.cn/>
- 登录邮箱：`970699442@qq.com`
- 已安装版本：`v0.1.5-beta.4`
- 已安装源提交：`f5fa3da3846d85059e39898660191f5444405a72`
- Relay 容器：healthy
- WebUI 容器：healthy
- 入口代理：Nginx，继续监听 80/443；容器只绑定 VPS loopback 端口
- TLS：Let's Encrypt，证书有效期至 2026-11-17
- VPS 根分区：60 GB，总占用 50 GB，可用 6.5 GB，占用率 89%

## 分层验收

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| 发布来源 | 通过 | Preview workflow 成功，版本、源提交、镜像摘要一致 |
| 本地 Runtime | 通过 | beta.4，健康检查成功，远程连接在线 |
| 本地 WebUI | 通过 | 生产构建常驻，登录和认证均为 200 |
| VPS 容器 | 通过 | Relay 与 WebUI 均为 healthy |
| HTTPS | 通过 | 登录页 200，TLS 证书有效 |
| 未认证隔离 | 通过 | 公网 Snapshot 返回 401 |
| 公网认证 | 通过 | 登录 200，会话 200，账号与配置邮箱一致 |
| 真实数据 | 通过 | 公网 Snapshot 200，`connection: ready`，3 名 Agent |
| 权威边界 | 通过 | 本机 Runtime 仍连接同一 Relay，VPS 未启动第二个 Control Plane |

## 移动端界面门禁

发布源提交的浏览器门禁中，375px 稳定性、六项移动端主导航、无横向溢出、路由状态和 Team 内容 Tab 均已执行。候选截图用例最初把页面的 `role="tablist"` 错当成 `navigation` 查询，导致等待超时；失败截图确认页面中的组织、成员、历史三个 Tab 及 2 名候选成员均已真实渲染。

测试选择器在提交 `ec7c4965f7d21fd017b3f7730887cec093a8021b` 中改为按 `tablist` 查询，没有修改生产代码。修正后的 8 张候选截图用例在本机通过，截图阶段耗时 1.4 分钟；GitHub test workflow `32585783657` 及同提交的 lint、typecheck、package-check、体验元数据 workflow 均已成功。

本次尝试连接可见浏览器做公网截图验收时，没有可用浏览器实例。因此本报告没有把接口结果冒充视觉截图证据；当前视觉结论只采用同一页面代码的 CI Playwright 门禁。

## 运维提示

- 本机 WebUI 和 Control Plane 都由 `launchd` 自动保持运行。
- VPS 升级脚本在替换容器前已备份上一版配置和持久卷，并保留失败回滚路径。
- VPS 磁盘占用率已达 89%。本次没有清理任何可能属于其他服务的 Docker 镜像或缓存，后续应单独安排有边界的磁盘审计。
