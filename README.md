# Auto Groups

A browser extension that automatically manages tab groups based on external APIs like GitHub PRs.

## Features

- **Modular Adapter Architecture** - Easily add new integrations (GitHub, GitLab, Jira, etc.)
- **GitHub Integration** - Track PRs where you're a requested reviewer
- **Automatic Tab Grouping** - Creates and manages tab groups seamlessly
- **Configurable Polling** - Set sync intervals (1, 5, 10, or 30 minutes)
- **Two Fetch Modes**:
  - **Run together** - All adapters sync with a shared interval
  - **Run individually** - Each adapter has its own polling interval

## Installation

### Chrome
1. Build the extension: `npm run build`
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select `.output/chrome-mv3/`

### Firefox
1. Build the extension: `npm run build:firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on" and select `.output/firefox-mv2/manifest.json`

**Note**: Firefox requires version 138+ for tab groups support.

## Development

```bash
# Install dependencies
npm install

# Development (Chrome)
npm run dev

# Development (Firefox)
npm run dev:firefox

# Build for Chrome
npm run build

# Build for Firefox
npm run build:firefox
```

## Adding New Adapters

To add a new adapter (e.g., GitLab, Jira):

1. Create `src/adapters/[adapter-name].ts`:

```typescript
import { AdapterWithInstall } from './types';
import { getAdapterConfig, setAdapterConfig } from '../core/Storage';

export const myAdapter: AdapterWithInstall<MyItem> = {
  name: 'myadapter',
  groupTitle: '🔄 My Adapter',
  description: 'Description of what this adapter does',
  
  async install() {
    await setAdapterConfig('myadapter', {
      enabled: true,
      pollingInterval: 5,
      config: {},
    });
  },
  
  async uninstall() {
    // Cleanup if needed
  },
  
  async fetchItems() {
    // Fetch data from external API
  },
  
  getItemUrl(item) { return item.url; },
  getItemId(item) { return item.id; },
  getItemTitle(item) { return item.title; },
};
```

2. Register in `src/adapters/index.ts`:

```typescript
import { myAdapter } from './myadapter';

export const adapterRegistry = {
  github: githubAdapter,
  myadapter: myAdapter,
};

export const availableAdapters = {
  github: { name: 'github', groupTitle: '🔄 GitHub Reviews', description: '...' },
  myadapter: { name: 'myadapter', groupTitle: '🔄 My Adapter', description: '...' },
};
```

## Tech Stack

- [WXT](https://wxt.dev/) - Web Extension Framework
- React 19
- TypeScript
- Chrome/Firefox Manifest V3

## Permissions

- `tabs` - Create and manage tabs
- `tabGroups` - Create and manage tab groups
- `storage` - Store adapter configurations
- `alarms` - Schedule periodic polling
- `https://api.github.com/` - Access GitHub API
