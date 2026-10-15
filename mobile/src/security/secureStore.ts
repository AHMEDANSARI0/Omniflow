import * as SecureStore from "expo-secure-store";
import { logger } from "@/lib/logger";

/**
 * Hardware-backed secret storage (tokens only). Every call is fail-soft:
 * a storage failure must never brick sign-in.
 */

export const KEYS = {
  accessToken: "omniflow.access_token",
  refreshToken: "omniflow.refresh_token",
} as const;

export async function getSecret(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (err) {
    logger.warn("secure-store read failed", key, err);
    return null;
  }
}

export async function setSecret(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (err) {
    logger.warn("secure-store write failed", key, err);
  }
}

export async function deleteSecret(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (err) {
    logger.warn("secure-store delete failed", key, err);
  }
}

export async function clearSessionSecrets(): Promise<void> {
  await Promise.all([deleteSecret(KEYS.accessToken), deleteSecret(KEYS.refreshToken)]);
}
