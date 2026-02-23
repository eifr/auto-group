var background = (function() {
  "use strict";
  function defineBackground(arg) {
    if (arg == null || typeof arg === "function") return { main: arg };
    return arg;
  }
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  const defaults = {
    fetchMode: "together",
    masterEnabled: false,
    globalPollingInterval: 5,
    installedAdapters: {},
    groupMapping: {},
    lastSync: {}
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
  async function getAdapterConfig(adapterName) {
    const adapters = await storage.get("installedAdapters");
    return adapters[adapterName] || null;
  }
  async function setAdapterConfig(adapterName, config) {
    const adapters = await storage.get("installedAdapters");
    adapters[adapterName] = config;
    await storage.set("installedAdapters", adapters);
  }
  function extractRepoFromUrl(repositoryUrl) {
    const match = repositoryUrl.match(/repos\/([^\/]+)\/([^\/]+)$/);
    if (match) {
      return { fullName: `${match[1]}/${match[2]}`, name: match[2] };
    }
    return { fullName: "unknown", name: "unknown" };
  }
  async function getToken() {
    const config = await getAdapterConfig("github");
    return config?.config?.token || null;
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
    description: "Track PRs where you are a requested reviewer",
    async install() {
      await setAdapterConfig("github", {
        enabled: true,
        pollingInterval: 5,
        config: {}
      });
    },
    async uninstall() {
    },
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
  const MASTER_ALARM_NAME = "auto-groups-master";
  const ADAPTER_ALARM_PREFIX = "auto-groups-";
  async function startMasterPolling(intervalMinutes) {
    await browser.alarms.create(MASTER_ALARM_NAME, {
      periodInMinutes: intervalMinutes
    });
  }
  async function stopMasterPolling() {
    const alarm = await browser.alarms.get(MASTER_ALARM_NAME);
    if (alarm) {
      await browser.alarms.clear(MASTER_ALARM_NAME);
    }
  }
  async function startAdapterPolling(adapterName, intervalMinutes) {
    await browser.alarms.create(`${ADAPTER_ALARM_PREFIX}${adapterName}`, {
      periodInMinutes: intervalMinutes
    });
  }
  async function stopAdapterPolling(adapterName) {
    const alarm = await browser.alarms.get(`${ADAPTER_ALARM_PREFIX}${adapterName}`);
    if (alarm) {
      await browser.alarms.clear(`${ADAPTER_ALARM_PREFIX}${adapterName}`);
    }
  }
  async function updatePolling() {
    const settings = await storage.getAll();
    await stopMasterPolling();
    const adapters = Object.keys(settings.installedAdapters);
    for (const adapter of adapters) {
      await stopAdapterPolling(adapter);
    }
    if (settings.fetchMode === "together") {
      if (settings.masterEnabled) {
        await startMasterPolling(settings.globalPollingInterval);
      }
    } else {
      for (const adapter of adapters) {
        const config = settings.installedAdapters[adapter];
        if (config.enabled && config.pollingInterval) {
          await startAdapterPolling(adapter, config.pollingInterval);
        }
      }
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
    const config = await getAdapterConfig(adapterName);
    if (!config || !config.enabled) {
      console.log(`Adapter ${adapterName} is disabled, skipping`);
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
  async function syncAllAdapters() {
    const settings = await getSettings();
    if (settings.fetchMode === "together") {
      if (!settings.masterEnabled) {
        console.log("[Auto Groups] Master disabled, skipping sync");
        return;
      }
      const adapters = getAllAdapters();
      for (const adapter of adapters) {
        await runAdapterSync(adapter.name);
      }
    } else {
      const installedAdapters = Object.keys(settings.installedAdapters);
      for (const adapterName of installedAdapters) {
        await runAdapterSync(adapterName);
      }
    }
  }
  async function syncAdapter(adapterName) {
    const settings = await getSettings();
    if (settings.fetchMode === "together") {
      if (settings.masterEnabled) {
        await runAdapterSync(adapterName);
      }
    } else {
      await runAdapterSync(adapterName);
    }
  }
  const definition = defineBackground(() => {
    console.log("Auto Groups extension started");
    browser.runtime.onInstalled.addListener(async () => {
      console.log("Extension installed");
    });
    onAlarm(async (alarm) => {
      console.log(`[Auto Groups] Alarm triggered: ${alarm.name}`);
      if (alarm.name === MASTER_ALARM_NAME) {
        await syncAllAdapters();
      } else if (alarm.name.startsWith(ADAPTER_ALARM_PREFIX)) {
        const adapterName = alarm.name.replace(ADAPTER_ALARM_PREFIX, "");
        await syncAdapter(adapterName);
      }
    });
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area === "local") {
        if (changes.fetchMode || changes.masterEnabled || changes.globalPollingInterval || changes.installedAdapters) {
          await updatePolling();
        }
      }
    });
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "SYNC_NOW") {
        console.log("[Auto Groups] Manual sync triggered");
        syncAllAdapters().then(() => sendResponse({ success: true })).catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }
      if (message.type === "SYNC_ADAPTER") {
        console.log(`[Auto Groups] Manual sync for ${message.adapterName}`);
        syncAdapter(message.adapterName).then(() => sendResponse({ success: true })).catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }
      if (message.type === "GET_STATUS") {
        getSettings().then((settings) => {
          const installed = Object.keys(settings.installedAdapters);
          const adaptersWithMeta = {};
          for (const name of installed) {
            const adapter = getAdapter(name);
            adaptersWithMeta[name] = {
              ...settings.installedAdapters[name],
              groupTitle: adapter?.groupTitle || name
            };
          }
          sendResponse({
            fetchMode: settings.fetchMode,
            masterEnabled: settings.masterEnabled,
            globalPollingInterval: settings.globalPollingInterval,
            installedAdapters: adaptersWithMeta,
            installedList: installed
          });
        });
        return true;
      }
      if (message.type === "UPDATE_SETTINGS") {
        const { fetchMode, masterEnabled, globalPollingInterval } = message;
        storage.setMultiple({
          fetchMode,
          masterEnabled,
          globalPollingInterval
        }).then(async () => {
          await updatePolling();
          sendResponse({ success: true });
        });
        return true;
      }
      if (message.type === "UPDATE_ADAPTER_CONFIG") {
        const { adapterName, enabled, pollingInterval, config } = message;
        console.log("[Auto Groups] UPDATE_ADAPTER_CONFIG:", { adapterName, enabled, pollingInterval, config });
        getAdapterConfig(adapterName).then((currentConfig) => {
          if (currentConfig) {
            storage.get("installedAdapters").then((adapters) => {
              const newConfig = {
                enabled: enabled !== void 0 ? enabled : currentConfig.enabled,
                pollingInterval: pollingInterval !== void 0 ? pollingInterval : currentConfig.pollingInterval,
                config: { ...currentConfig.config, ...config }
              };
              console.log("[Auto Groups] New config:", newConfig);
              storage.set("installedAdapters", {
                ...adapters,
                [adapterName]: newConfig
              }).then(async () => {
                await updatePolling();
                sendResponse({ success: true });
              });
            });
          } else {
            sendResponse({ success: false, error: "Adapter not found" });
          }
        });
        return true;
      }
      if (message.type === "INSTALL_ADAPTER") {
        const adapter = getAdapter(message.adapterName);
        if (adapter) {
          adapter.install().then(async () => {
            await updatePolling();
            sendResponse({ success: true });
          });
        } else {
          sendResponse({ success: false, error: "Adapter not found" });
        }
        return true;
      }
      if (message.type === "UNINSTALL_ADAPTER") {
        const adapter = getAdapter(message.adapterName);
        if (adapter) {
          adapter.uninstall().then(() => {
            storage.get("installedAdapters").then((adapters) => {
              delete adapters[message.adapterName];
              storage.set("installedAdapters", adapters).then(async () => {
                await updatePolling();
                sendResponse({ success: true });
              });
            });
          });
        } else {
          sendResponse({ success: false, error: "Adapter not found" });
        }
        return true;
      }
    });
    (async () => {
      await updatePolling();
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy9Ad3h0LWRldi9icm93c2VyL3NyYy9pbmRleC5tanMiLCIuLi8uLi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvYnJvd3Nlci5tanMiLCIuLi8uLi9zcmMvY29yZS9TdG9yYWdlLnRzIiwiLi4vLi4vc3JjL2FkYXB0ZXJzL2dpdGh1Yi50cyIsIi4uLy4uL3NyYy9hZGFwdGVycy9pbmRleC50cyIsIi4uLy4uL3NyYy9jb3JlL1RhYk1hbmFnZXIudHMiLCIuLi8uLi9zcmMvY29yZS9TY2hlZHVsZXIudHMiLCIuLi8uLi9lbnRyeXBvaW50cy9iYWNrZ3JvdW5kLnRzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3ZWJleHQtY29yZS9tYXRjaC1wYXR0ZXJucy9saWIvaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8jcmVnaW9uIHNyYy91dGlscy9kZWZpbmUtYmFja2dyb3VuZC50c1xuZnVuY3Rpb24gZGVmaW5lQmFja2dyb3VuZChhcmcpIHtcblx0aWYgKGFyZyA9PSBudWxsIHx8IHR5cGVvZiBhcmcgPT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHsgbWFpbjogYXJnIH07XG5cdHJldHVybiBhcmc7XG59XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgZGVmaW5lQmFja2dyb3VuZCB9OyIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgYnJvd3NlciQxIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcblxuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb24gQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pXG4qIGBgYFxuKiBAbW9kdWxlIHd4dC9icm93c2VyXG4qL1xuY29uc3QgYnJvd3NlciA9IGJyb3dzZXIkMTtcblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBicm93c2VyIH07IiwiZXhwb3J0IGludGVyZmFjZSBBZGFwdGVyQ29uZmlnIHtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgcG9sbGluZ0ludGVydmFsPzogbnVtYmVyO1xuICBjb25maWc6IFJlY29yZDxzdHJpbmcsIGFueT47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXh0ZW5zaW9uU2V0dGluZ3Mge1xuICBmZXRjaE1vZGU6ICd0b2dldGhlcicgfCAnaW5kaXZpZHVhbCc7XG4gIG1hc3RlckVuYWJsZWQ6IGJvb2xlYW47XG4gIGdsb2JhbFBvbGxpbmdJbnRlcnZhbDogbnVtYmVyO1xuICBpbnN0YWxsZWRBZGFwdGVyczogUmVjb3JkPHN0cmluZywgQWRhcHRlckNvbmZpZz47XG4gIGdyb3VwTWFwcGluZzogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgbGFzdFN5bmM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG59XG5cbmNvbnN0IGRlZmF1bHRzOiBFeHRlbnNpb25TZXR0aW5ncyA9IHtcbiAgZmV0Y2hNb2RlOiAndG9nZXRoZXInLFxuICBtYXN0ZXJFbmFibGVkOiBmYWxzZSxcbiAgZ2xvYmFsUG9sbGluZ0ludGVydmFsOiA1LFxuICBpbnN0YWxsZWRBZGFwdGVyczoge30sXG4gIGdyb3VwTWFwcGluZzoge30sXG4gIGxhc3RTeW5jOiB7fSxcbn07XG5cbmV4cG9ydCBjb25zdCBzdG9yYWdlID0ge1xuICBhc3luYyBnZXQ8SyBleHRlbmRzIGtleW9mIEV4dGVuc2lvblNldHRpbmdzPihrZXk6IEspOiBQcm9taXNlPEV4dGVuc2lvblNldHRpbmdzW0tdPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChrZXkpO1xuICAgIHJldHVybiAocmVzdWx0W2tleV0gPz8gZGVmYXVsdHNba2V5XSkgYXMgRXh0ZW5zaW9uU2V0dGluZ3NbS107XG4gIH0sXG5cbiAgYXN5bmMgc2V0PEsgZXh0ZW5kcyBrZXlvZiBFeHRlbnNpb25TZXR0aW5ncz4oXG4gICAga2V5OiBLLFxuICAgIHZhbHVlOiBFeHRlbnNpb25TZXR0aW5nc1tLXVxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuc2V0KHsgW2tleV06IHZhbHVlIH0pO1xuICB9LFxuXG4gIGFzeW5jIGdldEFsbCgpOiBQcm9taXNlPEV4dGVuc2lvblNldHRpbmdzPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChPYmplY3Qua2V5cyhkZWZhdWx0cykpO1xuICAgIHJldHVybiB7XG4gICAgICAuLi5kZWZhdWx0cyxcbiAgICAgIC4uLnJlc3VsdCxcbiAgICB9IGFzIEV4dGVuc2lvblNldHRpbmdzO1xuICB9LFxuXG4gIGFzeW5jIHNldE11bHRpcGxlKHNldHRpbmdzOiBQYXJ0aWFsPEV4dGVuc2lvblNldHRpbmdzPik6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5zZXQoc2V0dGluZ3MpO1xuICB9LFxuXG4gIGRlZmF1bHRzLFxufTtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8RXh0ZW5zaW9uU2V0dGluZ3M+IHtcbiAgcmV0dXJuIHN0b3JhZ2UuZ2V0QWxsKCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moc2V0dGluZ3M6IFBhcnRpYWw8RXh0ZW5zaW9uU2V0dGluZ3M+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHN0b3JhZ2Uuc2V0TXVsdGlwbGUoc2V0dGluZ3MpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWRhcHRlckNvbmZpZyhhZGFwdGVyTmFtZTogc3RyaW5nKTogUHJvbWlzZTxBZGFwdGVyQ29uZmlnIHwgbnVsbD4ge1xuICBjb25zdCBhZGFwdGVycyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdpbnN0YWxsZWRBZGFwdGVycycpO1xuICByZXR1cm4gYWRhcHRlcnNbYWRhcHRlck5hbWVdIHx8IG51bGw7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXRBZGFwdGVyQ29uZmlnKGFkYXB0ZXJOYW1lOiBzdHJpbmcsIGNvbmZpZzogQWRhcHRlckNvbmZpZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhZGFwdGVycyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdpbnN0YWxsZWRBZGFwdGVycycpO1xuICBhZGFwdGVyc1thZGFwdGVyTmFtZV0gPSBjb25maWc7XG4gIGF3YWl0IHN0b3JhZ2Uuc2V0KCdpbnN0YWxsZWRBZGFwdGVycycsIGFkYXB0ZXJzKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlzQWRhcHRlckluc3RhbGxlZChhZGFwdGVyTmFtZTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGFkYXB0ZXJzID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2luc3RhbGxlZEFkYXB0ZXJzJyk7XG4gIHJldHVybiAhIWFkYXB0ZXJzW2FkYXB0ZXJOYW1lXTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGluc3RhbGxBZGFwdGVyKGFkYXB0ZXJOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYWRhcHRlcnMgPSBhd2FpdCBzdG9yYWdlLmdldCgnaW5zdGFsbGVkQWRhcHRlcnMnKTtcbiAgYWRhcHRlcnNbYWRhcHRlck5hbWVdID0ge1xuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgcG9sbGluZ0ludGVydmFsOiA1LFxuICAgIGNvbmZpZzoge30sXG4gIH07XG4gIGF3YWl0IHN0b3JhZ2Uuc2V0KCdpbnN0YWxsZWRBZGFwdGVycycsIGFkYXB0ZXJzKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHVuaW5zdGFsbEFkYXB0ZXIoYWRhcHRlck5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhZGFwdGVycyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdpbnN0YWxsZWRBZGFwdGVycycpO1xuICBkZWxldGUgYWRhcHRlcnNbYWRhcHRlck5hbWVdO1xuICBhd2FpdCBzdG9yYWdlLnNldCgnaW5zdGFsbGVkQWRhcHRlcnMnLCBhZGFwdGVycyk7XG59XG4iLCJpbXBvcnQgeyBBZGFwdGVyV2l0aEluc3RhbGwsIFB1bGxSZXF1ZXN0LCBTeW5jSXRlbSB9IGZyb20gJy4vdHlwZXMnO1xuaW1wb3J0IHsgZ2V0QWRhcHRlckNvbmZpZywgc2V0QWRhcHRlckNvbmZpZyB9IGZyb20gJy4uL2NvcmUvU3RvcmFnZSc7XG5cbmZ1bmN0aW9uIGV4dHJhY3RSZXBvRnJvbVVybChyZXBvc2l0b3J5VXJsOiBzdHJpbmcpOiB7IGZ1bGxOYW1lOiBzdHJpbmc7IG5hbWU6IHN0cmluZyB9IHtcbiAgY29uc3QgbWF0Y2ggPSByZXBvc2l0b3J5VXJsLm1hdGNoKC9yZXBvc1xcLyhbXlxcL10rKVxcLyhbXlxcL10rKSQvKTtcbiAgaWYgKG1hdGNoKSB7XG4gICAgcmV0dXJuIHsgZnVsbE5hbWU6IGAke21hdGNoWzFdfS8ke21hdGNoWzJdfWAsIG5hbWU6IG1hdGNoWzJdIH07XG4gIH1cbiAgcmV0dXJuIHsgZnVsbE5hbWU6ICd1bmtub3duJywgbmFtZTogJ3Vua25vd24nIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFRva2VuKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBjb25maWcgPSBhd2FpdCBnZXRBZGFwdGVyQ29uZmlnKCdnaXRodWInKTtcbiAgcmV0dXJuIGNvbmZpZz8uY29uZmlnPy50b2tlbiB8fCBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hSZXF1ZXN0ZWRQUnMoKTogUHJvbWlzZTxQdWxsUmVxdWVzdFtdPiB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgZ2V0VG9rZW4oKTtcbiAgaWYgKCF0b2tlbikge1xuICAgIHRocm93IG5ldyBFcnJvcignR2l0SHViIHRva2VuIG5vdCBjb25maWd1cmVkJyk7XG4gIH1cblxuICBjb25zdCBxdWVyeSA9ICdzdGF0ZTpvcGVuIGlzOnByIHVzZXItcmV2aWV3LXJlcXVlc3RlZDpAbWUnO1xuICBjb25zdCB1cmwgPSBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9zZWFyY2gvaXNzdWVzP3E9JHtlbmNvZGVVUklDb21wb25lbnQocXVlcnkpfSZzb3J0PXVwZGF0ZWQmcGVyX3BhZ2U9NTBgO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLCB7XG4gICAgaGVhZGVyczoge1xuICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi92bmQuZ2l0aHViLnYzK2pzb24nLFxuICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7dG9rZW59YCxcbiAgICAgICdYLUdpdEh1Yi1BcGktVmVyc2lvbic6ICcyMDIyLTExLTI4JyxcbiAgICB9LFxuICB9KTtcblxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIEdpdEh1YiB0b2tlbicpO1xuICAgIH1cbiAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignUmF0ZSBsaW1pdCBleGNlZWRlZC4gUGxlYXNlIHRyeSBhZ2FpbiBsYXRlci4nKTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKGBHaXRIdWIgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gLSAke2Vycm9yVGV4dH1gKTtcbiAgfVxuXG4gIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIHJldHVybiBkYXRhLml0ZW1zO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVRva2VuKHRva2VuOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY29uZmlnID0gYXdhaXQgZ2V0QWRhcHRlckNvbmZpZygnZ2l0aHViJyk7XG4gIGlmIChjb25maWcpIHtcbiAgICBhd2FpdCBzZXRBZGFwdGVyQ29uZmlnKCdnaXRodWInLCB7XG4gICAgICAuLi5jb25maWcsXG4gICAgICBjb25maWc6IHsgLi4uY29uZmlnLmNvbmZpZywgdG9rZW4gfSxcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0U2F2ZWRUb2tlbigpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgY29uZmlnID0gYXdhaXQgZ2V0QWRhcHRlckNvbmZpZygnZ2l0aHViJyk7XG4gIHJldHVybiBjb25maWc/LmNvbmZpZz8udG9rZW4gfHwgbnVsbDtcbn1cblxuZXhwb3J0IGNvbnN0IGdpdGh1YkFkYXB0ZXI6IEFkYXB0ZXJXaXRoSW5zdGFsbDxQdWxsUmVxdWVzdD4gPSB7XG4gIG5hbWU6ICdnaXRodWInLFxuICBncm91cFRpdGxlOiAn8J+UhCBHaXRIdWIgUmV2aWV3cycsXG4gIGRlc2NyaXB0aW9uOiAnVHJhY2sgUFJzIHdoZXJlIHlvdSBhcmUgYSByZXF1ZXN0ZWQgcmV2aWV3ZXInLFxuXG4gIGFzeW5jIGluc3RhbGwoKSB7XG4gICAgYXdhaXQgc2V0QWRhcHRlckNvbmZpZygnZ2l0aHViJywge1xuICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgIHBvbGxpbmdJbnRlcnZhbDogNSxcbiAgICAgIGNvbmZpZzoge30sXG4gICAgfSk7XG4gIH0sXG5cbiAgYXN5bmMgdW5pbnN0YWxsKCkge1xuICAgIC8vIENsZWFudXAgaGFuZGxlZCBieSBzdG9yYWdlXG4gIH0sXG5cbiAgYXN5bmMgZmV0Y2hJdGVtcygpIHtcbiAgICByZXR1cm4gZmV0Y2hSZXF1ZXN0ZWRQUnMoKTtcbiAgfSxcblxuICBnZXRJdGVtVXJsKGl0ZW06IFB1bGxSZXF1ZXN0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gaXRlbS5odG1sX3VybDtcbiAgfSxcblxuICBnZXRJdGVtSWQoaXRlbTogUHVsbFJlcXVlc3QpOiBzdHJpbmcge1xuICAgIGNvbnN0IHJlcG8gPSBleHRyYWN0UmVwb0Zyb21VcmwoaXRlbS5yZXBvc2l0b3J5X3VybCk7XG4gICAgcmV0dXJuIGAke3JlcG8uZnVsbE5hbWV9IyR7aXRlbS5udW1iZXJ9YDtcbiAgfSxcblxuICBnZXRJdGVtVGl0bGUoaXRlbTogUHVsbFJlcXVlc3QpOiBzdHJpbmcge1xuICAgIGNvbnN0IHJlcG8gPSBleHRyYWN0UmVwb0Zyb21VcmwoaXRlbS5yZXBvc2l0b3J5X3VybCk7XG4gICAgcmV0dXJuIGAke3JlcG8ubmFtZX0gIyR7aXRlbS5udW1iZXJ9OiAke2l0ZW0udGl0bGV9YDtcbiAgfSxcblxuICBpc0l0ZW1BY3RpdmUoaXRlbTogUHVsbFJlcXVlc3QpOiBib29sZWFuIHtcbiAgICByZXR1cm4gaXRlbS5zdGF0ZSA9PT0gJ29wZW4nO1xuICB9LFxufTtcbiIsImltcG9ydCB0eXBlIHsgQWRhcHRlcldpdGhJbnN0YWxsLCBBZGFwdGVyUmVnaXN0cnksIEF2YWlsYWJsZUFkYXB0ZXJzLCBBdmFpbGFibGVBZGFwdGVyIH0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgeyBnaXRodWJBZGFwdGVyIH0gZnJvbSAnLi9naXRodWInO1xuXG5leHBvcnQgdHlwZSB7IEFkYXB0ZXJXaXRoSW5zdGFsbCwgU3luY0l0ZW0sIFB1bGxSZXF1ZXN0LCBBZGFwdGVyUmVnaXN0cnksIEF2YWlsYWJsZUFkYXB0ZXIsIEF2YWlsYWJsZUFkYXB0ZXJzIH0gZnJvbSAnLi90eXBlcyc7XG5leHBvcnQgeyBnaXRodWJBZGFwdGVyIH0gZnJvbSAnLi9naXRodWInO1xuXG5leHBvcnQgY29uc3QgYWRhcHRlclJlZ2lzdHJ5OiBBZGFwdGVyUmVnaXN0cnkgPSB7XG4gIGdpdGh1YjogZ2l0aHViQWRhcHRlcixcbn07XG5cbmV4cG9ydCBjb25zdCBhdmFpbGFibGVBZGFwdGVyczogQXZhaWxhYmxlQWRhcHRlcnMgPSB7XG4gIGdpdGh1Yjoge1xuICAgIG5hbWU6ICdnaXRodWInLFxuICAgIGdyb3VwVGl0bGU6ICfwn5SEIEdpdEh1YiBSZXZpZXdzJyxcbiAgICBkZXNjcmlwdGlvbjogJ1RyYWNrIFBScyB3aGVyZSB5b3UgYXJlIGEgcmVxdWVzdGVkIHJldmlld2VyJyxcbiAgfSxcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRBZGFwdGVyKG5hbWU6IHN0cmluZyk6IEFkYXB0ZXJXaXRoSW5zdGFsbDxhbnk+IHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGFkYXB0ZXJSZWdpc3RyeVtuYW1lXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFsbEFkYXB0ZXJzKCk6IEFkYXB0ZXJXaXRoSW5zdGFsbDxhbnk+W10ge1xuICByZXR1cm4gT2JqZWN0LnZhbHVlcyhhZGFwdGVyUmVnaXN0cnkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXZhaWxhYmxlQWRhcHRlcnNMaXN0KCk6IEF2YWlsYWJsZUFkYXB0ZXJbXSB7XG4gIHJldHVybiBPYmplY3QudmFsdWVzKGF2YWlsYWJsZUFkYXB0ZXJzKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQWRhcHRlckF2YWlsYWJsZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuICEhYXZhaWxhYmxlQWRhcHRlcnNbbmFtZV07XG59XG4iLCJpbXBvcnQgeyBTeW5jSXRlbSB9IGZyb20gJy4uL2FkYXB0ZXJzL3R5cGVzJztcbmltcG9ydCB7IHN0b3JhZ2UgfSBmcm9tICcuL1N0b3JhZ2UnO1xuXG5jb25zdCBHUk9VUF9DT0xPUlMgPSBbJ2dyZXknLCAnYmx1ZScsICdyZWQnLCAneWVsbG93JywgJ2dyZWVuJywgJ3BpbmsnLCAncHVycGxlJywgJ2N5YW4nXSBhcyBjb25zdDtcblxuZXhwb3J0IGludGVyZmFjZSBUYWJNYW5hZ2VyT3B0aW9ucyB7XG4gIGdyb3VwVGl0bGU6IHN0cmluZztcbiAgYWRhcHRlck5hbWU6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFRhYk1hbmFnZXIge1xuICBwcml2YXRlIGdyb3VwVGl0bGU6IHN0cmluZztcbiAgcHJpdmF0ZSBhZGFwdGVyTmFtZTogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM6IFRhYk1hbmFnZXJPcHRpb25zKSB7XG4gICAgdGhpcy5ncm91cFRpdGxlID0gb3B0aW9ucy5ncm91cFRpdGxlO1xuICAgIHRoaXMuYWRhcHRlck5hbWUgPSBvcHRpb25zLmFkYXB0ZXJOYW1lO1xuICB9XG5cbiAgYXN5bmMgZ2V0R3JvdXBJZCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgICBjb25zdCBtYXBwaW5nID0gYXdhaXQgc3RvcmFnZS5nZXQoJ2dyb3VwTWFwcGluZycpO1xuICAgIHJldHVybiBtYXBwaW5nW3RoaXMuYWRhcHRlck5hbWVdIHx8IG51bGw7XG4gIH1cblxuICBhc3luYyBzZXRHcm91cElkKGdyb3VwSWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IG1hcHBpbmcgPSBhd2FpdCBzdG9yYWdlLmdldCgnZ3JvdXBNYXBwaW5nJyk7XG4gICAgbWFwcGluZ1t0aGlzLmFkYXB0ZXJOYW1lXSA9IGdyb3VwSWQ7XG4gICAgYXdhaXQgc3RvcmFnZS5zZXQoJ2dyb3VwTWFwcGluZycsIG1hcHBpbmcpO1xuICB9XG5cbiAgYXN5bmMgc3luY0dyb3VwKGl0ZW1zOiBTeW5jSXRlbVtdKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY3VycmVudFdpbmRvdyA9IGF3YWl0IGJyb3dzZXIud2luZG93cy5nZXRDdXJyZW50KCk7XG4gICAgaWYgKCFjdXJyZW50V2luZG93LmlkKSByZXR1cm47XG5cbiAgICBjb25zdCBpdGVtSWRzID0gbmV3IFNldChpdGVtcy5tYXAoaXRlbSA9PiBpdGVtLmlkKSk7XG4gICAgbGV0IGV4aXN0aW5nR3JvdXBJZCA9IGF3YWl0IHRoaXMuZ2V0R3JvdXBJZCgpO1xuICAgIGxldCBncm91cElkID0gZXhpc3RpbmdHcm91cElkO1xuXG4gICAgaWYgKGdyb3VwSWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGJyb3dzZXIudGFiR3JvdXBzLmdldChncm91cElkKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBncm91cElkID0gbnVsbDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBhbGxUYWJzID0gYXdhaXQgYnJvd3Nlci50YWJzLnF1ZXJ5KHsgd2luZG93SWQ6IGN1cnJlbnRXaW5kb3cuaWQgfSk7XG4gICAgY29uc3QgbWFuYWdlZFRhYnM6IGJyb3dzZXIudGFicy5UYWJbXSA9IFtdO1xuXG4gICAgaWYgKGdyb3VwSWQpIHtcbiAgICAgIGZvciAoY29uc3QgdGFiIG9mIGFsbFRhYnMpIHtcbiAgICAgICAgaWYgKHRhYi5ncm91cElkID09PSBncm91cElkKSB7XG4gICAgICAgICAgbWFuYWdlZFRhYnMucHVzaCh0YWIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgdGFic1RvUmVtb3ZlOiBudW1iZXJbXSA9IFtdO1xuXG4gICAgZm9yIChjb25zdCB0YWIgb2YgbWFuYWdlZFRhYnMpIHtcbiAgICAgIGlmICh0YWIudXJsKSB7XG4gICAgICAgIGNvbnN0IGl0ZW1JZCA9IHRoaXMuZXh0cmFjdEl0ZW1JZCh0YWIudXJsKTtcbiAgICAgICAgaWYgKGl0ZW1JZCAmJiAhaXRlbUlkcy5oYXMoaXRlbUlkKSkge1xuICAgICAgICAgIHRhYnNUb1JlbW92ZS5wdXNoKHRhYi5pZCEpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgdGFic1RvQWRkOiBudW1iZXJbXSA9IFtdO1xuICAgIGNvbnN0IGV4aXN0aW5nVXJscyA9IG5ldyBTZXQobWFuYWdlZFRhYnMubWFwKHQgPT4gdC51cmwpLmZpbHRlcigodSk6IHUgaXMgc3RyaW5nID0+ICEhdSkpO1xuXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICBpZiAoIWV4aXN0aW5nVXJscy5oYXMoaXRlbS51cmwpKSB7XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nVGFiID0gYWxsVGFicy5maW5kKHQgPT4gdC51cmwgPT09IGl0ZW0udXJsKTtcbiAgICAgICAgaWYgKGV4aXN0aW5nVGFiKSB7XG4gICAgICAgICAgdGFic1RvQWRkLnB1c2goZXhpc3RpbmdUYWIuaWQhKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBuZXdUYWIgPSBhd2FpdCBicm93c2VyLnRhYnMuY3JlYXRlKHsgdXJsOiBpdGVtLnVybCwgYWN0aXZlOiBmYWxzZSB9KTtcbiAgICAgICAgICB0YWJzVG9BZGQucHVzaChuZXdUYWIuaWQhKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0YWJzVG9SZW1vdmUubGVuZ3RoID4gMCkge1xuICAgICAgYXdhaXQgYnJvd3Nlci50YWJzLnVuZ3JvdXAodGFic1RvUmVtb3ZlKTtcbiAgICAgIGF3YWl0IGJyb3dzZXIudGFicy5yZW1vdmUodGFic1RvUmVtb3ZlKTtcbiAgICB9XG5cbiAgICBpZiAodGFic1RvQWRkLmxlbmd0aCA9PT0gMCAmJiBtYW5hZ2VkVGFicy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodGFic1RvQWRkLmxlbmd0aCA+IDApIHtcbiAgICAgIGlmIChncm91cElkKSB7XG4gICAgICAgIGNvbnN0IGdyb3VwVGFicyA9IGF3YWl0IGJyb3dzZXIudGFicy5xdWVyeSh7IGdyb3VwSWQ6IGdyb3VwSWQgfSk7XG4gICAgICAgIGNvbnN0IGN1cnJlbnRUYWJJZHMgPSBncm91cFRhYnMubWFwKHQgPT4gdC5pZCkuZmlsdGVyKChpZCk6IGlkIGlzIG51bWJlciA9PiBpZCAhPT0gdW5kZWZpbmVkKTtcbiAgICAgICAgaWYgKGN1cnJlbnRUYWJJZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IGFsbFRhYklkcyA9IFsuLi5jdXJyZW50VGFiSWRzLCAuLi50YWJzVG9BZGRdO1xuICAgICAgICAgIGF3YWl0IGJyb3dzZXIudGFicy5ncm91cCh7IHRhYklkczogYWxsVGFiSWRzIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGF3YWl0IGJyb3dzZXIudGFicy5ncm91cCh7IHRhYklkczogdGFic1RvQWRkIGFzIFtudW1iZXIsIC4uLm51bWJlcltdXSB9KTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBicm93c2VyLnRhYkdyb3Vwcy51cGRhdGUoZ3JvdXBJZCwgeyB0aXRsZTogdGhpcy5ncm91cFRpdGxlIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgbmV3R3JvdXBJZCA9IGF3YWl0IGJyb3dzZXIudGFicy5ncm91cCh7IHRhYklkczogdGFic1RvQWRkIGFzIFtudW1iZXIsIC4uLm51bWJlcltdXSB9KTtcbiAgICAgICAgY29uc3QgbWFwcGluZyA9IGF3YWl0IHN0b3JhZ2UuZ2V0KCdncm91cE1hcHBpbmcnKTtcbiAgICAgICAgY29uc3QgY29sb3JJbmRleCA9IE9iamVjdC5rZXlzKG1hcHBpbmcpLmxlbmd0aCAlIEdST1VQX0NPTE9SUy5sZW5ndGg7XG4gICAgICAgIGF3YWl0IGJyb3dzZXIudGFiR3JvdXBzLnVwZGF0ZShuZXdHcm91cElkLCB7XG4gICAgICAgICAgdGl0bGU6IHRoaXMuZ3JvdXBUaXRsZSxcbiAgICAgICAgICBjb2xvcjogR1JPVVBfQ09MT1JTW2NvbG9ySW5kZXhdLFxuICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRHcm91cElkKG5ld0dyb3VwSWQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGF3YWl0IHN0b3JhZ2Uuc2V0KCdsYXN0U3luYycsIERhdGUubm93KCkpO1xuICB9XG5cbiAgcHJpdmF0ZSBleHRyYWN0SXRlbUlkKHVybDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgY29uc3QgbWF0Y2ggPSB1cmwubWF0Y2goL2dpdGh1YlxcLmNvbVxcLyhbXlxcL10rXFwvW15cXC9dKylcXC9wdWxsXFwvKFxcZCspLyk7XG4gICAgaWYgKG1hdGNoKSB7XG4gICAgICByZXR1cm4gYCR7bWF0Y2hbMV19IyR7bWF0Y2hbMl19YDtcbiAgICB9XG4gICAgY29uc3QgcHJNYXRjaCA9IHVybC5tYXRjaCgvXFwvcHVsbFxcLyhcXGQrKS8pO1xuICAgIGlmIChwck1hdGNoKSB7XG4gICAgICByZXR1cm4gcHJNYXRjaFsxXTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBhc3luYyByZW1vdmVHcm91cCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBncm91cElkID0gYXdhaXQgdGhpcy5nZXRHcm91cElkKCk7XG4gICAgaWYgKCFncm91cElkKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFicyA9IGF3YWl0IGJyb3dzZXIudGFicy5xdWVyeSh7IGdyb3VwSWQ6IGdyb3VwSWQgfSk7XG4gICAgICBjb25zdCB0YWJJZHMgPSB0YWJzLm1hcCh0ID0+IHQuaWQpLmZpbHRlcigoaWQpOiBpZCBpcyBudW1iZXIgPT4gaWQgIT09IHVuZGVmaW5lZCk7XG4gICAgICBcbiAgICAgIGlmICh0YWJJZHMubGVuZ3RoID4gMCkge1xuICAgICAgICBhd2FpdCBicm93c2VyLnRhYnMudW5ncm91cCh0YWJJZHMpO1xuICAgICAgICBhd2FpdCBicm93c2VyLnRhYnMucmVtb3ZlKHRhYklkcyk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1hcHBpbmcgPSBhd2FpdCBzdG9yYWdlLmdldCgnZ3JvdXBNYXBwaW5nJyk7XG4gICAgICBkZWxldGUgbWFwcGluZ1t0aGlzLmFkYXB0ZXJOYW1lXTtcbiAgICAgIGF3YWl0IHN0b3JhZ2Uuc2V0KCdncm91cE1hcHBpbmcnLCBtYXBwaW5nKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnN0IG1hcHBpbmcgPSBhd2FpdCBzdG9yYWdlLmdldCgnZ3JvdXBNYXBwaW5nJyk7XG4gICAgICBkZWxldGUgbWFwcGluZ1t0aGlzLmFkYXB0ZXJOYW1lXTtcbiAgICAgIGF3YWl0IHN0b3JhZ2Uuc2V0KCdncm91cE1hcHBpbmcnLCBtYXBwaW5nKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZpbmRUYWJCeVVybCh1cmw6IHN0cmluZyk6IFByb21pc2U8YnJvd3Nlci50YWJzLlRhYiB8IG51bGw+IHtcbiAgY29uc3QgdGFicyA9IGF3YWl0IGJyb3dzZXIudGFicy5xdWVyeSh7IHVybCB9KTtcbiAgcmV0dXJuIHRhYnNbMF0gfHwgbnVsbDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVRhYih1cmw6IHN0cmluZyk6IFByb21pc2U8YnJvd3Nlci50YWJzLlRhYj4ge1xuICByZXR1cm4gYnJvd3Nlci50YWJzLmNyZWF0ZSh7IHVybCwgYWN0aXZlOiBmYWxzZSB9KTtcbn1cbiIsImltcG9ydCB7IHN0b3JhZ2UgfSBmcm9tICcuL1N0b3JhZ2UnO1xuXG5leHBvcnQgY29uc3QgTUFTVEVSX0FMQVJNX05BTUUgPSAnYXV0by1ncm91cHMtbWFzdGVyJztcbmV4cG9ydCBjb25zdCBBREFQVEVSX0FMQVJNX1BSRUZJWCA9ICdhdXRvLWdyb3Vwcy0nO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRNYXN0ZXJQb2xsaW5nKGludGVydmFsTWludXRlczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGJyb3dzZXIuYWxhcm1zLmNyZWF0ZShNQVNURVJfQUxBUk1fTkFNRSwge1xuICAgIHBlcmlvZEluTWludXRlczogaW50ZXJ2YWxNaW51dGVzLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0b3BNYXN0ZXJQb2xsaW5nKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhbGFybSA9IGF3YWl0IGJyb3dzZXIuYWxhcm1zLmdldChNQVNURVJfQUxBUk1fTkFNRSk7XG4gIGlmIChhbGFybSkge1xuICAgIGF3YWl0IGJyb3dzZXIuYWxhcm1zLmNsZWFyKE1BU1RFUl9BTEFSTV9OQU1FKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRBZGFwdGVyUG9sbGluZyhhZGFwdGVyTmFtZTogc3RyaW5nLCBpbnRlcnZhbE1pbnV0ZXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBicm93c2VyLmFsYXJtcy5jcmVhdGUoYCR7QURBUFRFUl9BTEFSTV9QUkVGSVh9JHthZGFwdGVyTmFtZX1gLCB7XG4gICAgcGVyaW9kSW5NaW51dGVzOiBpbnRlcnZhbE1pbnV0ZXMsXG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RvcEFkYXB0ZXJQb2xsaW5nKGFkYXB0ZXJOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYWxhcm0gPSBhd2FpdCBicm93c2VyLmFsYXJtcy5nZXQoYCR7QURBUFRFUl9BTEFSTV9QUkVGSVh9JHthZGFwdGVyTmFtZX1gKTtcbiAgaWYgKGFsYXJtKSB7XG4gICAgYXdhaXQgYnJvd3Nlci5hbGFybXMuY2xlYXIoYCR7QURBUFRFUl9BTEFSTV9QUkVGSVh9JHthZGFwdGVyTmFtZX1gKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlUG9sbGluZygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBzdG9yYWdlLmdldEFsbCgpO1xuICBcbiAgYXdhaXQgc3RvcE1hc3RlclBvbGxpbmcoKTtcbiAgXG4gIGNvbnN0IGFkYXB0ZXJzID0gT2JqZWN0LmtleXMoc2V0dGluZ3MuaW5zdGFsbGVkQWRhcHRlcnMpO1xuICBmb3IgKGNvbnN0IGFkYXB0ZXIgb2YgYWRhcHRlcnMpIHtcbiAgICBhd2FpdCBzdG9wQWRhcHRlclBvbGxpbmcoYWRhcHRlcik7XG4gIH1cblxuICBpZiAoc2V0dGluZ3MuZmV0Y2hNb2RlID09PSAndG9nZXRoZXInKSB7XG4gICAgaWYgKHNldHRpbmdzLm1hc3RlckVuYWJsZWQpIHtcbiAgICAgIGF3YWl0IHN0YXJ0TWFzdGVyUG9sbGluZyhzZXR0aW5ncy5nbG9iYWxQb2xsaW5nSW50ZXJ2YWwpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGNvbnN0IGFkYXB0ZXIgb2YgYWRhcHRlcnMpIHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IHNldHRpbmdzLmluc3RhbGxlZEFkYXB0ZXJzW2FkYXB0ZXJdO1xuICAgICAgaWYgKGNvbmZpZy5lbmFibGVkICYmIGNvbmZpZy5wb2xsaW5nSW50ZXJ2YWwpIHtcbiAgICAgICAgYXdhaXQgc3RhcnRBZGFwdGVyUG9sbGluZyhhZGFwdGVyLCBjb25maWcucG9sbGluZ0ludGVydmFsKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uQWxhcm0oY2FsbGJhY2s6IChhbGFybTogYnJvd3Nlci5hbGFybXMuQWxhcm0pID0+IHZvaWQpOiB2b2lkIHtcbiAgYnJvd3Nlci5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcihjYWxsYmFjayk7XG59XG4iLCJpbXBvcnQgeyBnZXRBZGFwdGVyLCBnZXRBbGxBZGFwdGVycyB9IGZyb20gJy4uL3NyYy9hZGFwdGVycyc7XG5pbXBvcnQgeyBUYWJNYW5hZ2VyIH0gZnJvbSAnLi4vc3JjL2NvcmUvVGFiTWFuYWdlcic7XG5pbXBvcnQgeyBzdG9yYWdlLCBnZXRTZXR0aW5ncywgZ2V0QWRhcHRlckNvbmZpZyB9IGZyb20gJy4uL3NyYy9jb3JlL1N0b3JhZ2UnO1xuaW1wb3J0IHsgXG4gIE1BU1RFUl9BTEFSTV9OQU1FLCBcbiAgQURBUFRFUl9BTEFSTV9QUkVGSVgsIFxuICBvbkFsYXJtLCBcbiAgdXBkYXRlUG9sbGluZyBcbn0gZnJvbSAnLi4vc3JjL2NvcmUvU2NoZWR1bGVyJztcblxuYXN5bmMgZnVuY3Rpb24gcnVuQWRhcHRlclN5bmMoYWRhcHRlck5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhZGFwdGVyID0gZ2V0QWRhcHRlcihhZGFwdGVyTmFtZSk7XG4gIGlmICghYWRhcHRlcikge1xuICAgIGNvbnNvbGUuZXJyb3IoYEFkYXB0ZXIgbm90IGZvdW5kOiAke2FkYXB0ZXJOYW1lfWApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGNvbmZpZyA9IGF3YWl0IGdldEFkYXB0ZXJDb25maWcoYWRhcHRlck5hbWUpO1xuICBpZiAoIWNvbmZpZyB8fCAhY29uZmlnLmVuYWJsZWQpIHtcbiAgICBjb25zb2xlLmxvZyhgQWRhcHRlciAke2FkYXB0ZXJOYW1lfSBpcyBkaXNhYmxlZCwgc2tpcHBpbmdgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0YWJNYW5hZ2VyID0gbmV3IFRhYk1hbmFnZXIoe1xuICAgIGdyb3VwVGl0bGU6IGFkYXB0ZXIuZ3JvdXBUaXRsZSxcbiAgICBhZGFwdGVyTmFtZTogYWRhcHRlci5uYW1lLFxuICB9KTtcblxuICB0cnkge1xuICAgIGNvbnNvbGUubG9nKGBbQXV0byBHcm91cHNdIEZldGNoaW5nIGl0ZW1zIGZvciAke2FkYXB0ZXJOYW1lfS4uLmApO1xuICAgIGNvbnN0IGl0ZW1zID0gYXdhaXQgYWRhcHRlci5mZXRjaEl0ZW1zKCk7XG4gICAgY29uc29sZS5sb2coYFtBdXRvIEdyb3Vwc10gR290ICR7aXRlbXMubGVuZ3RofSBpdGVtc2ApO1xuICAgIFxuICAgIGNvbnN0IHN5bmNJdGVtcyA9IGl0ZW1zLm1hcChpdGVtID0+ICh7XG4gICAgICBpZDogYWRhcHRlci5nZXRJdGVtSWQoaXRlbSksXG4gICAgICB1cmw6IGFkYXB0ZXIuZ2V0SXRlbVVybChpdGVtKSxcbiAgICAgIHRpdGxlOiBhZGFwdGVyLmdldEl0ZW1UaXRsZShpdGVtKSxcbiAgICB9KSk7XG4gICAgXG4gICAgYXdhaXQgdGFiTWFuYWdlci5zeW5jR3JvdXAoc3luY0l0ZW1zKTtcbiAgICBjb25zb2xlLmxvZyhgW0F1dG8gR3JvdXBzXSBTeW5jZWQgJHtzeW5jSXRlbXMubGVuZ3RofSBpdGVtcyBmb3IgJHthZGFwdGVyTmFtZX1gKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKGBbQXV0byBHcm91cHNdIEVycm9yIHN5bmNpbmcgJHthZGFwdGVyTmFtZX06YCwgZXJyb3IpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNBbGxBZGFwdGVycygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBnZXRTZXR0aW5ncygpO1xuICBcbiAgaWYgKHNldHRpbmdzLmZldGNoTW9kZSA9PT0gJ3RvZ2V0aGVyJykge1xuICAgIGlmICghc2V0dGluZ3MubWFzdGVyRW5hYmxlZCkge1xuICAgICAgY29uc29sZS5sb2coJ1tBdXRvIEdyb3Vwc10gTWFzdGVyIGRpc2FibGVkLCBza2lwcGluZyBzeW5jJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IGFkYXB0ZXJzID0gZ2V0QWxsQWRhcHRlcnMoKTtcbiAgICBmb3IgKGNvbnN0IGFkYXB0ZXIgb2YgYWRhcHRlcnMpIHtcbiAgICAgIGF3YWl0IHJ1bkFkYXB0ZXJTeW5jKGFkYXB0ZXIubmFtZSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvbnN0IGluc3RhbGxlZEFkYXB0ZXJzID0gT2JqZWN0LmtleXMoc2V0dGluZ3MuaW5zdGFsbGVkQWRhcHRlcnMpO1xuICAgIGZvciAoY29uc3QgYWRhcHRlck5hbWUgb2YgaW5zdGFsbGVkQWRhcHRlcnMpIHtcbiAgICAgIGF3YWl0IHJ1bkFkYXB0ZXJTeW5jKGFkYXB0ZXJOYW1lKTtcbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gc3luY0FkYXB0ZXIoYWRhcHRlck5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IGdldFNldHRpbmdzKCk7XG4gIFxuICBpZiAoc2V0dGluZ3MuZmV0Y2hNb2RlID09PSAndG9nZXRoZXInKSB7XG4gICAgaWYgKHNldHRpbmdzLm1hc3RlckVuYWJsZWQpIHtcbiAgICAgIGF3YWl0IHJ1bkFkYXB0ZXJTeW5jKGFkYXB0ZXJOYW1lKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgYXdhaXQgcnVuQWRhcHRlclN5bmMoYWRhcHRlck5hbWUpO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUJhY2tncm91bmQoKCkgPT4ge1xuICBjb25zb2xlLmxvZygnQXV0byBHcm91cHMgZXh0ZW5zaW9uIHN0YXJ0ZWQnKTtcblxuICBicm93c2VyLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnNvbGUubG9nKCdFeHRlbnNpb24gaW5zdGFsbGVkJyk7XG4gIH0pO1xuXG4gIG9uQWxhcm0oYXN5bmMgKGFsYXJtKSA9PiB7XG4gICAgY29uc29sZS5sb2coYFtBdXRvIEdyb3Vwc10gQWxhcm0gdHJpZ2dlcmVkOiAke2FsYXJtLm5hbWV9YCk7XG4gICAgXG4gICAgaWYgKGFsYXJtLm5hbWUgPT09IE1BU1RFUl9BTEFSTV9OQU1FKSB7XG4gICAgICBhd2FpdCBzeW5jQWxsQWRhcHRlcnMoKTtcbiAgICB9IGVsc2UgaWYgKGFsYXJtLm5hbWUuc3RhcnRzV2l0aChBREFQVEVSX0FMQVJNX1BSRUZJWCkpIHtcbiAgICAgIGNvbnN0IGFkYXB0ZXJOYW1lID0gYWxhcm0ubmFtZS5yZXBsYWNlKEFEQVBURVJfQUxBUk1fUFJFRklYLCAnJyk7XG4gICAgICBhd2FpdCBzeW5jQWRhcHRlcihhZGFwdGVyTmFtZSk7XG4gICAgfVxuICB9KTtcblxuICBicm93c2VyLnN0b3JhZ2Uub25DaGFuZ2VkLmFkZExpc3RlbmVyKGFzeW5jIChjaGFuZ2VzLCBhcmVhKSA9PiB7XG4gICAgaWYgKGFyZWEgPT09ICdsb2NhbCcpIHtcbiAgICAgIGlmIChjaGFuZ2VzLmZldGNoTW9kZSB8fCBjaGFuZ2VzLm1hc3RlckVuYWJsZWQgfHwgY2hhbmdlcy5nbG9iYWxQb2xsaW5nSW50ZXJ2YWwgfHwgY2hhbmdlcy5pbnN0YWxsZWRBZGFwdGVycykge1xuICAgICAgICBhd2FpdCB1cGRhdGVQb2xsaW5nKCk7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICBicm93c2VyLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBfc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnU1lOQ19OT1cnKSB7XG4gICAgICBjb25zb2xlLmxvZygnW0F1dG8gR3JvdXBzXSBNYW51YWwgc3luYyB0cmlnZ2VyZWQnKTtcbiAgICAgIHN5bmNBbGxBZGFwdGVycygpLnRoZW4oKCkgPT4gc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KSlcbiAgICAgICAgLmNhdGNoKGVyciA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGVyci5tZXNzYWdlIH0pKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdTWU5DX0FEQVBURVInKSB7XG4gICAgICBjb25zb2xlLmxvZyhgW0F1dG8gR3JvdXBzXSBNYW51YWwgc3luYyBmb3IgJHttZXNzYWdlLmFkYXB0ZXJOYW1lfWApO1xuICAgICAgc3luY0FkYXB0ZXIobWVzc2FnZS5hZGFwdGVyTmFtZSkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pKVxuICAgICAgICAuY2F0Y2goZXJyID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSkpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIFxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdHRVRfU1RBVFVTJykge1xuICAgICAgZ2V0U2V0dGluZ3MoKS50aGVuKHNldHRpbmdzID0+IHtcbiAgICAgICAgY29uc3QgaW5zdGFsbGVkID0gT2JqZWN0LmtleXMoc2V0dGluZ3MuaW5zdGFsbGVkQWRhcHRlcnMpO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgYWRhcHRlcnNXaXRoTWV0YTogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgaW5zdGFsbGVkKSB7XG4gICAgICAgICAgY29uc3QgYWRhcHRlciA9IGdldEFkYXB0ZXIobmFtZSk7XG4gICAgICAgICAgYWRhcHRlcnNXaXRoTWV0YVtuYW1lXSA9IHtcbiAgICAgICAgICAgIC4uLnNldHRpbmdzLmluc3RhbGxlZEFkYXB0ZXJzW25hbWVdLFxuICAgICAgICAgICAgZ3JvdXBUaXRsZTogYWRhcHRlcj8uZ3JvdXBUaXRsZSB8fCBuYW1lLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHNlbmRSZXNwb25zZSh7IFxuICAgICAgICAgIGZldGNoTW9kZTogc2V0dGluZ3MuZmV0Y2hNb2RlLFxuICAgICAgICAgIG1hc3RlckVuYWJsZWQ6IHNldHRpbmdzLm1hc3RlckVuYWJsZWQsXG4gICAgICAgICAgZ2xvYmFsUG9sbGluZ0ludGVydmFsOiBzZXR0aW5ncy5nbG9iYWxQb2xsaW5nSW50ZXJ2YWwsXG4gICAgICAgICAgaW5zdGFsbGVkQWRhcHRlcnM6IGFkYXB0ZXJzV2l0aE1ldGEsXG4gICAgICAgICAgaW5zdGFsbGVkTGlzdDogaW5zdGFsbGVkLFxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ1VQREFURV9TRVRUSU5HUycpIHtcbiAgICAgIGNvbnN0IHsgZmV0Y2hNb2RlLCBtYXN0ZXJFbmFibGVkLCBnbG9iYWxQb2xsaW5nSW50ZXJ2YWwgfSA9IG1lc3NhZ2U7XG4gICAgICBzdG9yYWdlLnNldE11bHRpcGxlKHtcbiAgICAgICAgZmV0Y2hNb2RlLFxuICAgICAgICBtYXN0ZXJFbmFibGVkLFxuICAgICAgICBnbG9iYWxQb2xsaW5nSW50ZXJ2YWwsXG4gICAgICB9KS50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQgdXBkYXRlUG9sbGluZygpO1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiB0cnVlIH0pO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnVVBEQVRFX0FEQVBURVJfQ09ORklHJykge1xuICAgICAgY29uc3QgeyBhZGFwdGVyTmFtZSwgZW5hYmxlZCwgcG9sbGluZ0ludGVydmFsLCBjb25maWcgfSA9IG1lc3NhZ2U7XG4gICAgICBjb25zb2xlLmxvZygnW0F1dG8gR3JvdXBzXSBVUERBVEVfQURBUFRFUl9DT05GSUc6JywgeyBhZGFwdGVyTmFtZSwgZW5hYmxlZCwgcG9sbGluZ0ludGVydmFsLCBjb25maWcgfSk7XG4gICAgICBnZXRBZGFwdGVyQ29uZmlnKGFkYXB0ZXJOYW1lKS50aGVuKGN1cnJlbnRDb25maWcgPT4ge1xuICAgICAgICBpZiAoY3VycmVudENvbmZpZykge1xuICAgICAgICAgIHN0b3JhZ2UuZ2V0KCdpbnN0YWxsZWRBZGFwdGVycycpLnRoZW4oYWRhcHRlcnMgPT4ge1xuICAgICAgICAgICAgY29uc3QgbmV3Q29uZmlnID0ge1xuICAgICAgICAgICAgICBlbmFibGVkOiBlbmFibGVkICE9PSB1bmRlZmluZWQgPyBlbmFibGVkIDogY3VycmVudENvbmZpZy5lbmFibGVkLFxuICAgICAgICAgICAgICBwb2xsaW5nSW50ZXJ2YWw6IHBvbGxpbmdJbnRlcnZhbCAhPT0gdW5kZWZpbmVkID8gcG9sbGluZ0ludGVydmFsIDogY3VycmVudENvbmZpZy5wb2xsaW5nSW50ZXJ2YWwsXG4gICAgICAgICAgICAgIGNvbmZpZzogeyAuLi5jdXJyZW50Q29uZmlnLmNvbmZpZywgLi4uY29uZmlnIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1tBdXRvIEdyb3Vwc10gTmV3IGNvbmZpZzonLCBuZXdDb25maWcpO1xuICAgICAgICAgICAgc3RvcmFnZS5zZXQoJ2luc3RhbGxlZEFkYXB0ZXJzJywge1xuICAgICAgICAgICAgICAuLi5hZGFwdGVycyxcbiAgICAgICAgICAgICAgW2FkYXB0ZXJOYW1lXTogbmV3Q29uZmlnLFxuICAgICAgICAgICAgfSkudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIGF3YWl0IHVwZGF0ZVBvbGxpbmcoKTtcbiAgICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ0FkYXB0ZXIgbm90IGZvdW5kJyB9KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnSU5TVEFMTF9BREFQVEVSJykge1xuICAgICAgY29uc3QgYWRhcHRlciA9IGdldEFkYXB0ZXIobWVzc2FnZS5hZGFwdGVyTmFtZSk7XG4gICAgICBpZiAoYWRhcHRlcikge1xuICAgICAgICBhZGFwdGVyLmluc3RhbGwoKS50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgICBhd2FpdCB1cGRhdGVQb2xsaW5nKCk7XG4gICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICdBZGFwdGVyIG5vdCBmb3VuZCcgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnVU5JTlNUQUxMX0FEQVBURVInKSB7XG4gICAgICBjb25zdCBhZGFwdGVyID0gZ2V0QWRhcHRlcihtZXNzYWdlLmFkYXB0ZXJOYW1lKTtcbiAgICAgIGlmIChhZGFwdGVyKSB7XG4gICAgICAgIGFkYXB0ZXIudW5pbnN0YWxsKCkudGhlbigoKSA9PiB7XG4gICAgICAgICAgc3RvcmFnZS5nZXQoJ2luc3RhbGxlZEFkYXB0ZXJzJykudGhlbihhZGFwdGVycyA9PiB7XG4gICAgICAgICAgICBkZWxldGUgYWRhcHRlcnNbbWVzc2FnZS5hZGFwdGVyTmFtZV07XG4gICAgICAgICAgICBzdG9yYWdlLnNldCgnaW5zdGFsbGVkQWRhcHRlcnMnLCBhZGFwdGVycykudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIGF3YWl0IHVwZGF0ZVBvbGxpbmcoKTtcbiAgICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ0FkYXB0ZXIgbm90IGZvdW5kJyB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfSk7XG5cbiAgKGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCB1cGRhdGVQb2xsaW5nKCk7XG4gIH0pKCk7XG59KTtcbiIsIi8vIHNyYy9pbmRleC50c1xudmFyIF9NYXRjaFBhdHRlcm4gPSBjbGFzcyB7XG4gIGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybikge1xuICAgIGlmIChtYXRjaFBhdHRlcm4gPT09IFwiPGFsbF91cmxzPlwiKSB7XG4gICAgICB0aGlzLmlzQWxsVXJscyA9IHRydWU7XG4gICAgICB0aGlzLnByb3RvY29sTWF0Y2hlcyA9IFsuLi5fTWF0Y2hQYXR0ZXJuLlBST1RPQ09MU107XG4gICAgICB0aGlzLmhvc3RuYW1lTWF0Y2ggPSBcIipcIjtcbiAgICAgIHRoaXMucGF0aG5hbWVNYXRjaCA9IFwiKlwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBncm91cHMgPSAvKC4qKTpcXC9cXC8oLio/KShcXC8uKikvLmV4ZWMobWF0Y2hQYXR0ZXJuKTtcbiAgICAgIGlmIChncm91cHMgPT0gbnVsbClcbiAgICAgICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBcIkluY29ycmVjdCBmb3JtYXRcIik7XG4gICAgICBjb25zdCBbXywgcHJvdG9jb2wsIGhvc3RuYW1lLCBwYXRobmFtZV0gPSBncm91cHM7XG4gICAgICB2YWxpZGF0ZVByb3RvY29sKG1hdGNoUGF0dGVybiwgcHJvdG9jb2wpO1xuICAgICAgdmFsaWRhdGVIb3N0bmFtZShtYXRjaFBhdHRlcm4sIGhvc3RuYW1lKTtcbiAgICAgIHZhbGlkYXRlUGF0aG5hbWUobWF0Y2hQYXR0ZXJuLCBwYXRobmFtZSk7XG4gICAgICB0aGlzLnByb3RvY29sTWF0Y2hlcyA9IHByb3RvY29sID09PSBcIipcIiA/IFtcImh0dHBcIiwgXCJodHRwc1wiXSA6IFtwcm90b2NvbF07XG4gICAgICB0aGlzLmhvc3RuYW1lTWF0Y2ggPSBob3N0bmFtZTtcbiAgICAgIHRoaXMucGF0aG5hbWVNYXRjaCA9IHBhdGhuYW1lO1xuICAgIH1cbiAgfVxuICBpbmNsdWRlcyh1cmwpIHtcbiAgICBpZiAodGhpcy5pc0FsbFVybHMpXG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB1ID0gdHlwZW9mIHVybCA9PT0gXCJzdHJpbmdcIiA/IG5ldyBVUkwodXJsKSA6IHVybCBpbnN0YW5jZW9mIExvY2F0aW9uID8gbmV3IFVSTCh1cmwuaHJlZikgOiB1cmw7XG4gICAgcmV0dXJuICEhdGhpcy5wcm90b2NvbE1hdGNoZXMuZmluZCgocHJvdG9jb2wpID0+IHtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJodHRwXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzSHR0cE1hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImh0dHBzXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzSHR0cHNNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJmaWxlXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzRmlsZU1hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImZ0cFwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0Z0cE1hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcInVyblwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc1Vybk1hdGNoKHUpO1xuICAgIH0pO1xuICB9XG4gIGlzSHR0cE1hdGNoKHVybCkge1xuICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cDpcIiAmJiB0aGlzLmlzSG9zdFBhdGhNYXRjaCh1cmwpO1xuICB9XG4gIGlzSHR0cHNNYXRjaCh1cmwpIHtcbiAgICByZXR1cm4gdXJsLnByb3RvY29sID09PSBcImh0dHBzOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG4gIH1cbiAgaXNIb3N0UGF0aE1hdGNoKHVybCkge1xuICAgIGlmICghdGhpcy5ob3N0bmFtZU1hdGNoIHx8ICF0aGlzLnBhdGhuYW1lTWF0Y2gpXG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgaG9zdG5hbWVNYXRjaFJlZ2V4cyA9IFtcbiAgICAgIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaCksXG4gICAgICB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLmhvc3RuYW1lTWF0Y2gucmVwbGFjZSgvXlxcKlxcLi8sIFwiXCIpKVxuICAgIF07XG4gICAgY29uc3QgcGF0aG5hbWVNYXRjaFJlZ2V4ID0gdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5wYXRobmFtZU1hdGNoKTtcbiAgICByZXR1cm4gISFob3N0bmFtZU1hdGNoUmVnZXhzLmZpbmQoKHJlZ2V4KSA9PiByZWdleC50ZXN0KHVybC5ob3N0bmFtZSkpICYmIHBhdGhuYW1lTWF0Y2hSZWdleC50ZXN0KHVybC5wYXRobmFtZSk7XG4gIH1cbiAgaXNGaWxlTWF0Y2godXJsKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IGZpbGU6Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGlzRnRwTWF0Y2godXJsKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IGZ0cDovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgaXNVcm5NYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogdXJuOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBjb252ZXJ0UGF0dGVyblRvUmVnZXgocGF0dGVybikge1xuICAgIGNvbnN0IGVzY2FwZWQgPSB0aGlzLmVzY2FwZUZvclJlZ2V4KHBhdHRlcm4pO1xuICAgIGNvbnN0IHN0YXJzUmVwbGFjZWQgPSBlc2NhcGVkLnJlcGxhY2UoL1xcXFxcXCovZywgXCIuKlwiKTtcbiAgICByZXR1cm4gUmVnRXhwKGBeJHtzdGFyc1JlcGxhY2VkfSRgKTtcbiAgfVxuICBlc2NhcGVGb3JSZWdleChzdHJpbmcpIHtcbiAgICByZXR1cm4gc3RyaW5nLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKTtcbiAgfVxufTtcbnZhciBNYXRjaFBhdHRlcm4gPSBfTWF0Y2hQYXR0ZXJuO1xuTWF0Y2hQYXR0ZXJuLlBST1RPQ09MUyA9IFtcImh0dHBcIiwgXCJodHRwc1wiLCBcImZpbGVcIiwgXCJmdHBcIiwgXCJ1cm5cIl07XG52YXIgSW52YWxpZE1hdGNoUGF0dGVybiA9IGNsYXNzIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtYXRjaFBhdHRlcm4sIHJlYXNvbikge1xuICAgIHN1cGVyKGBJbnZhbGlkIG1hdGNoIHBhdHRlcm4gXCIke21hdGNoUGF0dGVybn1cIjogJHtyZWFzb259YCk7XG4gIH1cbn07XG5mdW5jdGlvbiB2YWxpZGF0ZVByb3RvY29sKG1hdGNoUGF0dGVybiwgcHJvdG9jb2wpIHtcbiAgaWYgKCFNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmluY2x1ZGVzKHByb3RvY29sKSAmJiBwcm90b2NvbCAhPT0gXCIqXCIpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4oXG4gICAgICBtYXRjaFBhdHRlcm4sXG4gICAgICBgJHtwcm90b2NvbH0gbm90IGEgdmFsaWQgcHJvdG9jb2wgKCR7TWF0Y2hQYXR0ZXJuLlBST1RPQ09MUy5qb2luKFwiLCBcIil9KWBcbiAgICApO1xufVxuZnVuY3Rpb24gdmFsaWRhdGVIb3N0bmFtZShtYXRjaFBhdHRlcm4sIGhvc3RuYW1lKSB7XG4gIGlmIChob3N0bmFtZS5pbmNsdWRlcyhcIjpcIikpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBgSG9zdG5hbWUgY2Fubm90IGluY2x1ZGUgYSBwb3J0YCk7XG4gIGlmIChob3N0bmFtZS5pbmNsdWRlcyhcIipcIikgJiYgaG9zdG5hbWUubGVuZ3RoID4gMSAmJiAhaG9zdG5hbWUuc3RhcnRzV2l0aChcIiouXCIpKVxuICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKFxuICAgICAgbWF0Y2hQYXR0ZXJuLFxuICAgICAgYElmIHVzaW5nIGEgd2lsZGNhcmQgKCopLCBpdCBtdXN0IGdvIGF0IHRoZSBzdGFydCBvZiB0aGUgaG9zdG5hbWVgXG4gICAgKTtcbn1cbmZ1bmN0aW9uIHZhbGlkYXRlUGF0aG5hbWUobWF0Y2hQYXR0ZXJuLCBwYXRobmFtZSkge1xuICByZXR1cm47XG59XG5leHBvcnQge1xuICBJbnZhbGlkTWF0Y2hQYXR0ZXJuLFxuICBNYXRjaFBhdHRlcm5cbn07XG4iXSwibmFtZXMiOlsiYnJvd3NlciIsInJlc3VsdCJdLCJtYXBwaW5ncyI6Ijs7QUFDQSxXQUFTLGlCQUFpQixLQUFLO0FBQzlCLFFBQUksT0FBTyxRQUFRLE9BQU8sUUFBUSxXQUFZLFFBQU8sRUFBRSxNQUFNLElBQUc7QUFDaEUsV0FBTztBQUFBLEVBQ1I7QUNITyxRQUFNQSxZQUFVLFdBQVcsU0FBUyxTQUFTLEtBQ2hELFdBQVcsVUFDWCxXQUFXO0FDV2YsUUFBTSxVQUFVO0FDQ2hCLFFBQUEsV0FBQTtBQUFBLElBQW9DLFdBQUE7QUFBQSxJQUN2QixlQUFBO0FBQUEsSUFDSSx1QkFBQTtBQUFBLElBQ1EsbUJBQUEsQ0FBQTtBQUFBLElBQ0gsY0FBQSxDQUFBO0FBQUEsSUFDTCxVQUFBLENBQUE7QUFBQSxFQUVqQjtBQUVPLFFBQUEsVUFBQTtBQUFBLElBQWdCLE1BQUEsSUFBQSxLQUFBO0FBRW5CLFlBQUFDLFVBQUEsTUFBQSxRQUFBLFFBQUEsTUFBQSxJQUFBLEdBQUE7QUFDQSxhQUFBQSxRQUFBLEdBQUEsS0FBQSxTQUFBLEdBQUE7QUFBQSxJQUFtQztBQUFBLElBQ3JDLE1BQUEsSUFBQSxLQUFBLE9BQUE7QUFNRSxZQUFBLFFBQUEsUUFBQSxNQUFBLElBQUEsRUFBQSxDQUFBLEdBQUEsR0FBQSxPQUFBO0FBQUEsSUFBZ0Q7QUFBQSxJQUNsRCxNQUFBLFNBQUE7QUFHRSxZQUFBQSxVQUFBLE1BQUEsUUFBQSxRQUFBLE1BQUEsSUFBQSxPQUFBLEtBQUEsUUFBQSxDQUFBO0FBQ0EsYUFBQTtBQUFBLFFBQU8sR0FBQTtBQUFBLFFBQ0YsR0FBQUE7QUFBQSxNQUNBO0FBQUEsSUFDTDtBQUFBLElBQ0YsTUFBQSxZQUFBLFVBQUE7QUFHRSxZQUFBLFFBQUEsUUFBQSxNQUFBLElBQUEsUUFBQTtBQUFBLElBQXdDO0FBQUEsSUFDMUM7QUFBQSxFQUdGO0FBRUEsaUJBQUEsY0FBQTtBQUNF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
