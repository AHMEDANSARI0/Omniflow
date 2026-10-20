import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { logger } from "@/lib/logger";

/**
 * Over-the-air updates (EAS Update, free tier). When OMNIFLOW_EAS_UPDATE_URL
 * is configured at build time, pushing an update republishes the JS bundle
 * and every installed app picks it up on its next launch / foreground -
 * that is how "push the repos -> mobile updates itself" works together
 * with the live CP API (backend changes are instant via HTTP already).
 *
 * Everything here is fail-soft: no update URL, no network, or any error
 * simply means "keep running the embedded bundle".
 */

function updatesConfigured(): boolean {
  return Boolean(Constants.expoConfig?.updates?.url);
}

/** Returns true when a newer JS bundle is available on the server. */
export async function getUpdateAvailability(): Promise<boolean> {
  if (!updatesConfigured()) return false;
  try {
    const update = await Updates.checkForUpdateAsync();
    return update.isAvailable;
  } catch (err) {
    logger.warn("update availability check failed", err);
    return false;
  }
}

export async function checkForUpdatesSilently(): Promise<void> {
  if (!updatesConfigured()) return;
  try {
    const update = await Updates.checkForUpdateAsync();
    if (update.isAvailable) {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    }
  } catch (err) {
    logger.warn("ota update check failed", err);
  }
}

/** Manual trigger (Settings screen). Returns whether a reload happened. */
export async function checkForUpdatesNow(): Promise<boolean> {
  if (!updatesConfigured()) return false;
  try {
    const update = await Updates.checkForUpdateAsync();
    if (update.isAvailable) {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
      return true;
    }
    return false;
  } catch (err) {
    logger.warn("manual update check failed", err);
    return false;
  }
}