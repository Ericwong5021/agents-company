# Agent Company Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:execute to implement this plan task-by-task.

**Goal:** 在不把 Runtime 或业务数据部署到 VPS 的前提下，通过 VPS WebUI + Relay 远程访问本机唯一权威 Control Plane。

**Architecture:** VPS 上的 Nuxt WebUI 使用服务凭据访问同网络命名空间内的 Relay；本机 Control Plane Tunnel Client 主动建立 WSS。Relay 只持久化设备、授权和审计元数据，离线写入直接失败，不缓存公司业务状态。

**Tech Stack:** TypeScript、Bun、Hono WebSocket、bun:sqlite、Nuxt/Nitro、Better Auth、Docker Compose、Caddy。

## Global Constraints

- Control Plane、SQLite、Agent Runtime、身份文件、受管资源和 Git/Worktree 必须继续留在用户电脑。
- VPS 不运行第二套 Runtime，不持久化公司业务数据，不离线排队写入。
- 本机 Control Plane 继续只监听 loopback；Tunnel Client 只建立主动出站 WSS。
- Web Session、Relay 服务凭据和设备 Token 必须分离并可独立撤销。
- 使用 `packages/app` 作为唯一 WebUI，不复制 Better Codex Web Shell。
- 不修改当前运营日志、Agent brains 和并发业务改动。
- 不新增测试代码，不主动编译产品。

---

### Task 1: Remote Protocol

**Files:**
- Create: `packages/shared/src/remote-access.ts`

**Interfaces:**
- Produces: `RemoteMessage`、`decodeRemoteMessage()`、`encodeRemoteMessage()`、`remoteProtocolVersion`、chunk/size limits。

- [ ] 定义 hello/ack、heartbeat、request/response stream、cancel 和错误消息。
- [ ] 用 Zod 在 Relay 与 Tunnel 两端执行同一协议校验。
- [ ] 保持 JSON frame 小于 1 MiB，二进制负载按 64 KiB base64 chunk 传输。

### Task 2: VPS Relay

**Files:**
- Create: `packages/relay/package.json`
- Create: `packages/relay/tsconfig.json`
- Create: `packages/relay/src/store.ts`
- Create: `packages/relay/src/server.ts`
- Create: `packages/relay/src/index.ts`

**Interfaces:**
- Consumes: `RemoteMessage` protocol。
- Produces: `GET /healthz`、device authorization API、`/api/v1/remote/connect` WSS、service-authenticated HTTP forwarding。

- [ ] 用 bun:sqlite 保存 device、authorization、audit，不建立公司业务表。
- [ ] 设备授权使用高熵 authorization ID + 短期 user code，批准后签发一次可见 device token。
- [ ] Relay 要求 WebUI 服务 Token 才能转发业务 HTTP；WSS 首帧 hello 校验 device token。
- [ ] Runtime 离线时返回 503 `runtime_offline`；连接中断时终止 in-flight channel，不排队写入。
- [ ] 转发请求和响应流，过滤 hop-by-hop、cookie 与本地 Authorization 头。

### Task 3: Local Tunnel and CLI

**Files:**
- Create: `packages/control-plane/src/remote-access/config.ts`
- Create: `packages/control-plane/src/remote-access/client.ts`
- Create: `packages/control-plane/src/remote-access/index.ts`
- Create: `packages/control-plane/src/cli/cmd/remote.ts`
- Modify: `packages/control-plane/src/cli/cmd/serve.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces: `RemoteAccessClient.start(localURL)`、`agents remote connect|status|disconnect`。

- [ ] 将凭据原子写入 `Global.Path.data/remote-access.json`，权限 0600。
- [ ] connect 创建授权、打开审批 URL、轮询 Token 并保存配置。
- [ ] Serve 启动后常驻 Tunnel Client；无配置时低频轮询，不影响本地服务。
- [ ] Tunnel 只转发到当前 Listener 的 loopback URL，并覆盖来自 Relay 的 Authorization。
- [ ] status 只输出非敏感连接事实；disconnect 删除配置并使下一轮连接关闭。

### Task 4: Remote WebUI Authentication and Approval

**Files:**
- Create: `packages/app/server/api/auth/remote.post.ts`
- Create: `packages/app/server/api/agent-company-remote/device-authorizations/[id]/approve.post.ts`
- Create: `packages/app/app/pages/remote/device-authorizations/[id].vue`
- Modify: `packages/app/app/pages/login.vue`
- Modify: `packages/app/nuxt.config.ts`
- Modify: `packages/app/.env.example`

**Interfaces:**
- Consumes: Relay internal URL、service token、remote username/password。
- Produces: remote deployment login、session-protected device approval。

- [ ] remote 模式显示用户名/密码表单，本地模式保持自动进入。
- [ ] 远程密码仅与环境 Secret 做常量时间比较；Better Auth 内部账号密码由 Auth Secret 派生。
- [ ] 登录失败按客户端地址限流，标准 sign-up/sign-in 端点继续关闭。
- [ ] 设备审批要求 Web Session、同源 POST、authorization ID 和 user code 同时匹配。
- [ ] WebUI 通过 loopback Relay 地址和 Bearer service token 访问本机 Control Plane 投影。

### Task 5: VPS Deployment Assets

**Files:**
- Create: `deploy/remote/Dockerfile.relay`
- Create: `deploy/remote/Dockerfile.web`
- Create: `deploy/remote/compose.yaml`
- Create: `deploy/remote/Caddyfile`
- Create: `scripts/selfhost.sh`

**Interfaces:**
- Produces: standalone Caddy 模式和 existing-proxy loopback override 所需部署结构。

- [ ] Relay 和 WebUI 共享网络命名空间，WebUI 用 `127.0.0.1` 访问 Relay。
- [ ] Caddy 只把 WSS、设备授权和 health 路径路由到 Relay，其余路径进入 Nuxt。
- [ ] Secret 使用文件或 Compose Secret 注入，应用端口不直接暴露公网。
- [ ] 安装脚本保留现有目录、Secret、Volume 和反向代理，不执行破坏性清理。

### Task 6: Verification and Report

**Files:**
- Create: `reports/agent-company-remote-access.md`
- Create: `reports/agent-company-remote-access.html`

- [ ] 检查所有新增 TypeScript 可由当前依赖解析，检查 package/compose/Caddy/shell 语法和 `git diff --check`。
- [ ] 运行独立 Relay + 假 loopback Control Plane + Tunnel 的真实进程 smoke，验证 health、pair、WSS、GET、POST、SSE/stream、offline。
- [ ] 检查 Relay SQLite 只有 device、authorization 和 audit 表。
- [ ] 报告明确区分源码实现、静态验证、进程 smoke、未执行构建、未部署 VPS 和未完成人工浏览器验收。
