import type { UserProfileWithUser, UserProfilePatch } from "#shared/types/profile";
import { TIMEZONE_OPTIONS } from "#shared/timezones";

interface ProfileResponse {
  profile: UserProfileWithUser;
}

const LOCALES = [
  { value: "zh-CN", label: "简体中文", description: "zh-CN" },
  { value: "en", label: "English", description: "en" },
  { value: "fr", label: "Français", description: "fr" },
];

export function useProfile() {
  const { data, pending, error, refresh } = useFetch<ProfileResponse>("/api/profile", {
    key: "user-profile",
    ...payloadCacheOptions,
  });

  const profile = computed(() => data.value?.profile);

  async function saveProfile(patch: UserProfilePatch) {
    const result = await $fetch<ProfileResponse>("/api/profile", {
      method: "PATCH",
      body: patch,
    });
    data.value = result;
    return result.profile;
  }

  return {
    profile,
    pending,
    error,
    refresh,
    saveProfile,
    timezones: TIMEZONE_OPTIONS,
    locales: LOCALES,
  };
}
