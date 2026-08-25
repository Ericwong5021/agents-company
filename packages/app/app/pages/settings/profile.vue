<script setup lang="ts">
import { authClient } from "~/lib/auth-client";

const { profile, pending, error: profileError, refresh, saveProfile, timezones, locales } = useProfile();
const { memory, pending: memoryPending } = useMemory();
const toast = useToast();
const saving = ref(false);
const formReady = ref(false);
const form = reactive({
  name: "",
  phoneNumber: "",
  timezone: "UTC",
  locale: "en",
  bio: "",
});

const isDirty = computed(() => formReady.value && Boolean(profile.value) && (
  form.name !== profile.value?.name
  || form.phoneNumber !== (profile.value?.phoneNumber ?? "")
  || form.timezone !== profile.value?.timezone
  || form.locale !== profile.value?.locale
  || form.bio !== profile.value?.bio
));

function syncForm() {
  if (!profile.value) return;
  form.name = profile.value.name;
  form.phoneNumber = profile.value.phoneNumber ?? "";
  form.timezone = profile.value.timezone;
  form.locale = profile.value.locale;
  form.bio = profile.value.bio;
}

watch(profile, (value) => {
  if (!value) return;
  form.name = value.name;
  form.phoneNumber = value.phoneNumber ?? "";
  form.timezone = value.timezone;
  form.locale = value.locale;
  form.bio = value.bio;
}, { immediate: true });
onMounted(async () => {
  await refresh();
  syncForm();
  formReady.value = true;
});

async function handleSave() {
  if (saving.value || !isDirty.value) return;
  saving.value = true;
  await saveProfile({
    name: form.name.trim(),
    phoneNumber: form.phoneNumber.trim() || null,
    timezone: form.timezone,
    locale: form.locale,
    bio: form.bio.trim(),
  }).then(
    async () => {
      await authClient.getSession({ query: { disableCookieCache: true } });
      toast.add({ title: "个人资料已保存", color: "success" });
    },
    () => toast.add({ title: "个人资料保存失败", color: "error" }),
  );
  saving.value = false;
}
</script>

<template>
  <UDashboardPanel id="profile-settings" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <ModuleWorkspace eyebrow="设置" title="个人与记忆" description="" narrow>
        <UAlert v-if="profileError" color="error" variant="subtle" title="个人资料加载失败" :description="profileError.message" />

        <div v-else-if="pending || !formReady" class="grid gap-6">
          <USkeleton class="h-64 rounded-xl" />
          <USkeleton class="h-36 rounded-xl" />
        </div>

        <div v-else class="grid gap-8">
          <form id="profile-form" class="grid gap-8" @submit.prevent="handleSave">
            <SettingsSection title="个人资料">
              <SettingsRow label="姓名">
                <UInput v-model="form.name" class="w-full" placeholder="你的姓名" />
              </SettingsRow>

              <SettingsRow label="邮箱" inline>
                <span class="text-sm text-muted">{{ profile?.email }}</span>
              </SettingsRow>

              <SettingsRow label="手机">
                <ProfilePhoneInput
                  v-model="form.phoneNumber"
                  :default-country="form.locale === 'fr' ? 'FR' : form.locale === 'zh-CN' ? 'CN' : 'US'"
                  size="md"
                />
              </SettingsRow>

              <SettingsRow label="个人简介">
                <UTextarea
                  v-model="form.bio"
                  :rows="3"
                  :maxrows="6"
                  autoresize
                  class="w-full"
                  placeholder="你的工作背景、偏好和长期目标"
                />
              </SettingsRow>
            </SettingsSection>

            <SettingsSection title="地区">
              <SettingsRow label="时区" inline>
                <UInputMenu
                  v-model="form.timezone"
                  :items="timezones"
                  value-key="value"
                  label-key="label"
                  description-key="description"
                  :filter-fields="['label', 'value', 'description']"
                  placeholder="选择时区"
                  icon="i-lucide-globe"
                  class="w-52"
                />
              </SettingsRow>

              <SettingsRow label="语言" inline>
                <UInputMenu
                  v-model="form.locale"
                  :items="locales"
                  value-key="value"
                  label-key="label"
                  description-key="description"
                  :filter-fields="['label', 'value', 'description']"
                  placeholder="选择语言"
                  icon="i-lucide-languages"
                  class="w-44"
                />
              </SettingsRow>
            </SettingsSection>
          </form>

          <ProfileMemorySection :memory="memory" :pending="memoryPending" />
        </div>
      </ModuleWorkspace>
    </template>

    <template #footer>
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-3 opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="translate-y-0 opacity-100"
        leave-to-class="translate-y-3 opacity-0"
      >
        <div v-if="isDirty && !pending" class="border-t border-default bg-elevated">
          <div class="mx-auto flex w-full max-w-[760px] items-center justify-between gap-4 px-8 py-3 max-sm:px-5">
            <span class="text-sm text-muted">有未保存的更改</span>
            <div class="flex gap-2">
              <UButton color="neutral" variant="ghost" :disabled="saving" @click="syncForm">放弃</UButton>
              <UButton color="neutral" form="profile-form" type="submit" :loading="saving">保存</UButton>
            </div>
          </div>
        </div>
      </Transition>
    </template>
  </UDashboardPanel>
</template>
