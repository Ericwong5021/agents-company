export type WorkTaskCardVM = {
  id: string
  title: string
  status: string
  owner: string
  updatedAt: number
}

export type WorkApprovalCardVM = {
  id: string
  title: string
  summary: string
  status: string
  requestedAt: number
}

export type WorkArtifactCardVM = {
  id: string
  title: string
  kind: string
  createdAt: number
}

export type WorkExecutionStepVM = {
  id: string
  label: string
  status: string
  occurredAt: number
}

export type WorkRoomContextVM = {
  tasks: WorkTaskCardVM[]
  approvals: WorkApprovalCardVM[]
  artifacts: WorkArtifactCardVM[]
  execution: WorkExecutionStepVM[]
}
