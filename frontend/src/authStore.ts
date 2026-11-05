import { create } from "zustand";
import { api, setUnauthorizedHandler } from "./api";

interface AuthState {
  required: boolean;
  submit: (password: string) => Promise<void>;
}

let waiting: (() => void)[] = [];

export const useAuthStore = create<AuthState>((set) => ({
  required: false,
  submit: async (password) => {
    await api.auth(password);
    set({ required: false });
    const release = waiting;
    waiting = [];
    release.forEach((resolve) => resolve());
  },
}));

/** Parks every 401 until the password is accepted. See setUnauthorizedHandler. */
export const installAuthGate = (): void => {
  setUnauthorizedHandler(
    () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        useAuthStore.setState({ required: true });
      }),
  );
};

export const resetAuthGate = (): void => {
  waiting = [];
  setUnauthorizedHandler(null);
  useAuthStore.setState({ required: false });
};
