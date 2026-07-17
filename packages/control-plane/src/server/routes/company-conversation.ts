import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { AppRuntime } from "@/effect/app-runtime"
import { Conversation, ConversationRuntime } from "@/conversation"
import { ConversationCommand } from "@/conversation/command"
import {
  BoardMessagesDisabled,
  ChannelID,
  ChannelNotVisible,
  ChannelNotWritable,
  CompanyNotFound,
  ConversationMention,
  ConversationThreadID,
  InvalidCursor,
  MentionNotVisible,
  MessageInvalidInput,
  ReplyNotVisible,
  RequestConflict,
  SourceNotFound,
  ThreadNotVisible,
  ThreadNotWritable,
} from "@/conversation/schema"
import { LOCAL_USER_ID } from "@/conversation/conversation.sql"
import { CompanyID } from "@/company/schema"
import { lazy } from "@/util/lazy"
import {
  localAuthUnauthorizedResponse,
  namedErrorResponse,
  ProductValidationError,
  productValidationHook,
  UnknownErrorResponse,
} from "../error"
import type { ServerEnv } from "../middleware"

// M2 only allows the interrupt action. delegate/decide/approve are M3.
const ThreadActionInput = z
  .object({
    kind: z.literal("interrupt"),
  })
  .strict()
  .meta({ ref: "ThreadActionInput" })

const ChannelSendInput = z
  .object({
    request_id: z.string().uuid(),
    body: z.string().trim().min(1).max(20_000),
    reply_to: z.string().startsWith("cmsg_").optional(),
    referenced_thread_id: ConversationThreadID.optional(),
    mentions: z.array(ConversationMention).max(20).default([]),
  })
  .strict()
  .meta({ ref: "ChannelSendInput" })

const CompanyQuery = z
  .object({
    company_id: CompanyID,
  })
  .strict()

