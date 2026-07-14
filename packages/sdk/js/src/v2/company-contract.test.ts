import { test } from "bun:test"
import type {
  CompanyBootstrapError,
  CompanyBootstrapResponse,
  CompanyCurrentError,
  CompanyCurrentResponse,
  CompanyProviderAuthError,
  CompanyProviderAuthResponse,
  CompanyProviderOauthAuthorizeError,
  CompanyProviderOauthAuthorizeResponse,
  CompanyProviderOauthCallbackError,
  CompanyProviderOauthCallbackResponse,
  CompanyProviderRemoveError,
  CompanyProviderRemoveResponse,
  CompanyProviderSetError,
  CompanyProviderSetResponse,
  CompanyProvidersError,
  CompanyProvidersResponse,
  CompanyRepositoryInspectError,
  CompanyRepositoryInspectResponse,
  LocalAuthCredentialsError,
  LocalAuthCredentialsResponse,
  LocalAuthExchangeError,
  LocalAuthExchangeResponse,
  LocalAuthPairError,
  LocalAuthPairResponse,
  LocalAuthRevokeError,
  LocalAuthRevokeResponse,
  LocalAuthSessionError,
  LocalAuthSessionResponse,
} from "./gen/types.gen.js"

type IsAny<T> = 0 extends 1 & T ? true : false
type IsUnsafe<T> = IsAny<T> extends true ? true : unknown extends T ? ([keyof T] extends [never] ? true : false) : false
type ExpectFalse<T extends false> = T

type M1Responses =
  | CompanyCurrentResponse
  | CompanyProvidersResponse
  | CompanyProviderAuthResponse
  | CompanyProviderSetResponse
  | CompanyProviderRemoveResponse
  | CompanyProviderOauthAuthorizeResponse
  | CompanyProviderOauthCallbackResponse
  | CompanyRepositoryInspectResponse
  | CompanyBootstrapResponse
  | LocalAuthSessionResponse
  | LocalAuthPairResponse
  | LocalAuthCredentialsResponse
  | LocalAuthRevokeResponse
  | LocalAuthExchangeResponse

type M1Errors =
  | CompanyCurrentError
  | CompanyProvidersError
  | CompanyProviderAuthError
  | CompanyProviderSetError
  | CompanyProviderRemoveError
  | CompanyProviderOauthAuthorizeError
  | CompanyProviderOauthCallbackError
  | CompanyRepositoryInspectError
  | CompanyBootstrapError
  | LocalAuthSessionError
  | LocalAuthPairError
  | LocalAuthCredentialsError
  | LocalAuthRevokeError
  | LocalAuthExchangeError

export type M1ContractAssertions = [ExpectFalse<IsUnsafe<M1Responses>>, ExpectFalse<IsUnsafe<M1Errors>>]

test("M1 generated response types are concrete", () => {})
