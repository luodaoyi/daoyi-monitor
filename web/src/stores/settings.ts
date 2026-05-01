import { writable } from "svelte/store";
import { apiGet, apiPost, apiPut } from "../api/client";
import type { NotificationConfig } from "../types";

export const notificationSettings = writable<NotificationConfig | null>(null);
export const notificationSettingsLoading = writable(false);

export async function loadNotificationSettings(): Promise<NotificationConfig> {
  notificationSettingsLoading.set(true);
  try {
    const settings = await apiGet<NotificationConfig>("/api/settings/notifications");
    notificationSettings.set(settings);
    return settings;
  } finally {
    notificationSettingsLoading.set(false);
  }
}

export async function saveNotificationSettings(input: NotificationConfig): Promise<NotificationConfig> {
  const settings = await apiPut<NotificationConfig>("/api/settings/notifications", input);
  notificationSettings.set(settings);
  return settings;
}

export async function testNotificationSettings(): Promise<void> {
  await apiPost("/api/settings/notifications/test");
}
