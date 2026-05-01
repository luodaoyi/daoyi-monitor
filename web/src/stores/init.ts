import { writable } from "svelte/store";
import { apiGet, apiPost } from "../api/client";
import type { InitStatus } from "../types";

export const initStatus = writable<InitStatus | null>(null);
export const initStatusLoading = writable(false);

export async function loadInitStatus(): Promise<InitStatus> {
  initStatusLoading.set(true);
  try {
    const status = await apiGet<InitStatus>("/api/init/status");
    initStatus.set(status);
    return status;
  } finally {
    initStatusLoading.set(false);
  }
}

export async function initAdmin(username: string, password: string): Promise<void> {
  await apiPost<unknown>("/api/init/admin", { username, password });
  await loadInitStatus();
}
