import { test } from "bun:test"
import type {
  CompanyChannelMessagesError,
  CompanyChannelMessagesResponse,
  CompanyChannelSendError,
  CompanyChannelSendResponse,
  CompanyChannelsError,
  CompanyChannelsResponse,
  CompanyThreadActionError,
  CompanyThreadActionResponse,
  CompanyThreadEntriesError,
  CompanyThreadEntriesResponse,
  CompanyThreadError,
  CompanyThreadResponse,
  CompanyThreadSourceError,
  CompanyThreadSourceResponse,
} from "./gen/types.gen.js"

type IsAny<T> = 0 extends 1 & T ? true : false
type IsUnsafe<T> = IsAny<T> extends true ? true : unknown extends T ? ([keyof T] extends [never] ? true : false) : false
type ExpectFalse<T extends false> = T

// M2 conversation operations: every product response and error must be a
// concrete typed shape, never the generated `unknown` catch-all.
type M2Responses =
  | CompanyChannelsResponse
  | CompanyChannelMessagesResponse
  | CompanyChannelSendResponse
  | CompanyThreadResponse
  | CompanyThreadEntriesResponse
  | CompanyThreadSourceResponse
  | CompanyThreadActionResponse

type M2Errors =
  | CompanyChannelsError
  | CompanyChannelMessagesError
  | CompanyChannelSendError
  | CompanyThreadError
  | CompanyThreadEntriesError
  | CompanyThreadSourceError
  | CompanyThreadActionError

export type M2ConversationContractAssertions = [
  ExpectFalse<IsUnsafe<M2Responses>>,
  ExpectFalse<IsUnsafe<M2Errors>>,
]

test("M2 generated conversation response and error types are concrete", () => {})
