import z from "zod"

export const ThreadID = z.string().startsWith("thr_")
export type ThreadID = z.infer<typeof ThreadID>

export const ThreadKind = z.enum(["primary", "reactive", "ambient"])
export type ThreadKind = z.infer<typeof ThreadKind>

export const ThreadStatus = z.enum(["active", "paused", "completed"])
export type ThreadStatus = z.infer<typeof ThreadStatus>
