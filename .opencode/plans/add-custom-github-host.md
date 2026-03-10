# Plan: Add Custom GitHub Host Support to Auto Groups

## Overview
This plan implements support for custom GitHub Enterprise hosts in the "auto-groups" extension. Currently, the extension hardcodes `https://api.github.com/` as the host and uses regexes tied to `github.com` to map tabs to Pull Requests. This plan will remove these hardcoded constraints and introduce a UI for users to specify their own GitHub host, using dynamic permissions to ensure the extension remains secure.

## 1. Optional Host Permissions (`wxt.config.ts`)
- Keep `host_permissions: ['https://api.github.com/']` as the default permission.
- **Do not** use `*://*/*`. Instead, we will rely on the `browser.permissions` API to dynamically request access to custom hosts at runtime when the user saves their configuration.

## 2. Extend Adapter Interface (`src/adapters/types.ts`)
- Add an optional method to the `Adapter` interface:
  ```typescript
  extractItemIdFromUrl?(url: string): string | null;
  ```
- This allows adapters to dynamically tell the `TabManager` how to reliably parse an ID from a tab's URL, instead of relying on a hardcoded regex for `github.com`.

## 3. Update GitHub Adapter Logic (`src/adapters/github.ts`)
- Modify `fetchRequestedPRs` to accept and use a custom `host` from the adapter's configuration.
- Automatically determine the correct API base URL. For example, if a user enters an Enterprise host (e.g., `https://github.company.com`), append the `/api/v3` suffix to the base URL automatically if it doesn't already contain it.
- Implement the `extractItemIdFromUrl(url: string)` method in `githubAdapter` to parse the `owner/repo#PR_NUMBER` format accurately from any GitHub domain.
  - Regex: `/([^\/]+\/[^\/]+)\/pull\/(\d+)/`
- Update `saveToken` and `getSavedToken` functions to `saveConfig` and `getSavedConfig` to handle both `token` and `host` configurations.

## 4. Refactor TabManager (`src/core/TabManager.ts`)
- Update the `extractItemId(url: string)` method.
- It should first attempt to call the adapter's `extractItemIdFromUrl(url)` method if it exists.
- If not available, it can safely fall back to the existing hardcoded regexes. This ensures backward compatibility for other potential adapters.

## 5. Update UI for Dynamic Permissions (`entrypoints/popup/App.tsx`)
- Update the UI in the `InstalledTab` component for the `github` adapter.
- Add a new "GitHub Host" text input below or above the Token input, with a placeholder of `https://api.github.com`.
- Modify the `handleSaveToken` function and props to a more generic `handleSaveConfig` that accepts an object containing both `token` and `host`.
- When the user clicks "Save Config":
  1. Check if the provided host is different from the default (`https://api.github.com`).
  2. If it is a custom host, use `browser.permissions.request({ origins: [\`\${host}/*\`] })` to ask the user for permission to access that domain.
  3. Only if the permission is granted (or if it's the default host), dispatch an `UPDATE_ADAPTER_CONFIG` message containing both the token and the selected host.