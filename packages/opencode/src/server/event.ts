import { BusEvent } from "@/bus/bus-event"
import { ChannelID, ConversationRunState, ConversationThreadID } from "@/conversation/schema"
import z from "zod"

export const Event = {
  Connected: BusEvent.define("server.connected", z.object({})),
  Disposed: BusEvent.define("global.disposed", z.object({})),
  ChannelInvalidated: BusEvent.define(
    "company.channel.invalidated",
    z.object({ channel_id: ChannelID }).strict(),
  ),
  ThreadInvalidated: BusEvent.define(
    "company.thread.invalidated",
    z.object({ thread_id: ConversationThreadID }).strict(),
  ),
  ConversationRunUpdated: BusEvent.define(
    "company.conversation_run.updated",
    z.object({ thread_id: ConversationThreadID, state: ConversationRunState }).strict(),
  ),
}
