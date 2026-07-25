import {
  getRequestHeaders,
  sendWebResponse,
} from "h3";
import { auth } from "~~/auth";
import { requireTrustedLoopbackRequest } from "~~/server/utils/loopback-request";

const localAccount = {
  email: "owner@agent-company.local",
  password: "agent-company-local-owner",
  name: "本地负责人",
  rememberMe: true,
};

export default defineEventHandler(async (event) => {
  requireTrustedLoopbackRequest(event);

  const headers = new Headers(
    Object.entries(getRequestHeaders(event)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const session = await auth.api.getSession({ headers });
  if (session?.user) return { user: session.user };

  const signIn = () => auth.api.signInEmail({
    body: localAccount,
    headers,
    asResponse: true,
  });
  const existing = await signIn();
  if (existing.ok) return sendWebResponse(event, existing);

  const created = await auth.api.signUpEmail({
    body: localAccount,
    headers,
    asResponse: true,
  });
  if (created.ok) return sendWebResponse(event, created);

  return sendWebResponse(event, await signIn());
});
