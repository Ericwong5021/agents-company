import type {
  CompanyConnection,
  CompanySnapshot,
} from "../../modules/agent-company/runtime/shared/company-contract";
import { authClient } from "~/lib/auth-client";

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/login" || import.meta.client) {
    return;
  }

  const { data: session } = await authClient.getSession({
    fetchOptions: {
      headers: useRequestHeaders(["cookie"]) as HeadersInit,
    },
  });

  if (!session) {
    return navigateTo({
      path: "/login",
      query: { redirect: to.fullPath },
    });
  }

  useState<{ name: string; email: string } | undefined>(
    "agent-company-session-user",
  ).value = {
    name: session.user.name,
    email: session.user.email,
  };

  if (
    !/\bElectron\//.test(useRequestHeader("user-agent") ?? "")
  ) return;

  const snapshot = useState<CompanySnapshot | undefined>("agent-company-snapshot-value");
  const connection = useState<CompanyConnection | undefined>("agent-company-connection");
  const nativeSnapshot = useState<CompanySnapshot | undefined>("agent-company-native-shell-snapshot");
  if (snapshot.value && snapshot.value.connection !== "connecting") return;

  return useRequestFetch()<CompanySnapshot>("/api/agent-company/snapshot").then(
    (value) => {
      snapshot.value = value;
      connection.value = value.connection;
      nativeSnapshot.value = value;
    },
    () => undefined,
  );
});
