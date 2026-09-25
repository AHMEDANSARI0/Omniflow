"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  refreshSessionCoordinated,
  sessionRemainingMs,
} from "../../../lib/omniflow/client-session";


const REFRESH_BEFORE_EXPIRY_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const DEFAULT_CHECK_MS = 12 * 60_000;

export default function SessionKeeper() {
  const router = useRouter();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), Math.max(1_000, delay));
    };

    const check = async () => {
      try {
        const remaining = await sessionRemainingMs();
        if (stopped) return;

        if (remaining !== null && remaining > REFRESH_BEFORE_EXPIRY_MS) {
          schedule(Math.min(DEFAULT_CHECK_MS, remaining - REFRESH_BEFORE_EXPIRY_MS));
          return;
        }

        const refreshed = await refreshSessionCoordinated(
          REFRESH_BEFORE_EXPIRY_MS
        );
        if (stopped) return;

        if (!refreshed) {
          router.replace("/dashboard/login");
          router.refresh();
          return;
        }

        schedule(DEFAULT_CHECK_MS);
      } catch {
        schedule(RETRY_AFTER_FAILURE_MS);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void check();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(DEFAULT_CHECK_MS);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
