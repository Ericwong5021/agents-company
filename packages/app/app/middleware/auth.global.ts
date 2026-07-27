import type {
  CompanyConnection,
  CompanySnapshot,
} from "../../modules/agent-company/runtime/shared/company-contract";
import { authClient } from "~/lib/auth-client";

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/login") {
    return;
  }

  const authenticated = useState("agent-company-authenticated", () => false);
  if (!authenticated.value) {
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
    authenticated.value = true;
  }

  if (
    !import.meta.server
    || !/\bElectron\//.test(useRequestHeader("user-agent") ?? "")
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
