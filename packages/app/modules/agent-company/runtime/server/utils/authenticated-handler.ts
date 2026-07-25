import {
  createError,
  defineEventHandler,
  getMethod,
  getRequestHeader,
  getRequestURL,
  type EventHandler,
  type EventHandlerRequest,
  type EventHandlerResponse,
} from "h3"
import { requireSessionUserId } from "~~/server/utils/session"
import { isSameOriginAgentCompanyRequest } from "./same-origin-request"

export function defineAgentCompanyHandler<
  Request extends EventHandlerRequest = EventHandlerRequest,
  Response extends EventHandlerResponse = EventHandlerResponse,
>(handler: EventHandler<Request, Response>) {
  return defineEventHandler<Request, Response>({
    onRequest: async (event) => {
      await requireSessionUserId(event)
      if (
        isSameOriginAgentCompanyRequest({
          method: getMethod(event),
          origin: getRequestHeader(event, "origin"),
          requestOrigin: getRequestURL(event).origin,
        })
      )
        return
      throw createError({
        statusCode: 403,
        statusMessage: "Agent Company writes require a same-origin request.",
      })
    },
    handler,
  })
}
