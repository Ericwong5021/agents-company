import { NamedError } from "@agents-company/shared/util/error"
import z from "zod"
import { BoardRole, CompanyID } from "@/company/schema"

export const ChannelID = z.string().startsWith("chn_").brand<"ChannelID">().meta({ ref: "ChannelID" })
export type ChannelID = z.infer<typeof ChannelID>

export const RootNeedID = z.string().startsWith("need_").brand<"RootNeedID">().meta({ ref: "RootNeedID" })
export type RootNeedID = z.infer<typeof RootNeedID>

export const ConversationThreadID = z
  .string()
  .startsWith("cth_")
  .brand<"ConversationThreadID">()
  .meta({ ref: "ConversationThreadID" })
export type ConversationThreadID = z.infer<typeof ConversationThreadID>

export const ChannelMessageID = z
  .string()
  .startsWith("cmsg_")
  .brand<"ChannelMessageID">()
  .meta({ ref: "ChannelMessageID" })
export type ChannelMessageID = z.infer<typeof ChannelMessageID>

export const ConversationRunID = z
  .string()
  .startsWith("crun_")
  .brand<"ConversationRunID">()
  .meta({ ref: "ConversationRunID" })
export type ConversationRunID = z.infer<typeof ConversationRunID>

export const SignalProjectionID = z
  .string()
  .startsWith("spr_")
  .brand<"SignalProjectionID">()
  .meta({ ref: "SignalProjectionID" })
export type SignalProjectionID = z.infer<typeof SignalProjectionID>

export const ChannelKind = z.enum(["company", "board", "department", "project", "direct"]).meta({ ref: "ChannelKind" })
export type ChannelKind = z.infer<typeof ChannelKind>

export const ChannelMemberRole = z.enum(["member", "owner"]).meta({ ref: "ChannelMemberRole" })
export type ChannelMemberRole = z.infer<typeof ChannelMemberRole>

export const ConversationPrincipal = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("agent"), id: z.string().min(1) }).strict(),
  ])
  .meta({ ref: "ConversationPrincipal" })
export type ConversationPrincipal = z.infer<typeof ConversationPrincipal>

export const MessageAuthor = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("agent"), id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("system"), id: z.string().min(1) }).strict(),
  ])
  .meta({ ref: "MessageAuthor" })
export type MessageAuthor = z.infer<typeof MessageAuthor>

export const ConversationMention = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("role"), role: BoardRole }).strict(),
  ])
  .meta({ ref: "ConversationMention" })
export type ConversationMention = z.infer<typeof ConversationMention>

export const RootNeedStatus = z.enum(["open", "in_progress", "resolved", "cancelled"]).meta({ ref: "RootNeedStatus" })
export type RootNeedStatus = z.infer<typeof RootNeedStatus>

export const ConversationThreadStatus = z.enum(["active", "completed", "interrupted"]).meta({
  ref: "ConversationThreadStatus",
})
export type ConversationThreadStatus = z.infer<typeof ConversationThreadStatus>

export const ConversationRunState = z
  .enum(["queued", "running", "projecting", "completed", "failed", "interrupted"])
  .meta({ ref: "ConversationRunState" })
export type ConversationRunState = z.infer<typeof ConversationRunState>

export const SignalType = z
  .enum(["conclusion", "decision", "plan", "status", "risk", "approval", "delivery", "intervention"])
  .meta({ ref: "SignalType" })
export type SignalType = z.infer<typeof SignalType>

export const MessageVisibility = z.enum(["channel", "company"]).meta({ ref: "MessageVisibility" })
export type MessageVisibility = z.infer<typeof MessageVisibility>

export const SignalProjectionSourceKind = z
  .enum(["group_message", "message", "part", "agent_message", "decision", "artifact", "gate"])
  .meta({ ref: "SignalProjectionSourceKind" })
export type SignalProjectionSourceKind = z.infer<typeof SignalProjectionSourceKind>

export const ChannelMessageCursor = z
  .object({
    id: ChannelMessageID,
    time_created: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "ChannelMessageCursor" })
export type ChannelMessageCursor = z.infer<typeof ChannelMessageCursor>

export const HighSignalDraft = z
  .object({
    signal_type: SignalType,
    body: z.string().trim().min(1).max(10_000),
    author: MessageAuthor,
    dri: ConversationPrincipal.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.signal_type !== "decision" || value.dri) return
    context.addIssue({
      code: "custom",
      message: "A decision signal requires a DRI.",
      path: ["dri"],
    })
  })
  .meta({ ref: "HighSignalDraft" })
export type HighSignalDraft = z.infer<typeof HighSignalDraft>

export const SignalProjectionSource = z
  .object({
    kind: SignalProjectionSourceKind,
    id: z.string().min(1),
  })
  .strict()
  .meta({ ref: "SignalProjectionSource" })
export type SignalProjectionSource = z.infer<typeof SignalProjectionSource>

export const MessageInvalidInput = NamedError.create("ConversationMessageInvalidInput", z.object({}).strict())
export const BoardMessagesDisabled = NamedError.create(
  "ConversationBoardMessagesDisabled",
  z.object({ company_id: CompanyID }).strict(),
)
export const ChannelNotVisible = NamedError.create(
  "ConversationChannelNotVisible",
  z.object({ company_id: CompanyID, channel_id: ChannelID }).strict(),
)
export const ChannelNotWritable = NamedError.create(
  "ConversationChannelNotWritable",
  z.object({ channel_id: ChannelID }).strict(),
)
export const ThreadNotVisible = NamedError.create(
  "ConversationThreadNotVisible",
  z.object({ company_id: CompanyID, thread_id: ConversationThreadID }).strict(),
)
export const ThreadNotWritable = NamedError.create(
  "ConversationThreadNotWritable",
  z.object({ thread_id: ConversationThreadID }).strict(),
)
export const ReplyNotVisible = NamedError.create(
  "ConversationReplyNotVisible",
  z.object({ channel_id: ChannelID, message_id: ChannelMessageID }).strict(),
)
export const MentionNotVisible = NamedError.create(
  "ConversationMentionNotVisible",
  z.object({ channel_id: ChannelID }).strict(),
)
export const RequestConflict = NamedError.create(
  "ConversationRequestConflict",
  z.object({ channel_id: ChannelID, request_id: z.string().uuid() }).strict(),
)
export const SourceNotFound = NamedError.create(
  "ConversationSourceNotFound",
  z.object({ thread_id: ConversationThreadID, source_id: z.string().min(1) }).strict(),
)
export const CompanyNotFound = NamedError.create("ConversationCompanyNotFound", z.object({ company_id: CompanyID }).strict())
export const InvalidCursor = NamedError.create("ConversationInvalidCursor", z.object({}).strict())
