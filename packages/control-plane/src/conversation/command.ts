import { Bus } from "@/bus"
import { Company } from "@/company"
import { CompanyID } from "@/company/schema"
import { RepositoryInstance } from "@/company/repository-instance"
import { BoardMessagesDisabled, ChannelID } from "./schema"
import { Event as ServerEvent } from "@/server/event"
import { Context, Effect, Layer } from "effect"
import { Conversation } from "./conversation"
import { ConversationRuntime } from "./runtime"
import type { MessageAccepted, SendMessageError, SendMessageInput } from "./intake"

export interface Interface {
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<MessageAccepted, SendMessageError | unknown>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/ConversationCommand") {}

export const layer: Layer.Layer<
  Service,
  never,
  Conversation.Service | ConversationRuntime.Service | Bus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const conversation = yield* Conversation.Service
    const runtime = yield* ConversationRuntime.Service
    const bus = yield* Bus.Service

    const sendMessage = Effect.fn("ConversationCommand.sendMessage")(function* (input: SendMessageInput) {
      if (!Company.boardMessagesEnabled()) {
        return yield* Effect.fail(new BoardMessagesDisabled({ company_id: input.companyID }))
      }

      const accepted = yield* conversation.sendMessage(input)
      yield* RepositoryInstance.provide(CompanyID.parse(input.companyID))(
        Effect.all(
          [
            bus.publish(ServerEvent.ChannelInvalidated, { channel_id: ChannelID.parse(input.channelID) }).pipe(Effect.ignore),
            ...(accepted.threadID
              ? [bus.publish(ServerEvent.ThreadInvalidated, { thread_id: accepted.threadID }).pipe(Effect.ignore)]
              : []),
            ...(accepted.threadID && accepted.runID
              ? [
                  bus
                    .publish(ServerEvent.ConversationRunUpdated, {
                      thread_id: accepted.threadID,
                      state: "queued" as const,
                    })
                    .pipe(Effect.ignore),
                ]
              : []),
          ],
          { discard: true },
        ),
      ).pipe(Effect.ignore)
      if (accepted.runID) {
        yield* runtime.start(accepted.runID).pipe(Effect.catch(() => Effect.void))
      }
      return accepted
    })

    return Service.of({ sendMessage })
  }),
)

export * as ConversationCommand from "./command"
