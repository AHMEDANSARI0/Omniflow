import { create } from "zustand";
import {
  fetchSession,
  login as apiLogin,
  logoutCall,
  refresh as apiRefresh,
  type LoginInput,
  type SessionUser,
} from "@/api/auth";
import {
  adminLogin,
  adminLogout,
  adminRefresh,
  fetchAdminSession,
} from "@/api/admin";
import { setTokenProvider } from "@/api/client";
import { isAdminApp } from "@/config/env";
import {
  KEYS,
  clearSessionSecrets,
  getSecret,
  setSecret,
} from "@/security/secureStore";
import { clearOfflineCache, setSessionFingerprint } from "@/lib/offlineCache";
import { clearQueryCache } from "@/api/queryClient";
import { logger } from "@/lib/logger";

export type AuthStatus = "booting" | "unauthenticated" | "authenticated";

interface AuthState {
  status: AuthStatus;
  user: SessionUser | null;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
  /** used by the api client on 401 */
  refreshTokens: () => Promise<string | null>;
}

let accessToken: string | null = null;
let refreshToken: string | null = null;

async function persistTokens(access: string, refresh: string): Promise<void> {
  accessToken = access;
  refreshToken = refresh;
  await setSecret(KEYS.accessToken, access);
  await setSecret(KEYS.refreshToken, refresh);
}

async function doRefresh(): Promise<string | null> {
  if (!refreshToken) return null;
  try {
    // §272: the Admin variant refreshes through the CP mobile-admin proxy,
    // the Client variant through the existing portal auth flow.
    const pair = isAdminApp
      ? await adminRefresh(refreshToken)
      : await apiRefresh(refreshToken);
    await persistTokens(pair.access_token, pair.refresh_token);
    return pair.access_token;
  } catch (err) {
    logger.warn("token refresh failed", err);
    return null;
  }
}

async function currentSession(): Promise<SessionUser> {
  if (isAdminApp) {
    const admin = await fetchAdminSession();
    return {
      id: admin.id ?? "admin",
      email: admin.email,
      name: admin.name ?? undefined,
      role: admin.role ?? "admin",
    };
  }
  return fetchSession();
}

setTokenProvider(async () => ({
  access: accessToken ?? (await getSecret(KEYS.accessToken)),
  refresh: doRefresh,
}));

export function fingerprintForUser(user: SessionUser): string {
  return `user=${user.id}`;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  status: "booting",
  user: null,

  async hydrate() {
    try {
      const [access, refresh] = await Promise.all([
        getSecret(KEYS.accessToken),
        getSecret(KEYS.refreshToken),
      ]);
      if (!access || !refresh) {
        set({ status: "unauthenticated", user: null });
        return;
      }
      accessToken = access;
      refreshToken = refresh;
      const user = await currentSession().catch(async () => {
        const newAccess = await doRefresh();
        if (!newAccess) throw new Error("session expired");
        return currentSession();
      });
      setSessionFingerprint(fingerprintForUser(user));
      set({ status: "authenticated", user });
    } catch (err) {
      logger.warn("session hydrate failed", err);
      await clearSessionSecrets();
      accessToken = null;
      refreshToken = null;
      set({ status: "unauthenticated", user: null });
    }
  },

  async login(input) {
    // §275: Admin app credentials are exchanged by the Control Plane
    // server-side against its Neon-backed mobile-admin auth (table
    // mobile_admins); no database secret ever ships inside the app binary.
    const pair = isAdminApp ? await adminLogin(input) : await apiLogin(input);
    await persistTokens(pair.access_token, pair.refresh_token);
    const user = await currentSession();
    setSessionFingerprint(fingerprintForUser(user));
    set({ status: "authenticated", user });
  },

  async logout() {
    // §275: Admin sessions live on the CP (Neon), client sessions on the
    // portal auth flow - revoke against the matching endpoint, fail-soft.
    void (isAdminApp ? adminLogout() : logoutCall());
    await clearSessionSecrets();
    await clearOfflineCache();
    clearQueryCache();
    accessToken = null;
    refreshToken = null;
    set({ status: "unauthenticated", user: null });
  },

  async refreshTokens() {
    const access = await doRefresh();
    if (!access) {
      set({ status: "unauthenticated", user: null });
      await clearSessionSecrets();
    }
    return access;
  },
}));

/** Convenience for non-React contexts (api client bootstrap). */
export function getAuthSnapshot(): { status: AuthStatus; user: SessionUser | null } {
  const s = getAuthState();
  return { status: s.status, user: s.user };
}

function getAuthState() {
  return useAuthStore.getState();
}