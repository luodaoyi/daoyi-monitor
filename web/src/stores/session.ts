import { writable } from "svelte/store";
import { ApiRequestError, apiGet, apiPost } from "../api/client";
import type { User } from "../types";

export const currentUser = writable<User | null>(null);
export const sessionLoading = writable(false);

export async function loadMe(): Promise<void> {
  sessionLoading.set(true);
  try {
    const payload = await apiGet<User | { user: User } | null>("/api/auth/me");
    currentUser.set(readUser(payload));
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      currentUser.set(null);
      return;
    }
    throw error;
  } finally {
    sessionLoading.set(false);
  }
}

export async function login(username: string, password: string): Promise<void> {
  sessionLoading.set(true);
  try {
    const payload = await apiPost<User | { user: User }>("/api/auth/login", { username, password });
    currentUser.set(readUser(payload));
  } finally {
    sessionLoading.set(false);
  }
}

export async function logout(): Promise<void> {
  sessionLoading.set(true);
  try {
    await apiPost<void>("/api/auth/logout");
    clearSession();
  } finally {
    sessionLoading.set(false);
  }
}

export function clearSession(): void {
  currentUser.set(null);
}

function readUser(payload: User | { user: User } | null): User | null {
  if (!payload) return null;
  if ("user" in payload) return payload.user;
  return payload;
}
