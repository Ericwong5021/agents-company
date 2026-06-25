# 03. 信息架构

> **模块**：信息架构
> **核心问题**：谁能看到什么、怎么控制
> **来源**：运转模型宪法 §3/§4/§5

---

## 1. 两个正交维度

```
可见性判定:  Agent 能看到 doc  ⟺  doc.scope 覆盖 Agent  ∧  Agent.clearance ≥ doc.classification
```

信息的可见性由**作用域**和**密级**两个正交维度共同决定。

---

## 2. 作用域（Scope）三层

| 层 | 内容 | 说明 |
|----|------|------|
| **Public（组织级）** | 同事名册、组织结构、公司规章、协作规范、安全红线、公共设施（skill/MCP/tool 目录）、战略看板、项目清单与进度、公司纪要 | 全组织可见 |
| **Group（项目/团队级）** | 项目共享上下文、squad 内纪要、项目资源仓库；委派 thread 天然是临时 group scope | 招募时动态创建 |
| **Private（个人级）** | soul、instruct、memory、专有 skill/MCP/tool、relationship、个人 kanban、手头项目清单 | 仅本人可见 |

---

## 3. 密级（Classification）四级

正交叠加于作用域之上：

| 密级 | 说明 |
|------|------|
| **public** | 公开信息 |
| **internal** | 内部信息 |
| **confidential** | 机密信息 |
| **restricted** | 受限信息 |

---

## 4. 授权模型

### 4.1 基础 Clearance 从组织树推导

- Agent 在组织树的位置（部门 + 职级）决定基础 clearance
- 组织架构与权限边界是同一棵树的两个读法

### 4.2 Relationship 边做局部增删权

- 某私交通道多看一档
- 某外部协作者降一档
- 某通道允许 delegate

### 4.3 访问公式

```
Agent 能看到 doc  ⟺  doc.scope 覆盖 Agent  ∧  Agent.clearance ≥ doc.classification
```

---

## 5. 文件系统即真相

### 5.1 三层目录结构

```
workspace/
  public/           ← 组织级
    org/
      profiles/     ← 同事名册
      structure.md  ← 组织结构
    policy/
      safety-redlines.md   ← 安全红线
      collaboration.md     ← 协作规范
    facilities/
      skills.md     ← 公共技能目录
    board/
      strategy.md   ← 战略看板
      projects.md   ← 项目清单
    minutes/        ← 公司纪要
  groups/           ← 项目/团队级
    <project-id>/   ← 招募时动态创建
  agents/           ← 个人级
    <agent-id>/
      soul.md
      instruct.md
      memory/
      skills/
      relationships.md
      kanban.md
```

### 5.2 Front-Matter 规范

每个文档带 front-matter，定义其作用域和密级：

- **scope**：public / group:<groupId> / agent:<agentId>
- **classification**：public / internal / confidential / restricted
- **owner**：所有者
- **updatedBy**：最后更新者

---

## 6. 上下文解析器（ContextResolver）

### 6.1 定位

系统唯一的上下文收口。memory、skill、消息、模式全部经过它。

### 6.2 解析流程

```
ResolveContext(agent, task, mode) →
  1. 扫 public / group / private 三层文档树
  2. 过滤：scope ∩ (组织推导 clearance ± relationship 边)        ← 硬边界
  3. 软聚焦：visible ∩ mode-profile(注意力模式)                  ← 软聚焦
  4. 聚合：未读 inbox + 相关 memory
  5. 截断：相关性排序 + token 预算 → 常驻摘要
  6. 暴露工具（授权内）：read_doc / delegate / message_agent / propose
  → 拼成本次 run 的 instruct
```

### 6.3 Token 两档

| 档位 | 内容 | 注入方式 |
|------|------|----------|
| **常驻摘要** | 名册一句话、安全红线、当前项目一行 | 每次注入 |
| **按需拉取** | 深度文档内容 | Agent 主动 read_doc |

### 6.4 访问控制 vs 注意力：两个正交过滤

```
visible  = access-filter(scope ∩ clearance ± relationship)   ← 硬边界
injected = visible ∩ mode-profile(当前注意力模式)             ← 软聚焦
```

- 模式永不扩权——只在 visible 内重排前景/静音噪音
- 无状态 runtime 下「隔离噪音」无需删除上下文，只要这次不注入即可

---

## 7. 多租户前瞻

- scope 抽象对（workspace → group → agent）天然适配多租户
- 未来把 workspace 换成 tenant 边界几乎零改动
- 第一版定语义，后续不重写

---

*来源：运转模型宪法 §3/§4/§5*
