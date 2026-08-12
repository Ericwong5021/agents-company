import type { CompanyAgent } from "./company-contract"

export type OrganizationGraphMode = "structure" | "responsibility"

export type OrganizationGraphAgent = Pick<
  CompanyAgent,
  "id" | "name" | "role" | "department" | "employment" | "activity" | "presence" | "responsibilities" | "workload"
>

export type OrganizationGraphAssignment = {
  id: string
  agentID: string
  agentName: string
  projectID: string
  workItemID: string
  role: string
  responsibility: string
  status: "assigned" | "active" | "released"
  permissionMode: "read_only" | "workspace_write" | "full_access"
  selectionReason: string
  needRole: string
}

export type OrganizationGraphCompanyNode = {
  id: string
  kind: "company"
  title: string
  employeeCount: number
  temporaryCount: number
  departmentCount: number
}

export type OrganizationGraphDepartmentNode = {
  id: string
  kind: "department"
  title: string
  memberCount: number
  activeCount: number
}

export type OrganizationGraphAgentNode = {
  id: string
  kind: "agent"
  agentID: string
} & Omit<OrganizationGraphAgent, "id">

export type OrganizationGraphResponsibilityNode = {
  id: string
  kind: "responsibility"
} & OrganizationGraphAssignment

export type OrganizationGraphNode =
  | OrganizationGraphCompanyNode
  | OrganizationGraphDepartmentNode
  | OrganizationGraphAgentNode
  | OrganizationGraphResponsibilityNode

export type OrganizationGraphEdge = {
  id: string
  source: string
  target: string
  state: "stable" | "active" | "released" | "blocked"
}

export function organizationGraphProjection(input: {
  companyName: string
  agents: OrganizationGraphAgent[]
  assignments: OrganizationGraphAssignment[]
  mode: OrganizationGraphMode
  activeOnly: boolean
}) {
  const agents = input.activeOnly
    ? input.agents.filter(agent => agent.presence === "online" || agent.workload.active > 0 || agent.workload.blocked > 0)
    : input.agents
  const agentIDs = new Set(agents.map(agent => agent.id))
  const assignments = input.assignments.filter(assignment =>
    agentIDs.has(assignment.agentID) && (!input.activeOnly || assignment.status !== "released"))
  const departments = [...new Set(agents.flatMap(agent => agent.department ? [agent.department] : []))]
  const company: OrganizationGraphCompanyNode = {
    id: "company",
    kind: "company",
    title: input.companyName,
    employeeCount: agents.filter(agent => agent.employment === "employee").length,
    temporaryCount: agents.filter(agent => agent.employment === "temporary").length,
    departmentCount: departments.length,
  }
  const departmentNodes: OrganizationGraphDepartmentNode[] = departments.map(department => ({
    id: `department:${department}`,
    kind: "department",
    title: department,
    memberCount: agents.filter(agent => agent.department === department).length,
    activeCount: agents.filter(agent => agent.department === department && agent.workload.active > 0).length,
  }))
  const agentNodes: OrganizationGraphAgentNode[] = agents.map(agent => ({
    ...agent,
    id: `agent:${agent.id}`,
    agentID: agent.id,
    kind: "agent",
  }))
  const responsibilityNodes: OrganizationGraphResponsibilityNode[] = input.mode === "responsibility"
    ? assignments.map(assignment => ({
        ...assignment,
        id: `responsibility:${assignment.id}`,
        kind: "responsibility",
      }))
    : []
  const membershipEdges: OrganizationGraphEdge[] = agents.map(agent => ({
    id: `${agent.department ? `department:${agent.department}` : "company"}:agent:${agent.id}`,
    source: agent.department ? `department:${agent.department}` : "company",
    target: `agent:${agent.id}`,
    state: agent.workload.blocked > 0 ? "blocked" : agent.workload.active > 0 ? "active" : "stable",
  }))
  return {
    nodes: [company, ...departmentNodes, ...agentNodes, ...responsibilityNodes],
    edges: [
      ...departmentNodes.map(department => ({
        id: `company:${department.id}`,
        source: "company",
        target: department.id,
        state: department.activeCount > 0 ? "active" as const : "stable" as const,
      })),
      ...membershipEdges,
      ...responsibilityNodes.map(responsibility => ({
        id: `agent:${responsibility.agentID}:${responsibility.id}`,
        source: `agent:${responsibility.agentID}`,
        target: responsibility.id,
        state: responsibility.status === "released" ? "released" as const : "active" as const,
      })),
    ],
  }
}

export function organizationActivityLabel(value: OrganizationGraphAgent["activity"]) {
  return ({
    idle: "空闲",
    waiting: "等待中",
    working: "工作中",
    recovering: "恢复中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已中断",
  } as Record<OrganizationGraphAgent["activity"], string>)[value]
}
