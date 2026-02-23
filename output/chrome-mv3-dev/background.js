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
  function extractRepoFromUrl(repositoryUrl) {
    const match = repositoryUrl.match(/repos\/([^\/]+)\/([^\/]+)$/);
    if (match) {
      return { fullName: `${match[1]}/${match[2]}`, name: match[2] };
    }
    return { fullName: "unknown", name: "unknown" };
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
      const errorText = await response.text();
      if (response.status === 401) {
        throw new Error("Invalid GitHub token");
      }
      if (response.status === 403) {
        throw new Error("Rate limit exceeded. Please try again later.");
      }
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    return data.items;
  }
  const githubAdapter = {
    name: "github",
    groupTitle: "🔄 GitHub Reviews",
    async fetchItems() {
      return fetchRequestedPRs();
    },
    getItemUrl(item) {
      return item.html_url;
    },
    getItemId(item) {
      const repo = extractRepoFromUrl(item.repository_url);
      return `${repo.fullName}#${item.number}`;
    },
    getItemTitle(item) {
      const repo = extractRepoFromUrl(item.repository_url);
      return `${repo.name} #${item.number}: ${item.title}`;
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
      let existingGroupId = await this.getGroupId();
      let groupId = existingGroupId;
      if (groupId) {
        try {
          await browser.tabGroups.get(groupId);
        } catch {
          groupId = null;
        }
      }
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
          await browser.tabGroups.update(groupId, { title: this.groupTitle });
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
      if (true) {
        ws2.addEventListener("open", () => ws2.sendCustom("wxt:background-initialized"));
        keepServiceWorkerAlive();
      }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy9Ad3h0LWRldi9icm93c2VyL3NyYy9pbmRleC5tanMiLCIuLi8uLi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvYnJvd3Nlci5tanMiLCIuLi8uLi9zcmMvY29yZS9TdG9yYWdlLnRzIiwiLi4vLi4vc3JjL2FkYXB0ZXJzL2dpdGh1Yi50cyIsIi4uLy4uL3NyYy9hZGFwdGVycy9pbmRleC50cyIsIi4uLy4uL3NyYy9jb3JlL1RhYk1hbmFnZXIudHMiLCIuLi8uLi9zcmMvY29yZS9TY2hlZHVsZXIudHMiLCIuLi8uLi9lbnRyeXBvaW50cy9iYWNrZ3JvdW5kLnRzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3ZWJleHQtY29yZS9tYXRjaC1wYXR0ZXJucy9saWIvaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8jcmVnaW9uIHNyYy91dGlscy9kZWZpbmUtYmFja2dyb3VuZC50c1xuZnVuY3Rpb24gZGVmaW5lQmFja2dyb3VuZChhcmcpIHtcblx0aWYgKGFyZyA9PSBudWxsIHx8IHR5cGVvZiBhcmcgPT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHsgbWFpbjogYXJnIH07XG5cdHJldHVybiBhcmc7XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgZGVmaW5lQmFja2dyb3VuZCB9OyIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgYnJvd3NlciQxIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcblxuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb24gQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pXG4qIGBgYFxuKiBAbW9kdWxlIHd4dC9icm93c2VyXG4qL1xuY29uc3QgYnJvd3NlciA9IGJyb3dzZXIkMTtcblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBicm93c2VyIH07IiwiZXhwb3J0IGludGVyZmFjZSBFeHRlbnNpb25TZXR0aW5ncyB7XG4gIGdpdGh1YlRva2VuOiBzdHJpbmc7XG4gIHBvbGxpbmdJbnRlcnZhbDogbnVtYmVyO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBsYXN0U3luYzogbnVtYmVyO1xuICBncm91cE1hcHBpbmc6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG59XG5cbmNvbnN0IGRlZmF1bHRzOiBFeHRlbnNpb25TZXR0aW5ncyA9IHtcbiAgZ2l0aHViVG9rZW46ICcnLFxuICBwb2xsaW5nSW50ZXJ2YWw6IDUsXG4gIGVuYWJsZWQ6IGZhbHNlLFxuICBsYXN0U3luYzogMCxcbiAgZ3JvdXBNYXBwaW5nOiB7fSxcbn07XG5cbmV4cG9ydCBjb25zdCBzdG9yYWdlID0ge1xuICBhc3luYyBnZXQ8SyBleHRlbmRzIGtleW9mIEV4dGVuc2lvblNldHRpbmdzPihrZXk6IEspOiBQcm9taXNlPEV4dGVuc2lvblNldHRpbmdzW0tdPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChrZXkpO1xuICAgIHJldHVybiAocmVzdWx0W2tleV0gPz8gZGVmYXVsdHNba2V5XSkgYXMgRXh0ZW5zaW9uU2V0dGluZ3NbS107XG4gIH0sXG5cbiAgYXN5bmMgc2V0PEsgZXh0ZW5kcyBrZXlvZiBFeHRlbnNpb25TZXR0aW5ncz4oXG4gICAga2V5OiBLLFxuICAgIHZhbHVlOiBFeHRlbnNpb25TZXR0aW5nc1tLXVxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuc2V0KHsgW2tleV06IHZhbHVlIH0pO1xuICB9LFxuXG4gIGFzeW5jIGdldEFsbCgpOiBQcm9taXNlPEV4dGVuc2lvblNldHRpbmdzPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChPYmplY3Qua2V5cyhkZWZhdWx0cykpO1xuICAgIHJldHVybiB7XG4gICAgICAuLi5kZWZhdWx0cyxcbiAgICAgIC4uLnJlc3VsdCxcbiAgICB9IGFzIEV4dGVuc2lvblNldHRpbmdzO1xuICB9LFxuXG4gIGFzeW5jIHNldE11bHRpcGxlKHNldHRpbmdzOiBQYXJ0aWFsPEV4dGVuc2lvblNldHRpbmdzPik6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5zZXQoc2V0dGluZ3MpO1xuICB9LFxuXG4gIGRlZmF1bHRzLFxufTtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8RXh0ZW5zaW9uU2V0dGluZ3M+IHtcbiAgcmV0dXJuIHN0b3JhZ2UuZ2V0QWxsKCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moc2V0dGluZ3M6IFBhcnRpYWw8RXh0ZW5zaW9uU2V0dGluZ3M+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHN0b3JhZ2Uuc2V0TXVsdGlwbGUoc2V0dGluZ3MpO1xufVxuIiwiaW1wb3J0IHsgQWRhcHRlciwgUHVsbFJlcXVlc3QsIFN5bmNJdGVtIH0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgeyBzdG9yYWdlIH0gZnJvbSAnLi4vY29yZS9TdG9yYWdlJztcblxuZnVuY3Rpb24gZXh0cmFjdFJlcG9Gcm9tVXJsKHJlcG9zaXRvcnlVcmw6IHN0cmluZyk6IHsgZnVsbE5hbWU6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0ge1xuICBjb25zdCBtYXRjaCA9IHJlcG9zaXRvcnlVcmwubWF0Y2goL3JlcG9zXFwvKFteXFwvXSspXFwvKFteXFwvXSspJC8pO1xuICBpZiAobWF0Y2gpIHtcbiAgICByZXR1cm4geyBmdWxsTmFtZTogYCR7bWF0Y2hbMV19LyR7bWF0Y2hbMl19YCwgbmFtZTogbWF0Y2hbMl0gfTtcbiAgfVxuICByZXR1cm4geyBmdWxsTmFtZTogJ3Vua25vd24nLCBuYW1lOiAndW5rbm93bicgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0VG9rZW4oKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2dpdGh1YlRva2VuJyk7XG4gIHJldHVybiB0b2tlbiB8fCBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hSZXF1ZXN0ZWRQUnMoKTogUHJvbWlzZTxQdWxsUmVxdWVzdFtdPiB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgZ2V0VG9rZW4oKTtcbiAgaWYgKCF0b2tlbikge1xuICAgIHRocm93IG5ldyBFcnJvcignR2l0SHViIHRva2VuIG5vdCBjb25maWd1cmVkJyk7XG4gIH1cblxuICBjb25zdCBxdWVyeSA9ICdzdGF0ZTpvcGVuIGlzOnByIHVzZXItcmV2aWV3LXJlcXVlc3RlZDpAbWUnO1xuICBjb25zdCB1cmwgPSBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9zZWFyY2gvaXNzdWVzP3E9JHtlbmNvZGVVUklDb21wb25lbnQocXVlcnkpfSZzb3J0PXVwZGF0ZWQmcGVyX3BhZ2U9NTBgO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi92bmQuZ2l0aHViLnYzK2pzb24nLFxuICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dG9rZW59YCxcbiAgICAgICdYLUdpdEh1Yi1BcGktVmVyc2lvbic6ICcyMDIyLTExLTI4JyxcbiAgICB9LFxuICB9KTtcblxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIEdpdEh1YiB0b2tlbicpO1xuICAgIH1cbiAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignUmF0ZSBsaW1pdCBleGNlZWRlZC4gUGxlYXNlIHRyeSBhZ2FpbiBsYXRlci4nKTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKGBHaXRIdWIgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gLSAke2Vycm9yVGV4dH1gKTtcbiAgfVxuXG4gIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIHJldHVybiBkYXRhLml0ZW1zO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFwUFJUb1N5bmNJdGVtKHByOiBQdWxsUmVxdWVzdCk6IFN5bmNJdGVtIHtcbiAgY29uc3QgcmVwbyA9IGV4dHJhY3RSZXBvRnJvbVVybChwci5yZXBvc2l0b3J5X3VybCk7XG4gIHJldHVybiB7XG4gICAgaWQ6IGAke3JlcG8uZnVsbE5hbWV9IyR7cHIubnVtYmVyfWAsXG4gICAgdXJsOiBwci5odG1sX3VybCxcbiAgICB0aXRsZTogYCR7cmVwby5uYW1lfSAjJHtwci5udW1iZXJ9OiAke3ByLnRpdGxlfWAsXG4gIH07XG59XG5cbmV4cG9ydCBjb25zdCBnaXRodWJBZGFwdGVyOiBBZGFwdGVyPFB1bGxSZXF1ZXN0PiA9IHtcbiAgbmFtZTogJ2dpdGh1YicsXG4gIGdyb3VwVGl0bGU6ICfwn5SEIEdpdEh1YiBSZXZpZXdzJyxcblxuICBhc3luYyBmZXRjaEl0ZW1zKCkge1xuICAgIHJldHVybiBmZXRjaFJlcXVlc3RlZFBScygpO1xuICB9LFxuXG4gIGdldEl0ZW1VcmwoaXRlbTogUHVsbFJlcXVlc3QpOiBzdHJpbmcge1xuICAgIHJldHVybiBpdGVtLmh0bWxfdXJsO1xuICB9LFxuXG4gIGdldEl0ZW1JZChpdGVtOiBQdWxsUmVxdWVzdCk6IHN0cmluZyB7XG4gICAgY29uc3QgcmVwbyA9IGV4dHJhY3RSZXBvRnJvbVVybChpdGVtLnJlcG9zaXRvcnlfdXJsKTtcbiAgICByZXR1cm4gYCR7cmVwby5mdWxsTmFtZX0jJHtpdGVtLm51bWJlcn1gO1xuICB9LFxuXG4gIGdldEl0ZW1UaXRsZShpdGVtOiBQdWxsUmVxdWVzdCk6IHN0cmluZyB7XG4gICAgY29uc3QgcmVwbyA9IGV4dHJhY3RSZXBvRnJvbVVybChpdGVtLnJlcG9zaXRvcnlfdXJsKTtcbiAgICByZXR1cm4gYCR7cmVwby5uYW1lfSAjJHtpdGVtLm51bWJlcn06ICR7aXRlbS50aXRsZX1gO1xuICB9LFxuXG4gIGlzSXRlbUFjdGl2ZShpdGVtOiBQdWxsUmVxdWVzdCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBpdGVtLnN0YXRlID09PSAnb3Blbic7XG4gIH0sXG59O1xuIiwiaW1wb3J0IHR5cGUgeyBBZGFwdGVyLCBBZGFwdGVyUmVnaXN0cnkgfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB7IGdpdGh1YkFkYXB0ZXIgfSBmcm9tICcuL2dpdGh1Yic7XG5cbmV4cG9ydCB0eXBlIHsgQWRhcHRlciwgU3luY0l0ZW0sIFB1bGxSZXF1ZXN0LCBBZGFwdGVyUmVnaXN0cnkgfSBmcm9tICcuL3R5cGVzJztcbmV4cG9ydCB7IGdpdGh1YkFkYXB0ZXIgfSBmcm9tICcuL2dpdGh1Yic7XG5cbmV4cG9ydCBjb25zdCBhZGFwdGVyUmVnaXN0cnk6IEFkYXB0ZXJSZWdpc3RyeSA9IHtcbiAgZ2l0aHViOiBnaXRodWJBZGFwdGVyLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFkYXB0ZXIobmFtZTogc3RyaW5nKTogQWRhcHRlcjxhbnk+IHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGFkYXB0ZXJSZWdpc3RyeVtuYW1lXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFsbEFkYXB0ZXJzKCk6IEFkYXB0ZXI8YW55PltdIHtcbiAgcmV0dXJuIE9iamVjdC52YWx1ZXMoYWRhcHRlclJlZ2lzdHJ5KTtcbn1cbiIsImltcG9ydCB7IFN5bmNJdGVtIH0gZnJvbSAnLi4vYWRhcHRlcnMvdHlwZXMnO1xuaW1wb3J0IHsgc3RvcmFnZSB9IGZyb20gJy4vU3RvcmFnZSc7XG5cbmNvbnN0IEdST1VQX0NPTE9SUyA9IFsnZ3JleScsICdibHVlJywgJ3JlZCcsICd5ZWxsb3cnLCAnZ3JlZW4nLCAncGluaycsICdwdXJwbGUnLCAnY3lhbiddIGFzIGNvbnN0O1xuXG5leHBvcnQgaW50ZXJmYWNlIFRhYk1hbmFnZXJPcHRpb25zIHtcbiAgZ3JvdXBUaXRsZTogc3RyaW5nO1xuICBhZGFwdGVyTmFtZTogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgVGFiTWFuYWdlciB7XG4gIHByaXZhdGUgZ3JvdXBUaXRsZTogc3RyaW5nO1xuICBwcml2YXRlIGFkYXB0ZXJOYW1lOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9uczogVGFiTWFuYWdlck9wdGlvbnMpIHtcbiAgICB0aGlzLmdyb3VwVGl0bGUgPSBvcHRpb25zLmdyb3VwVGl0bGU7XG4gICAgdGhpcy5hZGFwdGVyTmFtZSA9IG9wdGlvbnMuYWRhcHRlck5hbWU7XG4gIH1cblxuICBhc3luYyBnZXRHcm91cElkKCk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICAgIGNvbnN0IG1hcHBpbmcgPSBhd2FpdCBzdG9yYWdlLmdldCgnZ3JvdXBNYXBwaW5nJyk7XG4gICAgcmV0dXJuIG1hcHBpbmdbdGhpcy5hZGFwdGVyTmFtZV0gfHwgbnVsbDtcbiAgfVxuXG4gIGFzeW5jIHNldEdyb3VwSWQoZ3JvdXBJZDogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgbWFwcGluZyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdncm91cE1hcHBpbmcnKTtcbiAgICBtYXBwaW5nW3RoaXMuYWRhcHRlck5hbWVdID0gZ3JvdXBJZDtcbiAgICBhd2FpdCBzdG9yYWdlLnNldCgnZ3JvdXBNYXBwaW5nJywgbWFwcGluZyk7XG4gIH1cblxuICBhc3luYyBzeW5jR3JvdXAoaXRlbXM6IFN5bmNJdGVtW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBjdXJyZW50V2luZG93ID0gYXdhaXQgYnJvd3Nlci53aW5kb3dzLmdldEN1cnJlbnQoKTtcbiAgICBpZiAoIWN1cnJlbnRXaW5kb3cuaWQpIHJldHVybjtcblxuICAgIGNvbnN0IGl0ZW1JZHMgPSBuZXcgU2V0KGl0ZW1zLm1hcChpdGVtID0+IGl0ZW0uaWQpKTtcbiAgICBsZXQgZXhpc3RpbmdHcm91cElkID0gYXdhaXQgdGhpcy5nZXRHcm91cElkKCk7XG4gICAgbGV0IGdyb3VwSWQgPSBleGlzdGluZ0dyb3VwSWQ7XG5cbiAgICBpZiAoZ3JvdXBJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYnJvd3Nlci50YWJHcm91cHMuZ2V0KGdyb3VwSWQpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGdyb3VwSWQgPSBudWxsO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGFsbFRhYnMgPSBhd2FpdCBicm93c2VyLnRhYnMucXVlcnkoeyB3aW5kb3dJZDogY3VycmVudFdpbmRvdy5pZCB9KTtcbiAgICBjb25zdCBtYW5hZ2VkVGFiczogYnJvd3Nlci50YWJzLlRhYltdID0gW107XG5cbiAgICBpZiAoZ3JvdXBJZCkge1xuICAgICAgZm9yIChjb25zdCB0YWIgb2YgYWxsVGFicykge1xuICAgICAgICBpZiAodGFiLmdyb3VwSWQgPT09IGdyb3VwSWQpIHtcbiAgICAgICAgICBtYW5hZ2VkVGFicy5wdXNoKHRhYik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCB0YWJzVG9SZW1vdmU6IG51bWJlcltdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IHRhYiBvZiBtYW5hZ2VkVGFicykge1xuICAgICAgaWYgKHRhYi51cmwpIHtcbiAgICAgICAgY29uc3QgaXRlbUlkID0gdGhpcy5leHRyYWN0SXRlbUlkKHRhYi51cmwpO1xuICAgICAgICBpZiAoaXRlbUlkICYmICFpdGVtSWRzLmhhcyhpdGVtSWQpKSB7XG4gICAgICAgICAgdGFic1RvUmVtb3ZlLnB1c2godGFiLmlkISk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCB0YWJzVG9BZGQ6IG51bWJlcltdID0gW107XG4gICAgY29uc3QgZXhpc3RpbmdVcmxzID0gbmV3IFNldChtYW5hZ2VkVGFicy5tYXAodCA9PiB0LnVybCkuZmlsdGVyKCh1KTogdSBpcyBzdHJpbmcgPT4gISF1KSk7XG5cbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgIGlmICghZXhpc3RpbmdVcmxzLmhhcyhpdGVtLnVybCkpIHtcbiAgICAgICAgY29uc3QgZXhpc3RpbmdUYWIgPSBhbGxUYWJzLmZpbmQodCA9PiB0LnVybCA9PT0gaXRlbS51cmwpO1xuICAgICAgICBpZiAoZXhpc3RpbmdUYWIpIHtcbiAgICAgICAgICB0YWJzVG9BZGQucHVzaChleGlzdGluZ1RhYi5pZCEpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IG5ld1RhYiA9IGF3YWl0IGJyb3dzZXIudGFicy5jcmVhdGUoeyB1cmw6IGl0ZW0udXJsLCBhY3RpdmU6IGZhbHNlIH0pO1xuICAgICAgICAgIHRhYnNUb0FkZC5wdXNoKG5ld1RhYi5pZCEpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRhYnNUb1JlbW92ZS5sZW5ndGggPiAwKSB7XG4gICAgICBhd2FpdCBicm93c2VyLnRhYnMudW5ncm91cCh0YWJzVG9SZW1vdmUpO1xuICAgICAgYXdhaXQgYnJvd3Nlci50YWJzLnJlbW92ZSh0YWJzVG9SZW1vdmUpO1xuICAgIH1cblxuICAgIGlmICh0YWJzVG9BZGQubGVuZ3RoID09PSAwICYmIG1hbmFnZWRUYWJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICh0YWJzVG9BZGQubGVuZ3RoID4gMCkge1xuICAgICAgaWYgKGdyb3VwSWQpIHtcbiAgICAgICAgY29uc3QgZ3JvdXBUYWJzID0gYXdhaXQgYnJvd3Nlci50YWJzLnF1ZXJ5KHsgZ3JvdXBJZDogZ3JvdXBJZCB9KTtcbiAgICAgICAgY29uc3QgY3VycmVudFRhYklkcyA9IGdyb3VwVGFicy5tYXAodCA9PiB0LmlkKS5maWx0ZXIoKGlkKTogaWQgaXMgbnVtYmVyID0+IGlkICE9PSB1bmRlZmluZWQpO1xuICAgICAgICBpZiAoY3VycmVudFRhYklkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY29uc3QgYWxsVGFiSWRzID0gWy4uLmN1cnJlbnRUYWJJZHMsIC4uLnRhYnNUb0FkZF07XG4gICAgICAgICAgYXdhaXQgYnJvd3Nlci50YWJzLmdyb3VwKHsgdGFiSWRzOiBhbGxUYWJJZHMgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYXdhaXQgYnJvd3Nlci50YWJzLmdyb3VwKHsgdGFiSWRzOiB0YWJzVG9BZGQgYXMgW251bWJlciwgLi4ubnVtYmVyW11dIH0pO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGJyb3dzZXIudGFiR3JvdXBzLnVwZGF0ZShncm91cElkLCB7IHRpdGxlOiB0aGlzLmdyb3VwVGl0bGUgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBuZXdHcm91cElkID0gYXdhaXQgYnJvd3Nlci50YWJzLmdyb3VwKHsgdGFiSWRzOiB0YWJzVG9BZGQgYXMgW251bWJlciwgLi4ubnVtYmVyW11dIH0pO1xuICAgICAgICBjb25zdCBtYXBwaW5nID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2dyb3VwTWFwcGluZycpO1xuICAgICAgICBjb25zdCBjb2xvckluZGV4ID0gT2JqZWN0LmtleXMobWFwcGluZykubGVuZ3RoICUgR1JPVVBfQ09MT1JTLmxlbmd0aDtcbiAgICAgICAgYXdhaXQgYnJvd3Nlci50YWJHcm91cHMudXBkYXRlKG5ld0dyb3VwSWQsIHtcbiAgICAgICAgICB0aXRsZTogdGhpcy5ncm91cFRpdGxlLFxuICAgICAgICAgIGNvbG9yOiBHUk9VUF9DT0xPUlNbY29sb3JJbmRleF0sXG4gICAgICAgIH0pO1xuICAgICAgICBhd2FpdCB0aGlzLnNldEdyb3VwSWQobmV3R3JvdXBJZCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgYXdhaXQgc3RvcmFnZS5zZXQoJ2xhc3RTeW5jJywgRGF0ZS5ub3coKSk7XG4gIH1cblxuICBwcml2YXRlIGV4dHJhY3RJdGVtSWQodXJsOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBtYXRjaCA9IHVybC5tYXRjaCgvZ2l0aHViXFwuY29tXFwvKFteXFwvXStcXC9bXlxcL10rKVxcL3B1bGxcXC8oXFxkKykvKTtcbiAgICBpZiAobWF0Y2gpIHtcbiAgICAgIHJldHVybiBgJHttYXRjaFsxXX0jJHttYXRjaFsyXX1gO1xuICAgIH1cbiAgICBjb25zdCBwck1hdGNoID0gdXJsLm1hdGNoKC9cXC9wdWxsXFwvKFxcZCspLyk7XG4gICAgaWYgKHByTWF0Y2gpIHtcbiAgICAgIHJldHVybiBwck1hdGNoWzFdO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGFzeW5jIHJlbW92ZUdyb3VwKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGdyb3VwSWQgPSBhd2FpdCB0aGlzLmdldEdyb3VwSWQoKTtcbiAgICBpZiAoIWdyb3VwSWQpIHJldHVybjtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YWJzID0gYXdhaXQgYnJvd3Nlci50YWJzLnF1ZXJ5KHsgZ3JvdXBJZDogZ3JvdXBJZCB9KTtcbiAgICAgIGNvbnN0IHRhYklkcyA9IHRhYnMubWFwKHQgPT4gdC5pZCkuZmlsdGVyKChpZCk6IGlkIGlzIG51bWJlciA9PiBpZCAhPT0gdW5kZWZpbmVkKTtcbiAgICAgIFxuICAgICAgaWYgKHRhYklkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF3YWl0IGJyb3dzZXIudGFicy51bmdyb3VwKHRhYklkcyk7XG4gICAgICAgIGF3YWl0IGJyb3dzZXIudGFicy5yZW1vdmUodGFiSWRzKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWFwcGluZyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdncm91cE1hcHBpbmcnKTtcbiAgICAgIGRlbGV0ZSBtYXBwaW5nW3RoaXMuYWRhcHRlck5hbWVdO1xuICAgICAgYXdhaXQgc3RvcmFnZS5zZXQoJ2dyb3VwTWFwcGluZycsIG1hcHBpbmcpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29uc3QgbWFwcGluZyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdncm91cE1hcHBpbmcnKTtcbiAgICAgIGRlbGV0ZSBtYXBwaW5nW3RoaXMuYWRhcHRlck5hbWVdO1xuICAgICAgYXdhaXQgc3RvcmFnZS5zZXQoJ2dyb3VwTWFwcGluZycsIG1hcHBpbmcpO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmluZFRhYkJ5VXJsKHVybDogc3RyaW5nKTogUHJvbWlzZTxicm93c2VyLnRhYnMuVGFiIHwgbnVsbD4ge1xuICBjb25zdCB0YWJzID0gYXdhaXQgYnJvd3Nlci50YWJzLnF1ZXJ5KHsgdXJsIH0pO1xuICByZXR1cm4gdGFic1swXSB8fCBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY3JlYXRlVGFiKHVybDogc3RyaW5nKTogUHJvbWlzZTxicm93c2VyLnRhYnMuVGFiPiB7XG4gIHJldHVybiBicm93c2VyLnRhYnMuY3JlYXRlKHsgdXJsLCBhY3RpdmU6IGZhbHNlIH0pO1xufVxuIiwiaW1wb3J0IHsgc3RvcmFnZSB9IGZyb20gJy4vU3RvcmFnZSc7XG5cbmV4cG9ydCBjb25zdCBBTEFSTV9OQU1FID0gJ2F1dG8tZ3JvdXBzLXBvbGxpbmcnO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRQb2xsaW5nKGludGVydmFsTWludXRlczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGJyb3dzZXIuYWxhcm1zLmNyZWF0ZShBTEFSTV9OQU1FLCB7XG4gICAgcGVyaW9kSW5NaW51dGVzOiBpbnRlcnZhbE1pbnV0ZXMsXG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RvcFBvbGxpbmcoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFsYXJtID0gYXdhaXQgYnJvd3Nlci5hbGFybXMuZ2V0KEFMQVJNX05BTUUpO1xuICBpZiAoYWxhcm0pIHtcbiAgICBhd2FpdCBicm93c2VyLmFsYXJtcy5jbGVhcihBTEFSTV9OQU1FKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0UG9sbGluZ0ludGVydmFsKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBzdG9yYWdlLmdldCgncG9sbGluZ0ludGVydmFsJyk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXRQb2xsaW5nSW50ZXJ2YWwoaW50ZXJ2YWxNaW51dGVzOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgc3RvcmFnZS5zZXQoJ3BvbGxpbmdJbnRlcnZhbCcsIGludGVydmFsTWludXRlcyk7XG4gIFxuICBjb25zdCBhbGFybSA9IGF3YWl0IGJyb3dzZXIuYWxhcm1zLmdldChBTEFSTV9OQU1FKTtcbiAgaWYgKGFsYXJtKSB7XG4gICAgYXdhaXQgYnJvd3Nlci5hbGFybXMuY2xlYXIoQUxBUk1fTkFNRSk7XG4gICAgYXdhaXQgYnJvd3Nlci5hbGFybXMuY3JlYXRlKEFMQVJNX05BTUUsIHtcbiAgICAgIHBlcmlvZEluTWludXRlczogaW50ZXJ2YWxNaW51dGVzLFxuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvbkFsYXJtKGNhbGxiYWNrOiAoYWxhcm06IGJyb3dzZXIuYWxhcm1zLkFsYXJtKSA9PiB2b2lkKTogdm9pZCB7XG4gIGJyb3dzZXIuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoY2FsbGJhY2spO1xufVxuIiwiaW1wb3J0IHsgZ2V0QWRhcHRlciwgZ2V0QWxsQWRhcHRlcnMsIGdpdGh1YkFkYXB0ZXIgfSBmcm9tICcuLi9zcmMvYWRhcHRlcnMnO1xuaW1wb3J0IHsgVGFiTWFuYWdlciB9IGZyb20gJy4uL3NyYy9jb3JlL1RhYk1hbmFnZXInO1xuaW1wb3J0IHsgc3RvcmFnZSwgZ2V0U2V0dGluZ3MgfSBmcm9tICcuLi9zcmMvY29yZS9TdG9yYWdlJztcbmltcG9ydCB7IHN0YXJ0UG9sbGluZywgc3RvcFBvbGxpbmcsIEFMQVJNX05BTUUsIG9uQWxhcm0gfSBmcm9tICcuLi9zcmMvY29yZS9TY2hlZHVsZXInO1xuXG5hc3luYyBmdW5jdGlvbiBydW5BZGFwdGVyU3luYyhhZGFwdGVyTmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFkYXB0ZXIgPSBnZXRBZGFwdGVyKGFkYXB0ZXJOYW1lKTtcbiAgaWYgKCFhZGFwdGVyKSB7XG4gICAgY29uc29sZS5lcnJvcihgQWRhcHRlciBub3QgZm91bmQ6ICR7YWRhcHRlck5hbWV9YCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBzdG9yYWdlLmdldCgnZ2l0aHViVG9rZW4nKTtcbiAgY29uc29sZS5sb2coYFtBdXRvIEdyb3Vwc10gVG9rZW4gcHJlc2VudDogJHshIXRva2VufWApO1xuICBcbiAgaWYgKCF0b2tlbiAmJiBhZGFwdGVyTmFtZSA9PT0gJ2dpdGh1YicpIHtcbiAgICBjb25zb2xlLmxvZygnR2l0SHViIHRva2VuIG5vdCBjb25maWd1cmVkLCBza2lwcGluZyBzeW5jJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdGFiTWFuYWdlciA9IG5ldyBUYWJNYW5hZ2VyKHtcbiAgICBncm91cFRpdGxlOiBhZGFwdGVyLmdyb3VwVGl0bGUsXG4gICAgYWRhcHRlck5hbWU6IGFkYXB0ZXIubmFtZSxcbiAgfSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhgW0F1dG8gR3JvdXBzXSBGZXRjaGluZyBpdGVtcyBmb3IgJHthZGFwdGVyTmFtZX0uLi5gKTtcbiAgICBjb25zdCBpdGVtcyA9IGF3YWl0IGFkYXB0ZXIuZmV0Y2hJdGVtcygpO1xuICAgIGNvbnNvbGUubG9nKGBbQXV0byBHcm91cHNdIEdvdCAke2l0ZW1zLmxlbmd0aH0gaXRlbXNgKTtcbiAgICBcbiAgICBjb25zdCBzeW5jSXRlbXMgPSBpdGVtcy5tYXAoaXRlbSA9PiAoe1xuICAgICAgaWQ6IGFkYXB0ZXIuZ2V0SXRlbUlkKGl0ZW0pLFxuICAgICAgdXJsOiBhZGFwdGVyLmdldEl0ZW1VcmwoaXRlbSksXG4gICAgICB0aXRsZTogYWRhcHRlci5nZXRJdGVtVGl0bGUoaXRlbSksXG4gICAgfSkpO1xuICAgIFxuICAgIGF3YWl0IHRhYk1hbmFnZXIuc3luY0dyb3VwKHN5bmNJdGVtcyk7XG4gICAgY29uc29sZS5sb2coYFtBdXRvIEdyb3Vwc10gU3luY2VkICR7c3luY0l0ZW1zLmxlbmd0aH0gaXRlbXMgZm9yICR7YWRhcHRlck5hbWV9YCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihgW0F1dG8gR3JvdXBzXSBFcnJvciBzeW5jaW5nICR7YWRhcHRlck5hbWV9OmAsIGVycm9yKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzeW5jQWxsQWRhcHRlcnMoZm9yY2U6IGJvb2xlYW4gPSBmYWxzZSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IGdldFNldHRpbmdzKCk7XG4gIGNvbnNvbGUubG9nKGBbQXV0byBHcm91cHNdIFN5bmMgY2FsbGVkLCBlbmFibGVkOiAke3NldHRpbmdzLmVuYWJsZWR9LCBmb3JjZTogJHtmb3JjZX1gKTtcbiAgXG4gIGlmICghc2V0dGluZ3MuZW5hYmxlZCAmJiAhZm9yY2UpIHtcbiAgICBjb25zb2xlLmxvZygnW0F1dG8gR3JvdXBzXSBFeHRlbnNpb24gZGlzYWJsZWQsIHNraXBwaW5nIHN5bmMnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBhZGFwdGVycyA9IGdldEFsbEFkYXB0ZXJzKCk7XG4gIGZvciAoY29uc3QgYWRhcHRlciBvZiBhZGFwdGVycykge1xuICAgIGF3YWl0IHJ1bkFkYXB0ZXJTeW5jKGFkYXB0ZXIubmFtZSk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQmFja2dyb3VuZCgoKSA9PiB7XG4gIGNvbnNvbGUubG9nKCdBdXRvIEdyb3VwcyBleHRlbnNpb24gc3RhcnRlZCcpO1xuXG4gIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcihhc3luYyAoKSA9PiB7XG4gICAgY29uc29sZS5sb2coJ0V4dGVuc2lvbiBpbnN0YWxsZWQnKTtcbiAgfSk7XG5cbiAgb25BbGFybShhc3luYyAoYWxhcm0pID0+IHtcbiAgICBpZiAoYWxhcm0ubmFtZSA9PT0gQUxBUk1fTkFNRSkge1xuICAgICAgY29uc29sZS5sb2coJ1BvbGxpbmcgYWxhcm0gdHJpZ2dlcmVkJyk7XG4gICAgICBhd2FpdCBzeW5jQWxsQWRhcHRlcnMoKTtcbiAgICB9XG4gIH0pO1xuXG4gIGJyb3dzZXIuc3RvcmFnZS5vbkNoYW5nZWQuYWRkTGlzdGVuZXIoYXN5bmMgKGNoYW5nZXMsIGFyZWEpID0+IHtcbiAgICBpZiAoYXJlYSA9PT0gJ2xvY2FsJykge1xuICAgICAgaWYgKGNoYW5nZXMuZW5hYmxlZCkge1xuICAgICAgICBjb25zdCBlbmFibGVkID0gY2hhbmdlcy5lbmFibGVkLm5ld1ZhbHVlO1xuICAgICAgICBpZiAoZW5hYmxlZCkge1xuICAgICAgICAgIGNvbnN0IGludGVydmFsID0gYXdhaXQgc3RvcmFnZS5nZXQoJ3BvbGxpbmdJbnRlcnZhbCcpO1xuICAgICAgICAgIGF3YWl0IHN0YXJ0UG9sbGluZyhpbnRlcnZhbCk7XG4gICAgICAgICAgYXdhaXQgc3luY0FsbEFkYXB0ZXJzKCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYXdhaXQgc3RvcFBvbGxpbmcoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgYnJvd3Nlci5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobWVzc2FnZSwgX3NlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ1NZTkNfTk9XJykge1xuICAgICAgY29uc29sZS5sb2coJ1tBdXRvIEdyb3Vwc10gTWFudWFsIHN5bmMgdHJpZ2dlcmVkJyk7XG4gICAgICBzeW5jQWxsQWRhcHRlcnModHJ1ZSkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pKVxuICAgICAgICAuY2F0Y2goZXJyID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSkpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIFxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdHRVRfU1RBVFVTJykge1xuICAgICAgZ2V0U2V0dGluZ3MoKS50aGVuKHNldHRpbmdzID0+IHtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgXG4gICAgICAgICAgZW5hYmxlZDogc2V0dGluZ3MuZW5hYmxlZCwgXG4gICAgICAgICAgbGFzdFN5bmM6IHNldHRpbmdzLmxhc3RTeW5jLFxuICAgICAgICAgIGdpdGh1YlRva2VuOiAhIXNldHRpbmdzLmdpdGh1YlRva2VuLFxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ1RPR0dMRV9FTkFCTEVEJykge1xuICAgICAgc3RvcmFnZS5zZXQoJ2VuYWJsZWQnLCBtZXNzYWdlLmVuYWJsZWQpLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBpZiAobWVzc2FnZS5lbmFibGVkKSB7XG4gICAgICAgICAgY29uc3QgaW50ZXJ2YWwgPSBhd2FpdCBzdG9yYWdlLmdldCgncG9sbGluZ0ludGVydmFsJyk7XG4gICAgICAgICAgYXdhaXQgc3RhcnRQb2xsaW5nKGludGVydmFsKTtcbiAgICAgICAgICBhd2FpdCBzeW5jQWxsQWRhcHRlcnMoKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhd2FpdCBzdG9wUG9sbGluZygpO1xuICAgICAgICB9XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfSk7XG5cbiAgKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IGdldFNldHRpbmdzKCk7XG4gICAgaWYgKHNldHRpbmdzLmVuYWJsZWQpIHtcbiAgICAgIGF3YWl0IHN0YXJ0UG9sbGluZyhzZXR0aW5ncy5wb2xsaW5nSW50ZXJ2YWwpO1xuICAgIH1cbiAgfSkoKTtcbn0pO1xuIiwiLy8gc3JjL2luZGV4LnRzXG52YXIgX01hdGNoUGF0dGVybiA9IGNsYXNzIHtcbiAgY29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuKSB7XG4gICAgaWYgKG1hdGNoUGF0dGVybiA9PT0gXCI8YWxsX3VybHM+XCIpIHtcbiAgICAgIHRoaXMuaXNBbGxVcmxzID0gdHJ1ZTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gWy4uLl9NYXRjaFBhdHRlcm4uUFJPVE9DT0xTXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IFwiKlwiO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gXCIqXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGdyb3VwcyA9IC8oLiopOlxcL1xcLyguKj8pKFxcLy4qKS8uZXhlYyhtYXRjaFBhdHRlcm4pO1xuICAgICAgaWYgKGdyb3VwcyA9PSBudWxsKVxuICAgICAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIFwiSW5jb3JyZWN0IGZvcm1hdFwiKTtcbiAgICAgIGNvbnN0IFtfLCBwcm90b2NvbCwgaG9zdG5hbWUsIHBhdGhuYW1lXSA9IGdyb3VwcztcbiAgICAgIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCk7XG4gICAgICB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpO1xuICAgICAgdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gcHJvdG9jb2wgPT09IFwiKlwiID8gW1wiaHR0cFwiLCBcImh0dHBzXCJdIDogW3Byb3RvY29sXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IGhvc3RuYW1lO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gcGF0aG5hbWU7XG4gICAgfVxuICB9XG4gIGluY2x1ZGVzKHVybCkge1xuICAgIGlmICh0aGlzLmlzQWxsVXJscylcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IHUgPSB0eXBlb2YgdXJsID09PSBcInN0cmluZ1wiID8gbmV3IFVSTCh1cmwpIDogdXJsIGluc3RhbmNlb2YgTG9jYXRpb24gPyBuZXcgVVJMKHVybC5ocmVmKSA6IHVybDtcbiAgICByZXR1cm4gISF0aGlzLnByb3RvY29sTWF0Y2hlcy5maW5kKChwcm90b2NvbCkgPT4ge1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImh0dHBcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiaHR0cHNcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwc01hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImZpbGVcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNGaWxlTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiZnRwXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzRnRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwidXJuXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzVXJuTWF0Y2godSk7XG4gICAgfSk7XG4gIH1cbiAgaXNIdHRwTWF0Y2godXJsKSB7XG4gICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG4gIH1cbiAgaXNIdHRwc01hdGNoKHVybCkge1xuICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcbiAgfVxuICBpc0hvc3RQYXRoTWF0Y2godXJsKSB7XG4gICAgaWYgKCF0aGlzLmhvc3RuYW1lTWF0Y2ggfHwgIXRoaXMucGF0aG5hbWVNYXRjaClcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBob3N0bmFtZU1hdGNoUmVnZXhzID0gW1xuICAgICAgdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoKSxcbiAgICAgIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaC5yZXBsYWNlKC9eXFwqXFwuLywgXCJcIikpXG4gICAgXTtcbiAgICBjb25zdCBwYXRobmFtZU1hdGNoUmVnZXggPSB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLnBhdGhuYW1lTWF0Y2gpO1xuICAgIHJldHVybiAhIWhvc3RuYW1lTWF0Y2hSZWdleHMuZmluZCgocmVnZXgpID0+IHJlZ2V4LnRlc3QodXJsLmhvc3RuYW1lKSkgJiYgcGF0aG5hbWVNYXRjaFJlZ2V4LnRlc3QodXJsLnBhdGhuYW1lKTtcbiAgfVxuICBpc0ZpbGVNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZmlsZTovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgaXNGdHBNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZnRwOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBpc1Vybk1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiB1cm46Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGNvbnZlcnRQYXR0ZXJuVG9SZWdleChwYXR0ZXJuKSB7XG4gICAgY29uc3QgZXNjYXBlZCA9IHRoaXMuZXNjYXBlRm9yUmVnZXgocGF0dGVybik7XG4gICAgY29uc3Qgc3RhcnNSZXBsYWNlZCA9IGVzY2FwZWQucmVwbGFjZSgvXFxcXFxcKi9nLCBcIi4qXCIpO1xuICAgIHJldHVybiBSZWdFeHAoYF4ke3N0YXJzUmVwbGFjZWR9JGApO1xuICB9XG4gIGVzY2FwZUZvclJlZ2V4KHN0cmluZykge1xuICAgIHJldHVybiBzdHJpbmcucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICB9XG59O1xudmFyIE1hdGNoUGF0dGVybiA9IF9NYXRjaFBhdHRlcm47XG5NYXRjaFBhdHRlcm4uUFJPVE9DT0xTID0gW1wiaHR0cFwiLCBcImh0dHBzXCIsIFwiZmlsZVwiLCBcImZ0cFwiLCBcInVyblwiXTtcbnZhciBJbnZhbGlkTWF0Y2hQYXR0ZXJuID0gY2xhc3MgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybiwgcmVhc29uKSB7XG4gICAgc3VwZXIoYEludmFsaWQgbWF0Y2ggcGF0dGVybiBcIiR7bWF0Y2hQYXR0ZXJufVwiOiAke3JlYXNvbn1gKTtcbiAgfVxufTtcbmZ1bmN0aW9uIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCkge1xuICBpZiAoIU1hdGNoUGF0dGVybi5QUk9UT0NPTFMuaW5jbHVkZXMocHJvdG9jb2wpICYmIHByb3RvY29sICE9PSBcIipcIilcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihcbiAgICAgIG1hdGNoUGF0dGVybixcbiAgICAgIGAke3Byb3RvY29sfSBub3QgYSB2YWxpZCBwcm90b2NvbCAoJHtNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmpvaW4oXCIsIFwiKX0pYFxuICAgICk7XG59XG5mdW5jdGlvbiB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpIHtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiOlwiKSlcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIGBIb3N0bmFtZSBjYW5ub3QgaW5jbHVkZSBhIHBvcnRgKTtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiKlwiKSAmJiBob3N0bmFtZS5sZW5ndGggPiAxICYmICFob3N0bmFtZS5zdGFydHNXaXRoKFwiKi5cIikpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4oXG4gICAgICBtYXRjaFBhdHRlcm4sXG4gICAgICBgSWYgdXNpbmcgYSB3aWxkY2FyZCAoKiksIGl0IG11c3QgZ28gYXQgdGhlIHN0YXJ0IG9mIHRoZSBob3N0bmFtZWBcbiAgICApO1xufVxuZnVuY3Rpb24gdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKSB7XG4gIHJldHVybjtcbn1cbmV4cG9ydCB7XG4gIEludmFsaWRNYXRjaFBhdHRlcm4sXG4gIE1hdGNoUGF0dGVyblxufTtcbiJdLCJuYW1lcyI6WyJicm93c2VyIiwicmVzdWx0Il0sIm1hcHBpbmdzIjoiOztBQUNBLFdBQVMsaUJBQWlCLEtBQUs7QUFDOUIsUUFBSSxPQUFPLFFBQVEsT0FBTyxRQUFRLFdBQVksUUFBTyxFQUFFLE1BQU0sSUFBRztBQUNoRSxXQUFPO0FBQUEsRUFDUjtBQ0hPLFFBQU1BLFlBQVUsV0FBVyxTQUFTLFNBQVMsS0FDaEQsV0FBVyxVQUNYLFdB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R0FBRyxRQUFRLDBCQUEwQixhQUFhLFVBQVUsS0FBSyxJQUFJLENBQUM7QUFBQSxNQUM1RTtBQUFBLEVBQ0E7QUFDQSxXQUFTLGlCQUFpQixjQUFjLFVBQVU7QUFDaEQsUUFBSSxTQUFTLFNBQVMsR0FBRztBQUN2QixZQUFNLElBQUksb0JBQW9CLGNBQWMsZ0NBQWdDO0FBQzlFLFFBQUksU0FBUyxTQUFTLEdBQUcsS0FBSyxTQUFTLFNBQVMsS0FBSyxDQUFDLFNBQVMsV0FBVyxJQUFJO0FBQzVFLFlBQU0sSUFBSTtBQUFBLFFBQ1I7QUFBQSxRQUNBO0FBQUEsTUFDTjtBQUFBLEVBQ0E7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OyIsInhfZ29vZ2xlX2lnbm9yZUxpc3QiOlswLDEsMiw5XX0=
