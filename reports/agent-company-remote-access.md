# Agent Company Remote Access 交付报告

日期：2026-08-21

## 结论

已按 Better Codex 的远程访问边界完成首版实现。VPS 只运行 WebUI、Relay 和 Caddy，本地 Control Plane 继续作为唯一运行时和业务数据权威，不在 VPS 部署 Runtime。

当前代码已具备设备授权、出站 WSS 隧道、HTTP 与 SSE 转发、远程单用户登录、设备令牌吊销、Relay 最小持久化和 VPS 容器编排能力。

## 架构边界

| 位置 | 运行内容 | 持久化内容 |
| --- | --- | --- |
| 本机 | Control Plane、Agent Runtime、Tunnel Client | 项目、会话、消息、任务、产物和本地配置 |
| VPS WebUI | Nuxt WebUI、单用户会话 | WebUI 账号、会话和现有 WebUI 数据 |
| VPS Relay | WSS Relay、设备授权、请求流转发 | 设备、一次性授权状态、审计事件 |
| VPS Caddy | TLS、HTTP 路由、WSS 升级 | TLS 相关状态 |

Relay 不保存业务请求体、响应体、会话、消息、任务或产物。远程写入在本机离线时直接返回 `runtime_offline`，首版不排队、不重放。

## 已完成能力

- 新增版本化远程协议，包含握手、连接代次、心跳、请求流、响应流、取消、帧大小和请求大小限制。
- 新增独立 `@agents-company/relay` 包，使用 SQLite 保存设备、授权和审计三类最小数据。
- 新增本地 Tunnel Client，通过出站 WSS 连接 Relay，并把请求转发到回环地址上的现有 Control Plane。
- 新增 `agents remote connect`、`agents remote status`、`agents remote disconnect`。
- 新增浏览器设备审批页，审批要求有效 WebUI 会话、同源请求和 Relay 内部服务令牌。
- 新增公网单用户登录端点，关闭公共注册路径，登录失败带进程内速率限制。
- 新增设备令牌独立吊销，`disconnect` 会先尝试在 Relay 吊销，再删除本地凭据。
- 保留现有 Control Plane 回环地址校验，WebUI 和 Relay 通过共享容器网络命名空间通信。
- 新增 Caddy 路由，只公开健康检查、设备授权、设备吊销和 WSS 连接，Relay 内部管理接口不对公网开放。
- 新增容器健康检查和持久卷，WebUI 数据与 Relay 数据分开保存。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Relay `bun typecheck` | 通过 |
| Control Plane `bun typecheck` | 通过 |
| WebUI `bun typecheck` | 通过 |
| `git diff --check` | 通过 |
| Docker Compose 配置解析 | 通过 |
| 设备授权到令牌签发 | 通过 |
| WSS 握手与连接代次 | 通过 |
| Relay 到本地 HTTP 往返 | 通过，状态码 200，路径保持正确 |
| 设备令牌吊销 | 通过，吊销后令牌失效 |
| Relay SQLite 表边界 | 通过，仅有 `remote_devices`、`remote_authorizations`、`remote_audit` |

## 尚未执行

- 未构建生产镜像。
- 未启动或部署到真实 VPS。
- 未执行真实域名、TLS、跨网络大请求和长时间 SSE 验收。
- 未启动 WebUI 做桌面与 375px 浏览器截图验收。

这些步骤没有执行，是因为当前授权范围是实现方案，仓库规则要求未经单独授权不主动编译，部署和真实 VPS 变更也需要单独授权。

## 部署所需变量

部署前需要提供以下环境变量：

- `AGENT_COMPANY_DOMAIN`
- `AGENT_COMPANY_RELAY_SERVICE_TOKEN`，至少 32 个字符的随机值
- `AGENT_COMPANY_REMOTE_EMAIL`
- `AGENT_COMPANY_REMOTE_PASSWORD`，至少 12 个字符
- `BETTER_AUTH_SECRET`

部署入口位于 `deploy/remote-access/compose.yaml`，Caddy 配置位于 `deploy/remote-access/Caddyfile`。

## 下一验收门槛

下一步应在获得部署授权后完成生产镜像构建、VPS 启动、真实域名 TLS、设备首次配对、WebUI 登录、真实消息读写、SSE 持续连接、50 MB 请求上限和断线失败语义验收。只有这些证据全部成立，才能把状态从“代码实现完成”提升为“VPS 远程访问已部署并验收”。
