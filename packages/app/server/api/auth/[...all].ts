import type { IncomingMessage, ServerResponse } from "node:http";
import { createError } from "h3";
import { toNodeHandler } from "better-auth/node";
import { auth } from "~~/auth";
import { isAllowedAuthHTTPRequest } from "~~/server/utils/auth-http-request";

const handleAuth = toNodeHandler(auth);

type NodeRuntimeEvent = {
  node: { req: IncomingMessage; res: ServerResponse };
};

export default defineEventHandler(async (event) => {
  const { req, res } = (event as NodeRuntimeEvent).node;
  if (!isAllowedAuthHTTPRequest({
    method: req.method,
    requestTarget: req.url,
  })) {
    throw createError({
      statusCode: 403,
      statusMessage: "Authentication action is not available.",
    });
  }
  await handleAuth(req, res);
});
