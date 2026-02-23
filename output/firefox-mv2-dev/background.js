var background = (function() {
  "use strict";
  function defineBackground(arg) {
    if (arg == null || typeof arg === "function") return { main: arg };
    return arg;
  }
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  const defaults = {
    githubToken: "",
    pollingInterval: 5,
    enabled: false,
    lastSync: 0,
    groupMapping: {}
  };
  const storage = {
    async get(key) {
      const result2 = await browser.storage.local.get(key);
      return result2[key] ?? defaults[key];
    },
    async set(key, value) {
      await browser.storage.local.set({ [key]: value });
    },
    async getAll() {
      const result2 = await browser.storage.local.get(Object.keys(defaults));
      return {
        ...defaults,
        ...result2
      };
    },
    async setMultiple(settings) {
      await browser.storage.local.set(settings);
    },
    defaults
  };
  async function getSettings() {
    return storage.getAll();
  }
  async function getToken() {
    const token = await storage.get("githubToken");
    return token || null;
  }
  async function fetchRequestedPRs() {
    const token = await getToken();
    if (!token) {
      throw new Error("GitHub token not configured");
    }
    const query = "state:open is:pr user-review-requested:@me";
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&per_page=50`;
    const response = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Invalid GitHub token");
      }
      if (response.status === 403) {
        throw new Error("Rate limit exceeded. Please try again later.");
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }
    const data = await response.json();
    return data.items;
  }
  const githubAdapter = {
    name: "github",
    groupTitle: "GitHub Reviews",
    async fetchItems() {
      return fetchRequestedPRs();
    },
    getItemUrl(item) {
      return item.html_url;
    },
    getItemId(item) {
      return `${item.repository.full_name}#${item.number}`;
    },
    getItemTitle(item) {
      return `${item.repository.name} #${item.number}: ${item.title}`;
    },
    isItemActive(item) {
      return item.state === "open";
    }
  };
  const adapterRegistry = {
    github: githubAdapter
  };
  function getAdapter(name) {
    return adapterRegistry[name];
  }
  function getAllAdapters() {
    return Object.values(adapterRegistry);
  }
  const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan"];
  class TabManager {
    groupTitle;
    adapterName;
    constructor(options) {
      this.groupTitle = options.groupTitle;
      this.adapterName = options.adapterName;
    }
    async getGroupId() {
      const mapping = await storage.get("groupMapping");
      return mapping[this.adapterName] || null;
    }
    async setGroupId(groupId) {
      const mapping = await storage.get("groupMapping");
      mapping[this.adapterName] = groupId;
      await storage.set("groupMapping", mapping);
    }
    async syncGroup(items) {
      const currentWindow = await browser.windows.getCurrent();
      if (!currentWindow.id) return;
      const itemIds = new Set(items.map((item) => item.id));
      const existingGroupId = await this.getGroupId();
      let groupId = existingGroupId;
      const allTabs = await browser.tabs.query({ windowId: currentWindow.id });
      const managedTabs = [];
      if (groupId) {
        for (const tab of allTabs) {
          if (tab.groupId === groupId) {
            managedTabs.push(tab);
          }
        }
      }
      const tabsToRemove = [];
      for (const tab of managedTabs) {
        if (tab.url) {
          const itemId = this.extractItemId(tab.url);
          if (itemId && !itemIds.has(itemId)) {
            tabsToRemove.push(tab.id);
          }
        }
      }
      const tabsToAdd = [];
      const existingUrls = new Set(managedTabs.map((t) => t.url).filter((u) => !!u));
      for (const item of items) {
        if (!existingUrls.has(item.url)) {
          const existingTab = allTabs.find((t) => t.url === item.url);
          if (existingTab) {
            tabsToAdd.push(existingTab.id);
          } else {
            const newTab = await browser.tabs.create({ url: item.url, active: false });
            tabsToAdd.push(newTab.id);
          }
        }
      }
      if (tabsToRemove.length > 0) {
        await browser.tabs.ungroup(tabsToRemove);
        await browser.tabs.remove(tabsToRemove);
      }
      if (tabsToAdd.length === 0 && managedTabs.length === 0) {
        return;
      }
      if (tabsToAdd.length > 0) {
        if (groupId) {
          const groupTabs = await browser.tabs.query({ groupId });
          const currentTabIds = groupTabs.map((t) => t.id).filter((id) => id !== void 0);
          if (currentTabIds.length > 0) {
            const allTabIds = [...currentTabIds, ...tabsToAdd];
            await browser.tabs.group({ tabIds: allTabIds });
          } else {
            await browser.tabs.group({ tabIds: tabsToAdd });
          }
        } else {
          const newGroupId = await browser.tabs.group({ tabIds: tabsToAdd });
          const mapping = await storage.get("groupMapping");
          const colorIndex = Object.keys(mapping).length % GROUP_COLORS.length;
          await browser.tabGroups.update(newGroupId, {
            title: this.groupTitle,
            color: GROUP_COLORS[colorIndex]
          });
          await this.setGroupId(newGroupId);
        }
      }
      await storage.set("lastSync", Date.now());
    }
    extractItemId(url) {
      const match = url.match(/github\.com\/([^\/]+\/[^\/]+)\/pull\/(\d+)/);
      if (match) {
        return `${match[1]}#${match[2]}`;
      }
      const prMatch = url.match(/\/pull\/(\d+)/);
      if (prMatch) {
        return prMatch[1];
      }
      return null;
    }
    async removeGroup() {
      const groupId = await this.getGroupId();
      if (!groupId) return;
      try {
        const tabs = await browser.tabs.query({ groupId });
        const tabIds = tabs.map((t) => t.id).filter((id) => id !== void 0);
        if (tabIds.length > 0) {
          await browser.tabs.ungroup(tabIds);
          await browser.tabs.remove(tabIds);
        }
        const mapping = await storage.get("groupMapping");
        delete mapping[this.adapterName];
        await storage.set("groupMapping", mapping);
      } catch {
        const mapping = await storage.get("groupMapping");
        delete mapping[this.adapterName];
        await storage.set("groupMapping", mapping);
      }
    }
  }
  const ALARM_NAME = "auto-groups-polling";
  async function startPolling(intervalMinutes) {
    await browser.alarms.create(ALARM_NAME, {
      periodInMinutes: intervalMinutes
    });
  }
  async function stopPolling() {
    const alarm = await browser.alarms.get(ALARM_NAME);
    if (alarm) {
      await browser.alarms.clear(ALARM_NAME);
    }
  }
  function onAlarm(callback) {
    browser.alarms.onAlarm.addListener(callback);
  }
  async function runAdapterSync(adapterName) {
    const adapter = getAdapter(adapterName);
    if (!adapter) {
      console.error(`Adapter not found: ${adapterName}`);
      return;
    }
    const token = await storage.get("githubToken");
    console.log(`[Auto Groups] Token present: ${!!token}`);
    if (!token && adapterName === "github") {
      console.log("GitHub token not configured, skipping sync");
      return;
    }
    const tabManager = new TabManager({
      groupTitle: adapter.groupTitle,
      adapterName: adapter.name
    });
    try {
      console.log(`[Auto Groups] Fetching items for ${adapterName}...`);
      const items = await adapter.fetchItems();
      console.log(`[Auto Groups] Got ${items.length} items`);
      const syncItems = items.map((item) => ({
        id: adapter.getItemId(item),
        url: adapter.getItemUrl(item),
        title: adapter.getItemTitle(item)
      }));
      await tabManager.syncGroup(syncItems);
      console.log(`[Auto Groups] Synced ${syncItems.length} items for ${adapterName}`);
    } catch (error) {
      console.error(`[Auto Groups] Error syncing ${adapterName}:`, error);
    }
  }
  async function syncAllAdapters(force = false) {
    const settings = await getSettings();
    console.log(`[Auto Groups] Sync called, enabled: ${settings.enabled}, force: ${force}`);
    if (!settings.enabled && !force) {
      console.log("[Auto Groups] Extension disabled, skipping sync");
      return;
    }
    const adapters = getAllAdapters();
    for (const adapter of adapters) {
      await runAdapterSync(adapter.name);
    }
  }
  const definition = defineBackground(() => {
    console.log("Auto Groups extension started");
    browser.runtime.onInstalled.addListener(async () => {
      console.log("Extension installed");
    });
    onAlarm(async (alarm) => {
      if (alarm.name === ALARM_NAME) {
        console.log("Polling alarm triggered");
        await syncAllAdapters();
      }
    });
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area === "local") {
        if (changes.enabled) {
          const enabled = changes.enabled.newValue;
          if (enabled) {
            const interval = await storage.get("pollingInterval");
            await startPolling(interval);
            await syncAllAdapters();
          } else {
            await stopPolling();
          }
        }
      }
    });
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "SYNC_NOW") {
        console.log("[Auto Groups] Manual sync triggered");
        syncAllAdapters(true).then(() => sendResponse({ success: true })).catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }
      if (message.type === "GET_STATUS") {
        getSettings().then((settings) => {
          sendResponse({
            enabled: settings.enabled,
            lastSync: settings.lastSync,
            githubToken: !!settings.githubToken
          });
        });
        return true;
      }
      if (message.type === "TOGGLE_ENABLED") {
        storage.set("enabled", message.enabled).then(async () => {
          if (message.enabled) {
            const interval = await storage.get("pollingInterval");
            await startPolling(interval);
            await syncAllAdapters();
          } else {
            await stopPolling();
          }
          sendResponse({ success: true });
        });
        return true;
      }
    });
    (async () => {
      const settings = await getSettings();
      if (settings.enabled) {
        await startPolling(settings.pollingInterval);
      }
    })();
  });
  function initPlugins() {
  }
  var _MatchPattern = class {
    constructor(matchPattern) {
      if (matchPattern === "<all_urls>") {
        this.isAllUrls = true;
        this.protocolMatches = [..._MatchPattern.PROTOCOLS];
        this.hostnameMatch = "*";
        this.pathnameMatch = "*";
      } else {
        const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
        if (groups == null)
          throw new InvalidMatchPattern(matchPattern, "Incorrect format");
        const [_, protocol, hostname, pathname] = groups;
        validateProtocol(matchPattern, protocol);
        validateHostname(matchPattern, hostname);
        this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
        this.hostnameMatch = hostname;
        this.pathnameMatch = pathname;
      }
    }
    includes(url) {
      if (this.isAllUrls)
        return true;
      const u = typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
      return !!this.protocolMatches.find((protocol) => {
        if (protocol === "http")
          return this.isHttpMatch(u);
        if (protocol === "https")
          return this.isHttpsMatch(u);
        if (protocol === "file")
          return this.isFileMatch(u);
        if (protocol === "ftp")
          return this.isFtpMatch(u);
        if (protocol === "urn")
          return this.isUrnMatch(u);
      });
    }
    isHttpMatch(url) {
      return url.protocol === "http:" && this.isHostPathMatch(url);
    }
    isHttpsMatch(url) {
      return url.protocol === "https:" && this.isHostPathMatch(url);
    }
    isHostPathMatch(url) {
      if (!this.hostnameMatch || !this.pathnameMatch)
        return false;
      const hostnameMatchRegexs = [
        this.convertPatternToRegex(this.hostnameMatch),
        this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, ""))
      ];
      const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
      return !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) && pathnameMatchRegex.test(url.pathname);
    }
    isFileMatch(url) {
      throw Error("Not implemented: file:// pattern matching. Open a PR to add support");
    }
    isFtpMatch(url) {
      throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
    }
    isUrnMatch(url) {
      throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
    }
    convertPatternToRegex(pattern) {
      const escaped = this.escapeForRegex(pattern);
      const starsReplaced = escaped.replace(/\\\*/g, ".*");
      return RegExp(`^${starsReplaced}$`);
    }
    escapeForRegex(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  };
  var MatchPattern = _MatchPattern;
  MatchPattern.PROTOCOLS = ["http", "https", "file", "ftp", "urn"];
  var InvalidMatchPattern = class extends Error {
    constructor(matchPattern, reason) {
      super(`Invalid match pattern "${matchPattern}": ${reason}`);
    }
  };
  function validateProtocol(matchPattern, protocol) {
    if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*")
      throw new InvalidMatchPattern(
        matchPattern,
        `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`
      );
  }
  function validateHostname(matchPattern, hostname) {
    if (hostname.includes(":"))
      throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
    if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*."))
      throw new InvalidMatchPattern(
        matchPattern,
        `If using a wildcard (*), it must go at the start of the hostname`
      );
  }
  function print(method, ...args) {
    if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
    else method("[wxt]", ...args);
  }
  const logger = {
    debug: (...args) => print(console.debug, ...args),
    log: (...args) => print(console.log, ...args),
    warn: (...args) => print(console.warn, ...args),
    error: (...args) => print(console.error, ...args)
  };
  let ws;
  function getDevServerWebSocket() {
    if (ws == null) {
      const serverUrl = "ws://localhost:3000";
      logger.debug("Connecting to dev server @", serverUrl);
      ws = new WebSocket(serverUrl, "vite-hmr");
      ws.addWxtEventListener = ws.addEventListener.bind(ws);
      ws.sendCustom = (event, payload) => ws?.send(JSON.stringify({
        type: "custom",
        event,
        payload
      }));
      ws.addEventListener("open", () => {
        logger.debug("Connected to dev server");
      });
      ws.addEventListener("close", () => {
        logger.debug("Disconnected from dev server");
      });
      ws.addEventListener("error", (event) => {
        logger.error("Failed to connect to dev server", event);
      });
      ws.addEventListener("message", (e) => {
        try {
          const message = JSON.parse(e.data);
          if (message.type === "custom") ws?.dispatchEvent(new CustomEvent(message.event, { detail: message.data }));
        } catch (err) {
          logger.error("Failed to handle message", err);
        }
      });
    }
    return ws;
  }
  function keepServiceWorkerAlive() {
    setInterval(async () => {
      await browser.runtime.getPlatformInfo();
    }, 5e3);
  }
  function reloadContentScript(payload) {
    if (browser.runtime.getManifest().manifest_version == 2) reloadContentScriptMv2();
    else reloadContentScriptMv3(payload);
  }
  async function reloadContentScriptMv3({ registration, contentScript }) {
    if (registration === "runtime") await reloadRuntimeContentScriptMv3(contentScript);
    else await reloadManifestContentScriptMv3(contentScript);
  }
  async function reloadManifestContentScriptMv3(contentScript) {
    const id = `wxt:${contentScript.js[0]}`;
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const existing = registered.find((cs) => cs.id === id);
    if (existing) {
      logger.debug("Updating content script", existing);
      await browser.scripting.updateContentScripts([{
        ...contentScript,
        id,
        css: contentScript.css ?? []
      }]);
    } else {
      logger.debug("Registering new content script...");
      await browser.scripting.registerContentScripts([{
        ...contentScript,
        id,
        css: contentScript.css ?? []
      }]);
    }
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadRuntimeContentScriptMv3(contentScript) {
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const matches = registered.filter((cs) => {
      const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
      const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
      return hasJs || hasCss;
    });
    if (matches.length === 0) {
      logger.log("Content script is not registered yet, nothing to reload", contentScript);
      return;
    }
    await browser.scripting.updateContentScripts(matches);
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadTabsForContentScript(contentScript) {
    const allTabs = await browser.tabs.query({});
    const matchPatterns = contentScript.matches.map((match) => new MatchPattern(match));
    const matchingTabs = allTabs.filter((tab) => {
      const url = tab.url;
      if (!url) return false;
      return !!matchPatterns.find((pattern) => pattern.includes(url));
    });
    await Promise.all(matchingTabs.map(async (tab) => {
      try {
        await browser.tabs.reload(tab.id);
      } catch (err) {
        logger.warn("Failed to reload tab:", err);
      }
    }));
  }
  async function reloadContentScriptMv2(_payload) {
    throw Error("TODO: reloadContentScriptMv2");
  }
  {
    try {
      const ws2 = getDevServerWebSocket();
      ws2.addWxtEventListener("wxt:reload-extension", () => {
        browser.runtime.reload();
      });
      ws2.addWxtEventListener("wxt:reload-content-script", (event) => {
        reloadContentScript(event.detail);
      });
      if (false) ;
    } catch (err) {
      logger.error("Failed to setup web socket connection with dev server", err);
    }
    browser.commands.onCommand.addListener((command) => {
      if (command === "wxt:reload-extension") browser.runtime.reload();
    });
  }
  let result;
  try {
    initPlugins();
    result = definition.main();
    if (result instanceof Promise) console.warn("The background's main() function return a promise, but it must be synchronous");
  } catch (err) {
    logger.error("The background crashed on startup!");
    throw err;
  }
  var background_entrypoint_default = result;
  return background_entrypoint_default;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy9Ad3h0LWRldi9icm93c2VyL3NyYy9pbmRleC5tanMiLCIuLi8uLi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvYnJvd3Nlci5tanMiLCIuLi8uLi9zcmMvY29yZS9TdG9yYWdlLnRzIiwiLi4vLi4vc3JjL2FkYXB0ZXJzL2dpdGh1Yi50cyIsIi4uLy4uL3NyYy9hZGFwdGVycy9pbmRleC50cyIsIi4uLy4uL3NyYy9jb3JlL1RhYk1hbmFnZXIudHMiLCIuLi8uLi9zcmMvY29yZS9TY2hlZHVsZXIudHMiLCIuLi8uLi9lbnRyeXBvaW50cy9iYWNrZ3JvdW5kLnRzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3ZWJleHQtY29yZS9tYXRjaC1wYXR0ZXJucy9saWIvaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8jcmVnaW9uIHNyYy91dGlscy9kZWZpbmUtYmFja2dyb3VuZC50c1xuZnVuY3Rpb24gZGVmaW5lQmFja2dyb3VuZChhcmcpIHtcblx0aWYgKGFyZyA9PSBudWxsIHx8IHR5cGVvZiBhcmcgPT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHsgbWFpbjogYXJnIH07XG5cdHJldHVybiBhcmc7XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgZGVmaW5lQmFja2dyb3VuZCB9OyIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgYnJvd3NlciQxIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcblxuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb24gQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pXG4qIGBgYFxuKiBAbW9kdWxlIHd4dC9icm93c2VyXG4qL1xuY29uc3QgYnJvd3NlciA9IGJyb3dzZXIkMTtcblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBicm93c2VyIH07IiwiZXhwb3J0IGludGVyZmFjZSBFeHRlbnNpb25TZXR0aW5ncyB7XG4gIGdpdGh1YlRva2VuOiBzdHJpbmc7XG4gIHBvbGxpbmdJbnRlcnZhbDogbnVtYmVyO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBsYXN0U3luYzogbnVtYmVyO1xuICBncm91cE1hcHBpbmc6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG59XG5cbmNvbnN0IGRlZmF1bHRzOiBFeHRlbnNpb25TZXR0aW5ncyA9IHtcbiAgZ2l0aHViVG9rZW46ICcnLFxuICBwb2xsaW5nSW50ZXJ2YWw6IDUsXG4gIGVuYWJsZWQ6IGZhbHNlLFxuICBsYXN0U3luYzogMCxcbiAgZ3JvdXBNYXBwaW5nOiB7fSxcbn07XG5cbmV4cG9ydCBjb25zdCBzdG9yYWdlID0ge1xuICBhc3luYyBnZXQ8SyBleHRlbmRzIGtleW9mIEV4dGVuc2lvblNldHRpbmdzPihrZXk6IEspOiBQcm9taXNlPEV4dGVuc2lvblNldHRpbmdzW0tdPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChrZXkpO1xuICAgIHJldHVybiAocmVzdWx0W2tleV0gPz8gZGVmYXVsdHNba2V5XSkgYXMgRXh0ZW5zaW9uU2V0dGluZ3NbS107XG4gIH0sXG5cbiAgYXN5bmMgc2V0PEsgZXh0ZW5kcyBrZXlvZiBFeHRlbnNpb25TZXR0aW5ncz4oXG4gICAga2V5OiBLLFxuICAgIHZhbHVlOiBFeHRlbnNpb25TZXR0aW5nc1tLXVxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuc2V0KHsgW2tleV06IHZhbHVlIH0pO1xuICB9LFxuXG4gIGFzeW5jIGdldEFsbCgpOiBQcm9taXNlPEV4dGVuc2lvblNldHRpbmdzPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChPYmplY3Qua2V5cyhkZWZhdWx0cykpO1xuICAgIHJldHVybiB7XG4gICAgICAuLi5kZWZhdWx0cyxcbiAgICAgIC4uLnJlc3VsdCxcbiAgICB9IGFzIEV4dGVuc2lvblNldHRpbmdzO1xuICB9LFxuXG4gIGFzeW5jIHNldE11bHRpcGxlKHNldHRpbmdzOiBQYXJ0aWFsPEV4dGVuc2lvblNldHRpbmdzPik6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5zZXQoc2V0dGluZ3MpO1xuICB9LFxuXG4gIGRlZmF1bHRzLFxufTtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8RXh0ZW5zaW9uU2V0dGluZ3M+IHtcbiAgcmV0dXJuIHN0b3JhZ2UuZ2V0QWxsKCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moc2V0dGluZ3M6IFBhcnRpYWw8RXh0ZW5zaW9uU2V0dGluZ3M+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHN0b3JhZ2Uuc2V0TXVsdGlwbGUoc2V0dGluZ3MpO1xufVxuIiwiaW1wb3J0IHsgQWRhcHRlciwgUHVsbFJlcXVlc3QsIFN5bmNJdGVtIH0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgeyBzdG9yYWdlIH0gZnJvbSAnLi4vY29yZS9TdG9yYWdlJztcblxuaW50ZXJmYWNlIEdpdEh1YlNlYXJjaFJlc3BvbnNlIHtcbiAgdG90YWxfY291bnQ6IG51bWJlcjtcbiAgaW5jb21wbGV0ZV9yZXN1bHRzOiBib29sZWFuO1xuICBpdGVtczogUHVsbFJlcXVlc3RbXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0VG9rZW4oKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2dpdGh1YlRva2VuJyk7XG4gIHJldHVybiB0b2tlbiB8fCBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hSZXF1ZXN0ZWRQUnMoKTogUHJvbWlzZTxQdWxsUmVxdWVzdFtdPiB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgZ2V0VG9rZW4oKTtcbiAgaWYgKCF0b2tlbikge1xuICAgIHRocm93IG5ldyBFcnJvcignR2l0SHViIHRva2VuIG5vdCBjb25maWd1cmVkJyk7XG4gIH1cblxuICBjb25zdCBxdWVyeSA9ICdzdGF0ZTpvcGVuIGlzOnByIHVzZXItcmV2aWV3LXJlcXVlc3RlZDpAbWUnO1xuICBjb25zdCB1cmwgPSBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9zZWFyY2gvaXNzdWVzP3E9JHtlbmNvZGVVUklDb21wb25lbnQocXVlcnkpfSZzb3J0PXVwZGF0ZWQmcGVyX3BhZ2U9NTBgO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi92bmQuZ2l0aHViLnYzK2pzb24nLFxuICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dG9rZW59YCxcbiAgICAgICdYLUdpdEh1Yi1BcGktVmVyc2lvbic6ICcyMDIyLTExLTI4JyxcbiAgICB9LFxuICB9KTtcblxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgR2l0SHViIHRva2VuJyk7XG4gICAgfVxuICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdSYXRlIGxpbWl0IGV4Y2VlZGVkLiBQbGVhc2UgdHJ5IGFnYWluIGxhdGVyLicpO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgRXJyb3IoYEdpdEh1YiBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICB9XG5cbiAgY29uc3QgZGF0YTogR2l0SHViU2VhcmNoUmVzcG9uc2UgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIHJldHVybiBkYXRhLml0ZW1zO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFwUFJUb1N5bmNJdGVtKHByOiBQdWxsUmVxdWVzdCk6IFN5bmNJdGVtIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogYCR7cHIucmVwb3NpdG9yeS5mdWxsX25hbWV9IyR7cHIubnVtYmVyfWAsXG4gICAgdXJsOiBwci5odG1sX3VybCxcbiAgICB0aXRsZTogYCR7cHIucmVwb3NpdG9yeS5uYW1lfSAjJHtwci5udW1iZXJ9OiAke3ByLnRpdGxlfWAsXG4gIH07XG59XG5cbmV4cG9ydCBjb25zdCBnaXRodWJBZGFwdGVyOiBBZGFwdGVyPFB1bGxSZXF1ZXN0PiA9IHtcbiAgbmFtZTogJ2dpdGh1YicsXG4gIGdyb3VwVGl0bGU6ICdHaXRIdWIgUmV2aWV3cycsXG5cbiAgYXN5bmMgZmV0Y2hJdGVtcygpIHtcbiAgICByZXR1cm4gZmV0Y2hSZXF1ZXN0ZWRQUnMoKTtcbiAgfSxcblxuICBnZXRJdGVtVXJsKGl0ZW06IFB1bGxSZXF1ZXN0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gaXRlbS5odG1sX3VybDtcbiAgfSxcblxuICBnZXRJdGVtSWQoaXRlbTogUHVsbFJlcXVlc3QpOiBzdHJpbmcge1xuICAgIHJldHVybiBgJHtpdGVtLnJlcG9zaXRvcnkuZnVsbF9uYW1lfSMke2l0ZW0ubnVtYmVyfWA7XG4gIH0sXG5cbiAgZ2V0SXRlbVRpdGxlKGl0ZW06IFB1bGxSZXF1ZXN0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gYCR7aXRlbS5yZXBvc2l0b3J5Lm5hbWV9ICMke2l0ZW0ubnVtYmVyfTogJHtpdGVtLnRpdGxlfWA7XG4gIH0sXG5cbiAgaXNJdGVtQWN0aXZlKGl0ZW06IFB1bGxSZXF1ZXN0KTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGl0ZW0uc3RhdGUgPT09ICdvcGVuJztcbiAgfSxcbn07XG4iLCJpbXBvcnQgdHlwZSB7IEFkYXB0ZXIsIEFkYXB0ZXJSZWdpc3RyeSB9IGZyb20gJy4vdHlwZXMnO1xuaW1wb3J0IHsgZ2l0aHViQWRhcHRlciB9IGZyb20gJy4vZ2l0aHViJztcblxuZXhwb3J0IHR5cGUgeyBBZGFwdGVyLCBTeW5jSXRlbSwgUHVsbFJlcXVlc3QsIEFkYXB0ZXJSZWdpc3RyeSB9IGZyb20gJy4vdHlwZXMnO1xuZXhwb3J0IHsgZ2l0aHViQWRhcHRlciB9IGZyb20gJy4vZ2l0aHViJztcblxuZXhwb3J0IGNvbnN0IGFkYXB0ZXJSZWdpc3RyeTogQWRhcHRlclJlZ2lzdHJ5ID0ge1xuICBnaXRodWI6IGdpdGh1YkFkYXB0ZXIsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWRhcHRlcihuYW1lOiBzdHJpbmcpOiBBZGFwdGVyPGFueT4gfCB1bmRlZmluZWQge1xuICByZXR1cm4gYWRhcHRlclJlZ2lzdHJ5W25hbWVdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWxsQWRhcHRlcnMoKTogQWRhcHRlcjxhbnk+W10ge1xuICByZXR1cm4gT2JqZWN0LnZhbHVlcyhhZGFwdGVyUmVnaXN0cnkpO1xufVxuIiwiaW1wb3J0IHsgU3luY0l0ZW0gfSBmcm9tICcuLi9hZGFwdGVycy90eXBlcyc7XG5pbXBvcnQgeyBzdG9yYWdlIH0gZnJvbSAnLi9TdG9yYWdlJztcblxuY29uc3QgR1JPVVBfQ09MT1JTID0gWydncmV5JywgJ2JsdWUnLCAncmVkJywgJ3llbGxvdycsICdncmVlbicsICdwaW5rJywgJ3B1cnBsZScsICdjeWFuJ10gYXMgY29uc3Q7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGFiTWFuYWdlck9wdGlvbnMge1xuICBncm91cFRpdGxlOiBzdHJpbmc7XG4gIGFkYXB0ZXJOYW1lOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBUYWJNYW5hZ2VyIHtcbiAgcHJpdmF0ZSBncm91cFRpdGxlOiBzdHJpbmc7XG4gIHByaXZhdGUgYWRhcHRlck5hbWU6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBUYWJNYW5hZ2VyT3B0aW9ucykge1xuICAgIHRoaXMuZ3JvdXBUaXRsZSA9IG9wdGlvbnMuZ3JvdXBUaXRsZTtcbiAgICB0aGlzLmFkYXB0ZXJOYW1lID0gb3B0aW9ucy5hZGFwdGVyTmFtZTtcbiAgfVxuXG4gIGFzeW5jIGdldEdyb3VwSWQoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gICAgY29uc3QgbWFwcGluZyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdncm91cE1hcHBpbmcnKTtcbiAgICByZXR1cm4gbWFwcGluZ1t0aGlzLmFkYXB0ZXJOYW1lXSB8fCBudWxsO1xuICB9XG5cbiAgYXN5bmMgc2V0R3JvdXBJZChncm91cElkOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBtYXBwaW5nID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2dyb3VwTWFwcGluZycpO1xuICAgIG1hcHBpbmdbdGhpcy5hZGFwdGVyTmFtZV0gPSBncm91cElkO1xuICAgIGF3YWl0IHN0b3JhZ2Uuc2V0KCdncm91cE1hcHBpbmcnLCBtYXBwaW5nKTtcbiAgfVxuXG4gIGFzeW5jIHN5bmNHcm91cChpdGVtczogU3luY0l0ZW1bXSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGN1cnJlbnRXaW5kb3cgPSBhd2FpdCBicm93c2VyLndpbmRvd3MuZ2V0Q3VycmVudCgpO1xuICAgIGlmICghY3VycmVudFdpbmRvdy5pZCkgcmV0dXJuO1xuXG4gICAgY29uc3QgaXRlbUlkcyA9IG5ldyBTZXQoaXRlbXMubWFwKGl0ZW0gPT4gaXRlbS5pZCkpO1xuICAgIGNvbnN0IGV4aXN0aW5nR3JvdXBJZCA9IGF3YWl0IHRoaXMuZ2V0R3JvdXBJZCgpO1xuICAgIGxldCBncm91cElkID0gZXhpc3RpbmdHcm91cElkO1xuXG4gICAgY29uc3QgYWxsVGFicyA9IGF3YWl0IGJyb3dzZXIudGFicy5xdWVyeSh7IHdpbmRvd0lkOiBjdXJyZW50V2luZG93LmlkIH0pO1xuICAgIGNvbnN0IG1hbmFnZWRUYWJzOiBicm93c2VyLnRhYnMuVGFiW10gPSBbXTtcblxuICAgIGlmIChncm91cElkKSB7XG4gICAgICBmb3IgKGNvbnN0IHRhYiBvZiBhbGxUYWJzKSB7XG4gICAgICAgIGlmICh0YWIuZ3JvdXBJZCA9PT0gZ3JvdXBJZCkge1xuICAgICAgICAgIG1hbmFnZWRUYWJzLnB1c2godGFiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHRhYnNUb1JlbW92ZTogbnVtYmVyW10gPSBbXTtcblxuICAgIGZvciAoY29uc3QgdGFiIG9mIG1hbmFnZWRUYWJzKSB7XG4gICAgICBpZiAodGFiLnVybCkge1xuICAgICAgICBjb25zdCBpdGVtSWQgPSB0aGlzLmV4dHJhY3RJdGVtSWQodGFiLnVybCk7XG4gICAgICAgIGlmIChpdGVtSWQgJiYgIWl0ZW1JZHMuaGFzKGl0ZW1JZCkpIHtcbiAgICAgICAgICB0YWJzVG9SZW1vdmUucHVzaCh0YWIuaWQhKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHRhYnNUb0FkZDogbnVtYmVyW10gPSBbXTtcbiAgICBjb25zdCBleGlzdGluZ1VybHMgPSBuZXcgU2V0KG1hbmFnZWRUYWJzLm1hcCh0ID0+IHQudXJsKS5maWx0ZXIoKHUpOiB1IGlzIHN0cmluZyA9PiAhIXUpKTtcblxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgaWYgKCFleGlzdGluZ1VybHMuaGFzKGl0ZW0udXJsKSkge1xuICAgICAgICBjb25zdCBleGlzdGluZ1RhYiA9IGFsbFRhYnMuZmluZCh0ID0+IHQudXJsID09PSBpdGVtLnVybCk7XG4gICAgICAgIGlmIChleGlzdGluZ1RhYikge1xuICAgICAgICAgIHRhYnNUb0FkZC5wdXNoKGV4aXN0aW5nVGFiLmlkISk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgbmV3VGFiID0gYXdhaXQgYnJvd3Nlci50YWJzLmNyZWF0ZSh7IHVybDogaXRlbS51cmwsIGFjdGl2ZTogZmFsc2UgfSk7XG4gICAgICAgICAgdGFic1RvQWRkLnB1c2gobmV3VGFiLmlkISk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGFic1RvUmVtb3ZlLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IGJyb3dzZXIudGFicy51bmdyb3VwKHRhYnNUb1JlbW92ZSk7XG4gICAgICBhd2FpdCBicm93c2VyLnRhYnMucmVtb3ZlKHRhYnNUb1JlbW92ZSk7XG4gICAgfVxuXG4gICAgaWYgKHRhYnNUb0FkZC5sZW5ndGggPT09IDAgJiYgbWFuYWdlZFRhYnMubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHRhYnNUb0FkZC5sZW5ndGggPiAwKSB7XG4gICAgICBpZiAoZ3JvdXBJZCkge1xuICAgICAgICBjb25zdCBncm91cFRhYnMgPSBhd2FpdCBicm93c2VyLnRhYnMucXVlcnkoeyBncm91cElkOiBncm91cElkIH0pO1xuICAgICAgICBjb25zdCBjdXJyZW50VGFiSWRzID0gZ3JvdXBUYWJzLm1hcCh0ID0+IHQuaWQpLmZpbHRlcigoaWQpOiBpZCBpcyBudW1iZXIgPT4gaWQgIT09IHVuZGVmaW5lZCk7XG4gICAgICAgIGlmIChjdXJyZW50VGFiSWRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCBhbGxUYWJJZHMgPSBbLi4uY3VycmVudFRhYklkcywgLi4udGFic1RvQWRkXTtcbiAgICAgICAgICBhd2FpdCBicm93c2VyLnRhYnMuZ3JvdXAoeyB0YWJJZHM6IGFsbFRhYklkcyB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhd2FpdCBicm93c2VyLnRhYnMuZ3JvdXAoeyB0YWJJZHM6IHRhYnNUb0FkZCBhcyBbbnVtYmVyLCAuLi5udW1iZXJbXV0gfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IG5ld0dyb3VwSWQgPSBhd2FpdCBicm93c2VyLnRhYnMuZ3JvdXAoeyB0YWJJZHM6IHRhYnNUb0FkZCBhcyBbbnVtYmVyLCAuLi5udW1iZXJbXV0gfSk7XG4gICAgICAgIGNvbnN0IG1hcHBpbmcgPSBhd2FpdCBzdG9yYWdlLmdldCgnZ3JvdXBNYXBwaW5nJyk7XG4gICAgICAgIGNvbnN0IGNvbG9ySW5kZXggPSBPYmplY3Qua2V5cyhtYXBwaW5nKS5sZW5ndGggJSBHUk9VUF9DT0xPUlMubGVuZ3RoO1xuICAgICAgICBhd2FpdCBicm93c2VyLnRhYkdyb3Vwcy51cGRhdGUobmV3R3JvdXBJZCwge1xuICAgICAgICAgIHRpdGxlOiB0aGlzLmdyb3VwVGl0bGUsXG4gICAgICAgICAgY29sb3I6IEdST1VQX0NPTE9SU1tjb2xvckluZGV4XSxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IHRoaXMuc2V0R3JvdXBJZChuZXdHcm91cElkKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBhd2FpdCBzdG9yYWdlLnNldCgnbGFzdFN5bmMnLCBEYXRlLm5vdygpKTtcbiAgfVxuXG4gIHByaXZhdGUgZXh0cmFjdEl0ZW1JZCh1cmw6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAgIGNvbnN0IG1hdGNoID0gdXJsLm1hdGNoKC9naXRodWJcXC5jb21cXC8oW15cXC9dK1xcL1teXFwvXSspXFwvcHVsbFxcLyhcXGQrKS8pO1xuICAgIGlmIChtYXRjaCkge1xuICAgICAgcmV0dXJuIGAke21hdGNoWzFdfSMke21hdGNoWzJdfWA7XG4gICAgfVxuICAgIGNvbnN0IHByTWF0Y2ggPSB1cmwubWF0Y2goL1xcL3B1bGxcXC8oXFxkKykvKTtcbiAgICBpZiAocHJNYXRjaCkge1xuICAgICAgcmV0dXJuIHByTWF0Y2hbMV07XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgYXN5bmMgcmVtb3ZlR3JvdXAoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZ3JvdXBJZCA9IGF3YWl0IHRoaXMuZ2V0R3JvdXBJZCgpO1xuICAgIGlmICghZ3JvdXBJZCkgcmV0dXJuO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhYnMgPSBhd2FpdCBicm93c2VyLnRhYnMucXVlcnkoeyBncm91cElkOiBncm91cElkIH0pO1xuICAgICAgY29uc3QgdGFiSWRzID0gdGFicy5tYXAodCA9PiB0LmlkKS5maWx0ZXIoKGlkKTogaWQgaXMgbnVtYmVyID0+IGlkICE9PSB1bmRlZmluZWQpO1xuICAgICAgXG4gICAgICBpZiAodGFiSWRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXdhaXQgYnJvd3Nlci50YWJzLnVuZ3JvdXAodGFiSWRzKTtcbiAgICAgICAgYXdhaXQgYnJvd3Nlci50YWJzLnJlbW92ZSh0YWJJZHMpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYXBwaW5nID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2dyb3VwTWFwcGluZycpO1xuICAgICAgZGVsZXRlIG1hcHBpbmdbdGhpcy5hZGFwdGVyTmFtZV07XG4gICAgICBhd2FpdCBzdG9yYWdlLnNldCgnZ3JvdXBNYXBwaW5nJywgbWFwcGluZyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb25zdCBtYXBwaW5nID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2dyb3VwTWFwcGluZycpO1xuICAgICAgZGVsZXRlIG1hcHBpbmdbdGhpcy5hZGFwdGVyTmFtZV07XG4gICAgICBhd2FpdCBzdG9yYWdlLnNldCgnZ3JvdXBNYXBwaW5nJywgbWFwcGluZyk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmaW5kVGFiQnlVcmwodXJsOiBzdHJpbmcpOiBQcm9taXNlPGJyb3dzZXIudGFicy5UYWIgfCBudWxsPiB7XG4gIGNvbnN0IHRhYnMgPSBhd2FpdCBicm93c2VyLnRhYnMucXVlcnkoeyB1cmwgfSk7XG4gIHJldHVybiB0YWJzWzBdIHx8IG51bGw7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjcmVhdGVUYWIodXJsOiBzdHJpbmcpOiBQcm9taXNlPGJyb3dzZXIudGFicy5UYWI+IHtcbiAgcmV0dXJuIGJyb3dzZXIudGFicy5jcmVhdGUoeyB1cmwsIGFjdGl2ZTogZmFsc2UgfSk7XG59XG4iLCJpbXBvcnQgeyBzdG9yYWdlIH0gZnJvbSAnLi9TdG9yYWdlJztcblxuZXhwb3J0IGNvbnN0IEFMQVJNX05BTUUgPSAnYXV0by1ncm91cHMtcG9sbGluZyc7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydFBvbGxpbmcoaW50ZXJ2YWxNaW51dGVzOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgYnJvd3Nlci5hbGFybXMuY3JlYXRlKEFMQVJNX05BTUUsIHtcbiAgICBwZXJpb2RJbk1pbnV0ZXM6IGludGVydmFsTWludXRlcyxcbiAgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdG9wUG9sbGluZygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYWxhcm0gPSBhd2FpdCBicm93c2VyLmFsYXJtcy5nZXQoQUxBUk1fTkFNRSk7XG4gIGlmIChhbGFybSkge1xuICAgIGF3YWl0IGJyb3dzZXIuYWxhcm1zLmNsZWFyKEFMQVJNX05BTUUpO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRQb2xsaW5nSW50ZXJ2YWwoKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIHN0b3JhZ2UuZ2V0KCdwb2xsaW5nSW50ZXJ2YWwnKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldFBvbGxpbmdJbnRlcnZhbChpbnRlcnZhbE1pbnV0ZXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBzdG9yYWdlLnNldCgncG9sbGluZ0ludGVydmFsJywgaW50ZXJ2YWxNaW51dGVzKTtcbiAgXG4gIGNvbnN0IGFsYXJtID0gYXdhaXQgYnJvd3Nlci5hbGFybXMuZ2V0KEFMQVJNX05BTUUpO1xuICBpZiAoYWxhcm0pIHtcbiAgICBhd2FpdCBicm93c2VyLmFsYXJtcy5jbGVhcihBTEFSTV9OQU1FKTtcbiAgICBhd2FpdCBicm93c2VyLmFsYXJtcy5jcmVhdGUoQUxBUk1fTkFNRSwge1xuICAgICAgcGVyaW9kSW5NaW51dGVzOiBpbnRlcnZhbE1pbnV0ZXMsXG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uQWxhcm0oY2FsbGJhY2s6IChhbGFybTogYnJvd3Nlci5hbGFybXMuQWxhcm0pID0+IHZvaWQpOiB2b2lkIHtcbiAgYnJvd3Nlci5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcihjYWxsYmFjayk7XG59XG4iLCJpbXBvcnQgeyBnZXRBZGFwdGVyLCBnZXRBbGxBZGFwdGVycywgZ2l0aHViQWRhcHRlciB9IGZyb20gJy4uL3NyYy9hZGFwdGVycyc7XG5pbXBvcnQgeyBUYWJNYW5hZ2VyIH0gZnJvbSAnLi4vc3JjL2NvcmUvVGFiTWFuYWdlcic7XG5pbXBvcnQgeyBzdG9yYWdlLCBnZXRTZXR0aW5ncyB9IGZyb20gJy4uL3NyYy9jb3JlL1N0b3JhZ2UnO1xuaW1wb3J0IHsgc3RhcnRQb2xsaW5nLCBzdG9wUG9sbGluZywgQUxBUk1fTkFNRSwgb25BbGFybSB9IGZyb20gJy4uL3NyYy9jb3JlL1NjaGVkdWxlcic7XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkFkYXB0ZXJTeW5jKGFkYXB0ZXJOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYWRhcHRlciA9IGdldEFkYXB0ZXIoYWRhcHRlck5hbWUpO1xuICBpZiAoIWFkYXB0ZXIpIHtcbiAgICBjb25zb2xlLmVycm9yKGBBZGFwdGVyIG5vdCBmb3VuZDogJHthZGFwdGVyTmFtZX1gKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0b2tlbiA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdnaXRodWJUb2tlbicpO1xuICBjb25zb2xlLmxvZyhgW0F1dG8gR3JvdXBzXSBUb2tlbiBwcmVzZW50OiAkeyEhdG9rZW59YCk7XG4gIFxuICBpZiAoIXRva2VuICYmIGFkYXB0ZXJOYW1lID09PSAnZ2l0aHViJykge1xuICAgIGNvbnNvbGUubG9nKCdHaXRIdWIgdG9rZW4gbm90IGNvbmZpZ3VyZWQsIHNraXBwaW5nIHN5bmMnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0YWJNYW5hZ2VyID0gbmV3IFRhYk1hbmFnZXIoe1xuICAgIGdyb3VwVGl0bGU6IGFkYXB0ZXIuZ3JvdXBUaXRsZSxcbiAgICBhZGFwdGVyTmFtZTogYWRhcHRlci5uYW1lLFxuICB9KTtcblxuICB0cnkge1xuICAgIGNvbnNvbGUubG9nKGBbQXV0byBHcm91cHNdIEZldGNoaW5nIGl0ZW1zIGZvciAke2FkYXB0ZXJOYW1lfS4uLmApO1xuICAgIGNvbnN0IGl0ZW1zID0gYXdhaXQgYWRhcHRlci5mZXRjaEl0ZW1zKCk7XG4gICAgY29uc29sZS5sb2coYFtBdXRvIEdyb3Vwc10gR290ICR7aXRlbXMubGVuZ3RofSBpdGVtc2ApO1xuICAgIFxuICAgIGNvbnN0IHN5bmNJdGVtcyA9IGl0ZW1zLm1hcChpdGVtID0+ICh7XG4gICAgICBpZDogYWRhcHRlci5nZXRJdGVtSWQoaXRlbSksXG4gICAgICB1cmw6IGFkYXB0ZXIuZ2V0SXRlbVVybChpdGVtKSxcbiAgICAgIHRpdGxlOiBhZGFwdGVyLmdldEl0ZW1UaXRsZShpdGVtKSxcbiAgICB9KSk7XG4gICAgXG4gICAgYXdhaXQgdGFiTWFuYWdlci5zeW5jR3JvdXAoc3luY0l0ZW1zKTtcbiAgICBjb25zb2xlLmxvZyhgW0F1dG8gR3JvdXBzXSBTeW5jZWQgJHtzeW5jSXRlbXMubGVuZ3RofSBpdGVtcyBmb3IgJHthZGFwdGVyTmFtZX1gKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKGBbQXV0byBHcm91cHNdIEVycm9yIHN5bmNpbmcgJHthZGFwdGVyTmFtZX06YCwgZXJyb3IpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNBbGxBZGFwdGVycyhmb3JjZTogYm9vbGVhbiA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNldHRpbmdzID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcbiAgY29uc29sZS5sb2coYFtBdXRvIEdyb3Vwc10gU3luYyBjYWxsZWQsIGVuYWJsZWQ6ICR7c2V0dGluZ3MuZW5hYmxlZH0sIGZvcmNlOiAke2ZvcmNlfWApO1xuICBcbiAgaWYgKCFzZXR0aW5ncy5lbmFibGVkICYmICFmb3JjZSkge1xuICAgIGNvbnNvbGUubG9nKCdbQXV0byBHcm91cHNdIEV4dGVuc2lvbiBkaXNhYmxlZCwgc2tpcHBpbmcgc3luYycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGFkYXB0ZXJzID0gZ2V0QWxsQWRhcHRlcnMoKTtcbiAgZm9yIChjb25zdCBhZGFwdGVyIG9mIGFkYXB0ZXJzKSB7XG4gICAgYXdhaXQgcnVuQWRhcHRlclN5bmMoYWRhcHRlci5uYW1lKTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVCYWNrZ3JvdW5kKCgpID0+IHtcbiAgY29uc29sZS5sb2coJ0F1dG8gR3JvdXBzIGV4dGVuc2lvbiBzdGFydGVkJyk7XG5cbiAgYnJvd3Nlci5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKGFzeW5jICgpID0+IHtcbiAgICBjb25zb2xlLmxvZygnRXh0ZW5zaW9uIGluc3RhbGxlZCcpO1xuICB9KTtcblxuICBvbkFsYXJtKGFzeW5jIChhbGFybSkgPT4ge1xuICAgIGlmIChhbGFybS5uYW1lID09PSBBTEFSTV9OQU1FKSB7XG4gICAgICBjb25zb2xlLmxvZygnUG9sbGluZyBhbGFybSB0cmlnZ2VyZWQnKTtcbiAgICAgIGF3YWl0IHN5bmNBbGxBZGFwdGVycygpO1xuICAgIH1cbiAgfSk7XG5cbiAgYnJvd3Nlci5zdG9yYWdlLm9uQ2hhbmdlZC5hZGRMaXN0ZW5lcihhc3luYyAoY2hhbmdlcywgYXJlYSkgPT4ge1xuICAgIGlmIChhcmVhID09PSAnbG9jYWwnKSB7XG4gICAgICBpZiAoY2hhbmdlcy5lbmFibGVkKSB7XG4gICAgICAgIGNvbnN0IGVuYWJsZWQgPSBjaGFuZ2VzLmVuYWJsZWQubmV3VmFsdWU7XG4gICAgICAgIGlmIChlbmFibGVkKSB7XG4gICAgICAgICAgY29uc3QgaW50ZXJ2YWwgPSBhd2FpdCBzdG9yYWdlLmdldCgncG9sbGluZ0ludGVydmFsJyk7XG4gICAgICAgICAgYXdhaXQgc3RhcnRQb2xsaW5nKGludGVydmFsKTtcbiAgICAgICAgICBhd2FpdCBzeW5jQWxsQWRhcHRlcnMoKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhd2FpdCBzdG9wUG9sbGluZygpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICBicm93c2VyLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBfc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnU1lOQ19OT1cnKSB7XG4gICAgICBjb25zb2xlLmxvZygnW0F1dG8gR3JvdXBzXSBNYW51YWwgc3luYyB0cmlnZ2VyZWQnKTtcbiAgICAgIHN5bmNBbGxBZGFwdGVycyh0cnVlKS50aGVuKCgpID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSkpXG4gICAgICAgIC5jYXRjaChlcnIgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBlcnIubWVzc2FnZSB9KSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ0dFVF9TVEFUVVMnKSB7XG4gICAgICBnZXRTZXR0aW5ncygpLnRoZW4oc2V0dGluZ3MgPT4ge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBcbiAgICAgICAgICBlbmFibGVkOiBzZXR0aW5ncy5lbmFibGVkLCBcbiAgICAgICAgICBsYXN0U3luYzogc2V0dGluZ3MubGFzdFN5bmMsXG4gICAgICAgICAgZ2l0aHViVG9rZW46ICEhc2V0dGluZ3MuZ2l0aHViVG9rZW4sXG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnVE9HR0xFX0VOQUJMRUQnKSB7XG4gICAgICBzdG9yYWdlLnNldCgnZW5hYmxlZCcsIG1lc3NhZ2UuZW5hYmxlZCkudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmIChtZXNzYWdlLmVuYWJsZWQpIHtcbiAgICAgICAgICBjb25zdCBpbnRlcnZhbCA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdwb2xsaW5nSW50ZXJ2YWwnKTtcbiAgICAgICAgICBhd2FpdCBzdGFydFBvbGxpbmcoaW50ZXJ2YWwpO1xuICAgICAgICAgIGF3YWl0IHN5bmNBbGxBZGFwdGVycygpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGF3YWl0IHN0b3BQb2xsaW5nKCk7XG4gICAgICAgIH1cbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9KTtcblxuICAoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNldHRpbmdzID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcbiAgICBpZiAoc2V0dGluZ3MuZW5hYmxlZCkge1xuICAgICAgYXdhaXQgc3RhcnRQb2xsaW5nKHNldHRpbmdzLnBvbGxpbmdJbnRlcnZhbCk7XG4gICAgfVxuICB9KSgpO1xufSk7XG4iLCIvLyBzcmMvaW5kZXgudHNcbnZhciBfTWF0Y2hQYXR0ZXJuID0gY2xhc3Mge1xuICBjb25zdHJ1Y3RvcihtYXRjaFBhdHRlcm4pIHtcbiAgICBpZiAobWF0Y2hQYXR0ZXJuID09PSBcIjxhbGxfdXJscz5cIikge1xuICAgICAgdGhpcy5pc0FsbFVybHMgPSB0cnVlO1xuICAgICAgdGhpcy5wcm90b2NvbE1hdGNoZXMgPSBbLi4uX01hdGNoUGF0dGVybi5QUk9UT0NPTFNdO1xuICAgICAgdGhpcy5ob3N0bmFtZU1hdGNoID0gXCIqXCI7XG4gICAgICB0aGlzLnBhdGhuYW1lTWF0Y2ggPSBcIipcIjtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgZ3JvdXBzID0gLyguKik6XFwvXFwvKC4qPykoXFwvLiopLy5leGVjKG1hdGNoUGF0dGVybik7XG4gICAgICBpZiAoZ3JvdXBzID09IG51bGwpXG4gICAgICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgXCJJbmNvcnJlY3QgZm9ybWF0XCIpO1xuICAgICAgY29uc3QgW18sIHByb3RvY29sLCBob3N0bmFtZSwgcGF0aG5hbWVdID0gZ3JvdXBzO1xuICAgICAgdmFsaWRhdGVQcm90b2NvbChtYXRjaFBhdHRlcm4sIHByb3RvY29sKTtcbiAgICAgIHZhbGlkYXRlSG9zdG5hbWUobWF0Y2hQYXR0ZXJuLCBob3N0bmFtZSk7XG4gICAgICB2YWxpZGF0ZVBhdGhuYW1lKG1hdGNoUGF0dGVybiwgcGF0aG5hbWUpO1xuICAgICAgdGhpcy5wcm90b2NvbE1hdGNoZXMgPSBwcm90b2NvbCA9PT0gXCIqXCIgPyBbXCJodHRwXCIsIFwiaHR0cHNcIl0gOiBbcHJvdG9jb2xdO1xuICAgICAgdGhpcy5ob3N0bmFtZU1hdGNoID0gaG9zdG5hbWU7XG4gICAgICB0aGlzLnBhdGhuYW1lTWF0Y2ggPSBwYXRobmFtZTtcbiAgICB9XG4gIH1cbiAgaW5jbHVkZXModXJsKSB7XG4gICAgaWYgKHRoaXMuaXNBbGxVcmxzKVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgdSA9IHR5cGVvZiB1cmwgPT09IFwic3RyaW5nXCIgPyBuZXcgVVJMKHVybCkgOiB1cmwgaW5zdGFuY2VvZiBMb2NhdGlvbiA/IG5ldyBVUkwodXJsLmhyZWYpIDogdXJsO1xuICAgIHJldHVybiAhIXRoaXMucHJvdG9jb2xNYXRjaGVzLmZpbmQoKHByb3RvY29sKSA9PiB7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiaHR0cFwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0h0dHBNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJodHRwc1wiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0h0dHBzTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiZmlsZVwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0ZpbGVNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJmdHBcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNGdHBNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJ1cm5cIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNVcm5NYXRjaCh1KTtcbiAgICB9KTtcbiAgfVxuICBpc0h0dHBNYXRjaCh1cmwpIHtcbiAgICByZXR1cm4gdXJsLnByb3RvY29sID09PSBcImh0dHA6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcbiAgfVxuICBpc0h0dHBzTWF0Y2godXJsKSB7XG4gICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwczpcIiAmJiB0aGlzLmlzSG9zdFBhdGhNYXRjaCh1cmwpO1xuICB9XG4gIGlzSG9zdFBhdGhNYXRjaCh1cmwpIHtcbiAgICBpZiAoIXRoaXMuaG9zdG5hbWVNYXRjaCB8fCAhdGhpcy5wYXRobmFtZU1hdGNoKVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGhvc3RuYW1lTWF0Y2hSZWdleHMgPSBbXG4gICAgICB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLmhvc3RuYW1lTWF0Y2gpLFxuICAgICAgdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoLnJlcGxhY2UoL15cXCpcXC4vLCBcIlwiKSlcbiAgICBdO1xuICAgIGNvbnN0IHBhdGhuYW1lTWF0Y2hSZWdleCA9IHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMucGF0aG5hbWVNYXRjaCk7XG4gICAgcmV0dXJuICEhaG9zdG5hbWVNYXRjaFJlZ2V4cy5maW5kKChyZWdleCkgPT4gcmVnZXgudGVzdCh1cmwuaG9zdG5hbWUpKSAmJiBwYXRobmFtZU1hdGNoUmVnZXgudGVzdCh1cmwucGF0aG5hbWUpO1xuICB9XG4gIGlzRmlsZU1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiBmaWxlOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBpc0Z0cE1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiBmdHA6Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGlzVXJuTWF0Y2godXJsKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IHVybjovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgY29udmVydFBhdHRlcm5Ub1JlZ2V4KHBhdHRlcm4pIHtcbiAgICBjb25zdCBlc2NhcGVkID0gdGhpcy5lc2NhcGVGb3JSZWdleChwYXR0ZXJuKTtcbiAgICBjb25zdCBzdGFyc1JlcGxhY2VkID0gZXNjYXBlZC5yZXBsYWNlKC9cXFxcXFwqL2csIFwiLipcIik7XG4gICAgcmV0dXJuIFJlZ0V4cChgXiR7c3RhcnNSZXBsYWNlZH0kYCk7XG4gIH1cbiAgZXNjYXBlRm9yUmVnZXgoc3RyaW5nKSB7XG4gICAgcmV0dXJuIHN0cmluZy5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG4gIH1cbn07XG52YXIgTWF0Y2hQYXR0ZXJuID0gX01hdGNoUGF0dGVybjtcbk1hdGNoUGF0dGVybi5QUk9UT0NPTFMgPSBbXCJodHRwXCIsIFwiaHR0cHNcIiwgXCJmaWxlXCIsIFwiZnRwXCIsIFwidXJuXCJdO1xudmFyIEludmFsaWRNYXRjaFBhdHRlcm4gPSBjbGFzcyBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuLCByZWFzb24pIHtcbiAgICBzdXBlcihgSW52YWxpZCBtYXRjaCBwYXR0ZXJuIFwiJHttYXRjaFBhdHRlcm59XCI6ICR7cmVhc29ufWApO1xuICB9XG59O1xuZnVuY3Rpb24gdmFsaWRhdGVQcm90b2NvbChtYXRjaFBhdHRlcm4sIHByb3RvY29sKSB7XG4gIGlmICghTWF0Y2hQYXR0ZXJuLlBST1RPQ09MUy5pbmNsdWRlcyhwcm90b2NvbCkgJiYgcHJvdG9jb2wgIT09IFwiKlwiKVxuICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKFxuICAgICAgbWF0Y2hQYXR0ZXJuLFxuICAgICAgYCR7cHJvdG9jb2x9IG5vdCBhIHZhbGlkIHByb3RvY29sICgke01hdGNoUGF0dGVybi5QUk9UT0NPTFMuam9pbihcIiwgXCIpfSlgXG4gICAgKTtcbn1cbmZ1bmN0aW9uIHZhbGlkYXRlSG9zdG5hbWUobWF0Y2hQYXR0ZXJuLCBob3N0bmFtZSkge1xuICBpZiAoaG9zdG5hbWUuaW5jbHVkZXMoXCI6XCIpKVxuICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgYEhvc3RuYW1lIGNhbm5vdCBpbmNsdWRlIGEgcG9ydGApO1xuICBpZiAoaG9zdG5hbWUuaW5jbHVkZXMoXCIqXCIpICYmIGhvc3RuYW1lLmxlbmd0aCA+IDEgJiYgIWhvc3RuYW1lLnN0YXJ0c1dpdGgoXCIqLlwiKSlcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihcbiAgICAgIG1hdGNoUGF0dGVybixcbiAgICAgIGBJZiB1c2luZyBhIHdpbGRjYXJkICgqKSwgaXQgbXVzdCBnbyBhdCB0aGUgc3RhcnQgb2YgdGhlIGhvc3RuYW1lYFxuICAgICk7XG59XG5mdW5jdGlvbiB2YWxpZGF0ZVBhdGhuYW1lKG1hdGNoUGF0dGVybiwgcGF0aG5hbWUpIHtcbiAgcmV0dXJuO1xufVxuZXhwb3J0IHtcbiAgSW52YWxpZE1hdGNoUGF0dGVybixcbiAgTWF0Y2hQYXR0ZXJuXG59O1xuIl0sIm5hbWVzIjpbImJyb3dzZXIiLCJyZXN1bHQiXSwibWFwcGluZ3MiOiI7O0FBQ0EsV0FBUyxpQkFBaUIsS0FBSztBQUM5QixRQUFJLE9BQU8sUUFBUSxPQUFPLFFBQVEsV0FBWSxRQUFPLEVBQUUsTUFBTSxJQUFHO0FBQ2hFLFdBQU87QUFBQSxFQUNSO0FDSE8sUUFBTUEsWUFBVSxXQUFXLFNBQVMsU0FBUyxLQUNoRCxXQUFXLFVBQ1gsV0FBVztBQ1dmLFFBQU0sVUFBVTtBQ05oQixRQUFBLFdBQUE7QUFBQSxJQUFvQyxhQUFBO0FBQUEsSUFDckIsaUJBQUE7QUFBQSxJQUNJLFNBQUE7QUFBQSxJQUNSLFVBQUE7QUFBQSxJQUNDLGNBQUEsQ0FBQTtBQUFBLEVBRVo7QUFFTyxRQUFBLFVBQUE7QUFBQSxJQUFnQixNQUFBLElBQUEsS0FBQTtBQUVuQixZQUFBQyxVQUFBLE1BQUEsUUFBQSxRQUFBLE1BQUEsSUFBQSxHQUFBO0FBQ0EsYUFBQUEsUUFBQSxHQUFBLEtBQUEsU0FBQSxHQUFBO0FBQUEsSUFBbUM7QUFBQSxJQUNyQyxNQUFBLElBQUEsS0FBQSxPQUFBO0FBTUUsWUFBQSxRQUFBLFFBQUEsTUFBQSxJQUFBLEVBQUEsQ0FBQSxHQUFBLEdBQUEsT0FBQTtBQUFBLElBQWdEO0FBQUEsSUFDbEQsTUFBQSxTQUFBO0FBR0UsWUFBQUEsVUFBQSxNQUFBLFFBQUEsUUFBQSxNQUFBLElBQUEsT0FBQSxLQUFBLFFBQUEsQ0FBQTtBQUNBLGFBQUE7QUFBQSxRQUFPLEdBQUE7QUFBQSxRQUNGLEdBQUFBO0FBQUEsTUFDQTtBQUFBLElBQ0w7QUFBQSxJQUNGLE1BQUEsWUFBQSxVQUFBO0FBR0UsWUFBQSxRQUFBLFFBQUEsTUFBQSxJQUFBLFFBQUE7QUFBQSxJQUF3QztBQUFBLElB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Q3hFLGFBQU8sQ0FBQyxDQUFDLG9CQUFvQixLQUFLLENBQUMsVUFBVSxNQUFNLEtBQUssSUFBSSxRQUFRLENBQUMsS0FBSyxtQkFBbUIsS0FBSyxJQUFJLFFBQVE7QUFBQSxJQUNoSDtBQUFBLElBQ0EsWUFBWSxLQUFLO0FBQ2YsWUFBTSxNQUFNLHFFQUFxRTtBQUFBLElBQ25GO0FBQUEsSUFDQSxXQUFXLEtBQUs7QUFDZCxZQUFNLE1BQU0sb0VBQW9FO0FBQUEsSUFDbEY7QUFBQSxJQUNBLFdBQVcsS0FBSztBQUNkLFlBQU0sTUFBTSxvRUFBb0U7QUFBQSxJQUNsRjtBQUFBLElBQ0Esc0JBQXNCLFNBQVM7QUFDN0IsWUFBTSxVQUFVLEtBQUssZUFBZSxPQUFPO0FBQzNDLFlBQU0sZ0JBQWdCLFFBQVEsUUFBUSxTQUFTLElBQUk7QUFDbkQsYUFBTyxPQUFPLElBQUksYUFBYSxHQUFHO0FBQUEsSUFDcEM7QUFBQSxJQUNBLGVBQWUsUUFBUTtBQUNyQixhQUFPLE9BQU8sUUFBUSx1QkFBdUIsTUFBTTtBQUFBLElBQ3JEO0FBQUEsRUFDRjtBQUNBLE1BQUksZUFBZTtBQUNuQixlQUFhLFlBQVksQ0FBQyxRQUFRLFNBQVMsUUFBUSxPQUFPLEtBQUs7QUFDL0QsTUFBSSxzQkFBc0IsY0FBYyxNQUFNO0FBQUEsSUFDNUMsWUFBWSxjQUFjLFFBQVE7QUFDaEMsWUFBTSwwQkFBMEIsWUFBWSxNQUFNLE1BQU0sRUFBRTtBQUFBLElBQzVEO0FBQUEsRUFDRjtBQUNBLFdBQVMsaUJBQWlCLGNBQWMsVUFBVTtBQUNoRCxRQUFJLENBQUMsYUFBYSxVQUFVLFNBQVMsUUFBUSxLQUFLLGFBQWE7QUFDN0QsWUFBTSxJQUFJO0FBQUEsUUFDUjtBQUFBLFFBQ0EsR0FBRyxRQUFRLDBCQUEwQixhQUFhLFVBQVUsS0FBSyxJQUFJLENBQUM7QUFBQSxNQUM1RTtBQUFBLEVBQ0E7QUFDQSxXQUFTLGlCQUFpQixjQUFjLFVBQVU7QUFDaEQsUUFBSSxTQUFTLFNBQVMsR0FBRztBQUN2QixZQUFNLElBQUksb0JBQW9CLGNBQWMsZ0NBQWdDO0FBQzlFLFFBQUksU0FBUyxTQUFTLEdBQUcsS0FBSyxTQUFTLFNBQVMsS0FBSyxDQUFDLFNBQVMsV0FBVyxJQUFJO0FBQzVFLFlBQU0sSUFBSTtBQUFBLFFBQ1I7QUFBQSxRQUNBO0FBQUEsTUFDTjtBQUFBLEVBQ0E7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OyIsInhfZ29vZ2xlX2lnbm9yZUxpc3QiOlswLDEsMiw5XX0=
