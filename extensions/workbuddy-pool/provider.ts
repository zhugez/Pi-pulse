import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { FetchFunction, Model, OAuthCredential, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { loginWorkBuddy, refreshAccount } from "./auth.ts";
import { PROVIDER_ID, PROVIDER_NAME, fetchCatalog, toPiModels, type WbCatalog } from "./catalog.ts";
import type { AccountStore, WbAccount } from "./store.ts";

export const BASE_URL = "https://www.workbuddy.ai/v2";

export interface WorkBuddyProviderOptions {
  store: AccountStore;
  fetchImpl: FetchFunction;
  catalog: () => WbCatalog | undefined;
  setCatalog: (catalog: WbCatalog) => void;
}

const marker = (): OAuthCredential => ({
  type: "oauth",
  access: "workbuddy-pool-managed",
  refresh: "workbuddy-pool-managed",
  expires: 8_640_000_000_000_000,
});

export function createWorkBuddyProvider(options: WorkBuddyProviderOptions): Provider<"openai-completions"> {
  const { store, fetchImpl, catalog, setCatalog } = options;

  const firstAccount = async (): Promise<WbAccount | undefined> => {
    const data = await store.read();
    return data.accounts.find((account) => !account.needsLogin) ?? data.accounts[0];
  };

  const models = (): Model<"openai-completions">[] => toPiModels(catalog() ?? { models: [], efforts: {}, defaultEfforts: {} }, BASE_URL);

  const api = openAICompletionsApi();
  const stream = (model: Model<"openai-completions">, context: Parameters<typeof api.stream>[1], streamOptions: Parameters<typeof api.stream>[2], simple = false) => {
    const merged = { ...streamOptions, fetch: fetchImpl, maxRetries: 0, apiKey: "workbuddy-managed" } as SimpleStreamOptions;
    return simple
      ? api.streamSimple(model, context, merged)
      : api.stream(model, context, merged);
  };

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "WorkBuddy accounts",
        check: async () => {
          const account = await firstAccount();
          return account ? { source: "WorkBuddy", type: "oauth" as const } : undefined;
        },
        resolve: async () => {
          const account = await firstAccount();
          return account ? { auth: { apiKey: "workbuddy-managed" }, source: "OAuth" } : undefined;
        },
      },
      oauth: {
        name: "WorkBuddy (browser sign-in)",
        isSubscription: true,
        login: async (interaction) => {
          const account = await loginWorkBuddy(interaction);
          await store.upsert(account);
          return marker();
        },
        refresh: async (credential) => {
          // Credentials are per account in our store; refresh every expiring account.
          const data = await store.read();
          for (const account of data.accounts) {
            if (account.needsLogin || !account.refreshToken) continue;
            if (account.expiresAt > 0 && account.expiresAt - Math.floor(Date.now() / 1000) > 300) continue;
            const refreshed = await refreshAccount(account);
            if (!refreshed) continue;
            await store.update((storeData) => {
              const current = storeData.accounts.find((a) => a.uid === account.uid);
              if (!current || current.accessToken !== account.accessToken) return;
              current.accessToken = refreshed.accessToken;
              current.refreshToken = refreshed.refreshToken;
              current.expiresAt = refreshed.expiresAt;
              if (refreshed.domain) current.domain = refreshed.domain;
            });
          }
          return { ...credential, expires: Date.now() + 3_600_000 } as OAuthCredential;
        },
        toAuth: async () => ({ apiKey: "workbuddy-managed" }),
      },
    },
    getModels: () => models(),
    async refreshModels(context) {
      if (!context.allowNetwork) return;
      const data = await store.read();
      const account = data.accounts.find((candidate) => !candidate.needsLogin) ?? data.accounts[0];
      if (!account) return;
      try {
        const next = await fetchCatalog(account, context.signal);
        if (next.models.length === 0) return;
        setCatalog(next);
        await context.publish({ models: models() } as never);
      } catch {
        // Keep the previous catalog; a stale list beats an empty model picker.
      }
    },
    streamSimple: (model, context, streamOptions) => stream(model, context, streamOptions, true),
    stream: (model, context, streamOptions) => stream(model, context, streamOptions, false),
  } as Provider<"openai-completions">;
}
