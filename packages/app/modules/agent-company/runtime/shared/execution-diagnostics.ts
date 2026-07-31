const internalFailurePattern =
  /Cause\(\[|(?:^|\n)\s*at\s|\/(?:Users|home|private|Volumes)\/|[A-Za-z]:\\|INTERNAL_ERROR|stream error/i

export function safeExecutionSummary(value?: string) {
  const text = value?.trim()
  if (!text) return "本次执行未完成，现有进度已保留。"
  if (/^Work item \S+ completed$/i.test(text)) return "工作项已完成。"
  if (/Document lacks structure/i.test(text))
    return "成果缺少清晰结构；请补充 Markdown 标题、编号章节或明确的章节分隔。"
  if (/cannot use system verification while review is required/i.test(text))
    return "当前工作项的系统核验状态与独立复核状态冲突，本次成果未能进入下一步；系统已保留成果，需修正复核范围后重试。"
  if (/Delivery acceptance remains unverified:/i.test(text)) {
    const reason = text.match(/Delivery acceptance remains unverified:\s*([^\n]+)/i)?.[1]?.trim()
    return reason
      ? `成果仍有未通过的验收项：${reason.slice(0, 600)}`
      : "成果仍有未通过的验收项，系统已保留成果并停止交付。"
  }
  if (/System verification Gate .* did not pass/i.test(text))
    return "系统核验未通过，本次成果已保留但不会进入交付；请按失败项修正后重试。"
  if (/INTERNAL_ERROR|stream error/i.test(text))
    return "模型服务连接中断，本次尝试未完成；系统已保留进度并按重试策略处理。"
  if (/local coding runtime exited before completing the assigned work/i.test(text))
    return "本地运行器在完成任务前退出，本次尝试未完成；系统已保留进度并按重试策略处理。"
  if (/timed?\s*out|timeout/i.test(text))
    return "本次执行等待超时，系统已保留进度并按重试策略处理。"
  if (internalFailurePattern.test(text))
    return "本次执行遇到内部错误，系统已保留进度并按重试策略处理。"
  const summary = text
    .split(/\r?\n/, 1)[0]!
    .replace(/(Bearer\s+)[^\s]+/gi, "$1****")
    .replace(/((?:authorization|token|api[_-]?key|secret|password|credential)[=:]\s*)[^\s,;]+/gi, "$1****")
    .replace(/\bParent(?:\s+delivery)?\s+artifacts? bytes are persisted\b/gi, "上游交付成果已持久保存")
    .replace(/\bSuperseded by active plan\s+cpln_[A-Za-z0-9]+\b/gi, "已由当前计划替代")
    .replace(/\bcpln_[A-Za-z0-9]+\b/g, "当前计划")
    .replace(/\bsuperseded\b/gi, "已由新计划替代")
    .replace(/\bblocked\b/gi, "未完成")
    .replace(/\s+/g, " ")
    .trim()
  return summary.length > 180 ? `${summary.slice(0, 179)}…` : summary
}

export function sanitizeAttemptFailureContent(content: string) {
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== "object" || Array.isArray(value)) return content
    const record = value as Record<string, unknown>
    if (typeof record.error !== "string") return content
    return `${JSON.stringify({ ...record, error: safeExecutionSummary(record.error) }, null, 2)}\n`
  } catch {
    return `${JSON.stringify({ error: safeExecutionSummary(content) }, null, 2)}\n`
  }
}

export function safeProjectMessageBody(value: string) {
  if (!internalFailurePattern.test(value)) return value
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const subject = lines.find((line) => /^(任务未通过|项目执行未完成|项目受阻)/.test(line))
  const next = lines.find((line) => /^(将进入|重试次数|系统已)/.test(line))
  return [subject, `原因：${safeExecutionSummary(value)}`, next].filter(Boolean).join("\n")
}

function compactLine(value: string, limit: number) {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function projectMessageSummary(value: string) {
  const safe = safeProjectMessageBody(value)
  if (safe !== value) return safe
  const lines = safe.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const first = lines[0]
  if (!first) return ""
  if (first.startsWith("已安排：")) {
    const responsibility = lines.find((line) => line.startsWith("负责："))
    return [
      compactLine(first, 140),
      responsibility ? compactLine(responsibility.replace(/^负责：/, "任务："), 200) : undefined,
      "责任与选择依据可在“团队”查看。",
    ].filter(Boolean).join("\n")
  }
  if (first.startsWith("独立复核未通过：")) {
    return [
      "独立复核未通过，已自动安排返工。",
      "具体问题与修正要求请展开“查看完整执行记录”；是否需要你介入以当前工作状态为准。",
    ].filter(Boolean).join("\n")
  }
  if (first.startsWith("阶段成果已完成：")) {
    const result = lines.find((line) => line.startsWith("结果："))
    return [
      compactLine(first, 160),
      result ? compactLine(result.replace(/^结果：/, "结论："), 180) : "结论：已完成当前验收。",
      "成果已保存，可在“成果库”打开核验。",
    ].filter(Boolean).join("\n")
  }
  if (first.startsWith("项目交付已就绪：")) {
    const count = lines.find((line) => /^共 \d+ 项成果/.test(line))
    return [
      compactLine(first, 180),
      count,
      "请在“成果库”逐项打开，并按当前验收标准人工核对。",
    ].filter(Boolean).join("\n")
  }
  if (first.startsWith("项目已启动：")) return compactLine(first, 180)
  return compactLine(safe, 180)
}
