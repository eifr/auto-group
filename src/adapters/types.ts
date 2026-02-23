export interface PullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed' | 'merged';
  repository_url: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
}

export interface SyncItem {
  id: string;
  url: string;
  title: string;
}

export interface AdapterConfig {
  enabled: boolean;
  pollingInterval?: number;
  config: Record<string, any>;
}

export interface AvailableAdapter {
  name: string;
  groupTitle: string;
  description: string;
}

export interface Adapter<T = any> {
  name: string;
  groupTitle: string;
  description: string;
  fetchItems(): Promise<T[]>;
  getItemUrl(item: T): string;
  getItemId(item: T): string;
  getItemTitle(item: T): string;
  isItemActive?(item: T): boolean;
}

export interface AdapterWithInstall<T = any> extends Adapter<T> {
  install(): Promise<void>;
  uninstall(): Promise<void>;
}

export interface AdapterRegistry {
  [key: string]: AdapterWithInstall<any>;
}

export interface AvailableAdapters {
  [key: string]: AvailableAdapter;
}
