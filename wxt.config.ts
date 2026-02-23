import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Auto Groups',
    description: 'Automatically manage tab groups based on external APIs like GitHub PRs',
    permissions: ['tabs', 'tabGroups', 'storage', 'alarms'],
    host_permissions: ['https://api.github.com/'],
    browser_specific_settings: {
      gecko: {
        id: 'auto-groups@extension.dev',
        strict_min_version: '138.0',
      },
    },
  },
});
