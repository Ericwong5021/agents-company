export const MEMORY_CATEGORIES = [
  "work_context",
  "personal_context",
  "active_focus",
  "instructions_preferences",
  "project_history",
] as const;

export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export type MemorySource = "import" | "agent" | "manual";

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
}

export type MemoryByCategory = Record<MemoryCategory, MemoryEntry[]>;

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  work_context: "工作背景",
  personal_context: "个人信息",
  active_focus: "当前重点",
  instructions_preferences: "偏好与要求",
  project_history: "项目经历",
};

export const MEMORY_CATEGORY_HEADERS: Record<MemoryCategory, string[]> = {
  work_context: ["work context"],
  personal_context: ["personal context"],
  active_focus: ["active focus", "active context"],
  instructions_preferences: ["instructions & preferences", "instructions and preferences"],
  project_history: ["project history"],
};
