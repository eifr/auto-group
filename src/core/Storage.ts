export interface AdapterConfig {
  enabled: boolean;
  pollingInterval?: number;
  config: Record<string, any>;
}

export interface ExtensionSettings {
  fetchMode: 'together' | 'individual';
  masterEnabled: boolean;
  globalPollingInterval: number;
  installedAdapters: Record<string, AdapterConfig>;
  groupMapping: Record<string, number>;
  lastSync: Record<string, number>;
}

const defaults: ExtensionSettings = {
  fetchMode: 'together',
  masterEnabled: false,
  globalPollingInterval: 5,
  installedAdapters: {},
  groupMapping: {},
  lastSync: {},
};

export const storage = {
  async get<K extends keyof ExtensionSettings>(key: K): Promise<ExtensionSettings[K]> {
    const result = await browser.storage.local.get(key);
    return (result[key] ?? defaults[key]) as ExtensionSettings[K];
  },

  async set<K extends keyof ExtensionSettings>(
    key: K,
    value: ExtensionSettings[K]
  ): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },

  async getAll(): Promise<ExtensionSettings> {
    const result = await browser.storage.local.get(Object.keys(defaults));
    return {
      ...defaults,
      ...result,
    } as ExtensionSettings;
  },

  async setMultiple(settings: Partial<ExtensionSettings>): Promise<void> {
    await browser.storage.local.set(settings);
  },

  defaults,
};

export async function getSettings(): Promise<ExtensionSettings> {
  return storage.getAll();
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  await storage.setMultiple(settings);
}

export async function getAdapterConfig(adapterName: string): Promise<AdapterConfig | null> {
  const adapters = await storage.get('installedAdapters');
  return adapters[adapterName] || null;
}

export async function setAdapterConfig(adapterName: string, config: AdapterConfig): Promise<void> {
  const adapters = await storage.get('installedAdapters');
  adapters[adapterName] = config;
  await storage.set('installedAdapters', adapters);
}

export async function isAdapterInstalled(adapterName: string): Promise<boolean> {
  const adapters = await storage.get('installedAdapters');
  return !!adapters[adapterName];
}

export async function installAdapter(adapterName: string): Promise<void> {
  const adapters = await storage.get('installedAdapters');
  adapters[adapterName] = {
    enabled: true,
    pollingInterval: 5,
    config: {},
  };
  await storage.set('installedAdapters', adapters);
}

export async function uninstallAdapter(adapterName: string): Promise<void> {
  const adapters = await storage.get('installedAdapters');
  delete adapters[adapterName];
  await storage.set('installedAdapters', adapters);
}