const PageQuery = z
  .object({
    company_id: CompanyID,
    before: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()

const localPrincipal = () => ({ kind: "user" as const, id: LOCAL_USER_ID })

const notFound = namedErrorResponse("Conversation resource not found", [
  CompanyNotFound.Schema,
  SourceNotFound.Schema,
  ThreadNotVisible.Schema,
] as const)
const forbidden = namedErrorResponse("Conversation resource not visible or writable", [
  BoardMessagesDisabled.Schema,
  ChannelNotVisible.Schema,
  ChannelNotWritable.Schema,
  ThreadNotWritable.Schema,
  ReplyNotVisible.Schema,
  MentionNotVisible.Schema,
] as const)
const conflict = namedErrorResponse("Conversation request conflict", [RequestConflict.Schema] as const)
const badRequest = namedErrorResponse("Invalid conversation request", [
  ProductValidationError,
  MessageInvalidInput.Schema,
  InvalidCursor.Schema,
] as const)
const internalError = namedErrorResponse("Unable to complete conversation operation", [UnknownErrorResponse] as const)

const acceptedResponse = {
  description: "Message accepted and persisted; the board run is queued",
  content: { "application/json": { schema: resolver(Conversation.MessageAccepted) } },
}

export const CompanyChannelRoutes = lazy(() =>
  new Hono<ServerEnv>()
    .get(
      "/",
      describeRoute({
        operationId: "company.channels",
        summary: "List company channels visible to the local user",
        responses: {
          200: {
            description: "Visible channels",
            content: { "application/json": { schema: resolver(z.array(Conversation.ChannelSummary)) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          500: internalError,
        },
      }),
      validator("query", CompanyQuery, productValidationHook),
      async (c) => {
        const { company_id } = c.req.valid("query")
        const channels = await AppRuntime.runPromise(
          Conversation.Service.use((service) => service.listChannels({ companyID: company_id, principal: localPrincipal() })),
        )
        return c.json(channels)
      },
    )
    .get(
      "/:channelID/messages",
      describeRoute({
        operationId: "company.channelMessages",
        summary: "Page main-feed channel messages for the local user",
        responses: {
          200: {
            description: "A page of channel messages",
            content: { "application/json": { schema: resolver(Conversation.ChannelMessagePage) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          403: forbidden,
          500: internalError,
        },
      }),
      validator("param", z.object({ channelID: ChannelID }).strict(), productValidationHook),
      validator("query", PageQuery, productValidationHook),
      async (c) => {
        const { channelID } = c.req.valid("param")
        const { company_id, before, limit } = c.req.valid("query")
        const page = await AppRuntime.runPromise(
          Conversation.Service.use((service) =>
            service.pageMessages({ companyID: company_id, channelID, principal: localPrincipal(), before, limit }),
          ),
        )
        return c.json(page)
      },
    )
    .post(
      "/:channelID/messages",
      describeRoute({
        operationId: "company.channelSend",
        summary: "Send a board message and queue the board run",
        responses: {
          202: acceptedResponse,
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          403: forbidden,
          404: notFound,
          409: conflict,
          500: internalError,
        },
      }),
      validator("param", z.object({ channelID: ChannelID }).strict(), productValidationHook),
      validator("query", CompanyQuery, productValidationHook),
      validator("json", ChannelSendInput, productValidationHook),
      async (c) => {
        const { channelID } = c.req.valid("param")
        const { company_id } = c.req.valid("query")
        const input = c.req.valid("json")
        const accepted = await AppRuntime.runPromise(
          ConversationCommand.Service.use((service) =>
            service.sendMessage({
              companyID: company_id,
              channelID,
              principal: localPrincipal(),
              requestID: input.request_id,
              body: input.body,
              replyToID: input.reply_to,
              referencedThreadID: input.referenced_thread_id,
              mentions: input.mentions,
            }),
          ),
        )
        return c.json(accepted, 202)
      },
    ),
)

export const CompanyThreadRoutes = lazy(() =>
  new Hono<ServerEnv>()
    .get(
      "/:threadID",
      describeRoute({
        operationId: "company.thread",
        summary: "Get a conversation thread detail",
        responses: {
          200: {
            description: "Thread detail",
            content: { "application/json": { schema: resolver(Conversation.ConversationThreadDetail) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          403: forbidden,
          500: internalError,
        },
      }),
      validator("param", z.object({ threadID: ConversationThreadID }).strict(), productValidationHook),
      validator("query", CompanyQuery, productValidationHook),
      async (c) => {
        const { threadID } = c.req.valid("param")
        const { company_id } = c.req.valid("query")
        const thread = await AppRuntime.runPromise(
          Conversation.Service.use((service) =>
            service.getThread({ companyID: company_id, threadID, principal: localPrincipal() }),
          ),
        )
        return c.json(thread)
      },
    )
    .get(
      "/:threadID/entries",
      describeRoute({
        operationId: "company.threadEntries",
        summary: "Page thread entries for the local user",
        responses: {
          200: {
            description: "A page of thread entries",
            content: { "application/json": { schema: resolver(Conversation.ThreadEntryPage) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          403: forbidden,
          500: internalError,
        },
      }),
      validator("param", z.object({ threadID: ConversationThreadID }).strict(), productValidationHook),
      validator("query", PageQuery, productValidationHook),
      async (c) => {
        const { threadID } = c.req.valid("param")
        const { company_id, before, limit } = c.req.valid("query")
        const page = await AppRuntime.runPromise(
          Conversation.Service.use((service) =>
            service.pageEntries({ companyID: company_id, threadID, principal: localPrincipal(), before, limit }),
          ),
        )
        return c.json(page)
      },
    )
    .get(
      "/:threadID/sources/:sourceID",
      describeRoute({
        operationId: "company.threadSource",
        summary: "Resolve a precise thread source reference",
        responses: {
          200: {
            description: "Thread source detail",
            content: { "application/json": { schema: resolver(Conversation.ThreadSource) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          403: forbidden,
          404: notFound,
          500: internalError,
        },
      }),
      validator("param", z.object({ threadID: ConversationThreadID, sourceID: z.string().min(1) }).strict(), productValidationHook),
      validator("query", CompanyQuery, productValidationHook),
      async (c) => {
        const { threadID, sourceID } = c.req.valid("param")
        const { company_id } = c.req.valid("query")
        const source = await AppRuntime.runPromise(
          Conversation.Service.use((service) =>
            service.getSource({ companyID: company_id, threadID, sourceID, principal: localPrincipal() }),
          ),
        )
        return c.json(source)
      },
    )
    .post(
      "/:threadID/actions",
      describeRoute({
        operationId: "company.threadAction",
        summary: "Apply a structured thread action (M2: interrupt only)",
        responses: {
          200: {
            description: "Updated thread detail",
            content: { "application/json": { schema: resolver(Conversation.ConversationThreadDetail) } },
          },
          400: badRequest,
          401: localAuthUnauthorizedResponse,
          403: forbidden,
          500: internalError,
        },
      }),
      validator("param", z.object({ threadID: ConversationThreadID }).strict(), productValidationHook),
      validator("query", CompanyQuery, productValidationHook),
      validator("json", ThreadActionInput, productValidationHook),
      async (c) => {
        const { threadID } = c.req.valid("param")
        const { company_id } = c.req.valid("query")
        const thread = await AppRuntime.runPromise(
          ConversationRuntime.Service.use((service) =>
            service.interruptThread({ companyID: company_id, threadID, principal: localPrincipal() }),
          ),
        )
        return c.json(thread)
      },
    ),
)
