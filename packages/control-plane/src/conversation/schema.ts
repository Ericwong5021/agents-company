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

export const ConversationResource = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("url"),
      url: z.string().url().max(4_000),
      label: z.string().trim().min(1).max(200).optional(),
    }).strict(),
    z.object({
      kind: z.literal("path"),
      path: z.string().trim().min(1).max(2_000),
      resource_type: z.enum(["file", "directory", "unknown"]),
      access: z.literal("read_only"),
      label: z.string().trim().min(1).max(200).optional(),
    }).strict(),
    z.object({
      kind: z.literal("text_attachment"),
      name: z.string().trim().min(1).max(255),
      media_type: z.string().trim().min(1).max(200),
      byte_length: z.number().int().nonnegative().max(200_000),
      content: z.string().max(200_000),
    }).strict(),
  ])
  .superRefine((resource, context) => {
    if (resource.kind !== "text_attachment") return
    if (new TextEncoder().encode(resource.content).byteLength === resource.byte_length) return
    context.addIssue({ code: "custom", path: ["byte_length"], message: "Attachment byte length does not match content" })
  })
  .meta({ ref: "ConversationResource" })
export type ConversationResource = z.infer<typeof ConversationResource>

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
    sequence: z.number().int().nonnegative(),
    time_created: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ ref: "ChannelMessageCursor" })
export type ChannelMessageCursor = z.infer<typeof ChannelMessageCursor>

export const ChannelMessageKind = z.enum(["text", "poll", "system"]).meta({ ref: "ChannelMessageKind" })
export type ChannelMessageKind = z.infer<typeof ChannelMessageKind>

export const ChannelPoll = z
  .object({
    question: z.string().trim().min(1).max(500),
    options: z
      .array(z.object({ id: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(300) }).strict())
      .min(2)
      .max(12),
    multiple: z.boolean().default(false),
    closed_at: z.number().int().nonnegative().optional(),
  })
  .strict()
  .meta({ ref: "ChannelPoll" })
export type ChannelPoll = z.infer<typeof ChannelPoll>

export const ChannelDeliveryStatus = z
  .enum(["pending", "triaging", "running", "held", "responded", "passed", "failed", "cancelled"])
  .meta({ ref: "ChannelDeliveryStatus" })
export type ChannelDeliveryStatus = z.infer<typeof ChannelDeliveryStatus>

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
