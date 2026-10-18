/**
 * §281 P6 connectivity store. The api client flips `online` on real network
 * failures and back on any HTTP response; the root layout renders a small
 * banner so users always know when they are looking at cached data.
 */

import { create } from "zustand";

interface NetState {
  online: boolean;
  setOnline: (online: boolean) => void;
}

export const useNetStore = create<NetState>((set) => ({
  online: true,
  setOnline: (online) => set((s) => (s.online === online ? s : { online })),
}));
