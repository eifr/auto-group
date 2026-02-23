import { storage } from './Storage';

export const MASTER_ALARM_NAME = 'auto-groups-master';
export const ADAPTER_ALARM_PREFIX = 'auto-groups-';

export async function startMasterPolling(intervalMinutes: number): Promise<void> {
  await browser.alarms.create(MASTER_ALARM_NAME, {
    periodInMinutes: intervalMinutes,
  });
}

export async function stopMasterPolling(): Promise<void> {
  const alarm = await browser.alarms.get(MASTER_ALARM_NAME);
  if (alarm) {
    await browser.alarms.clear(MASTER_ALARM_NAME);
  }
}

export async function startAdapterPolling(adapterName: string, intervalMinutes: number): Promise<void> {
  await browser.alarms.create(`${ADAPTER_ALARM_PREFIX}${adapterName}`, {
    periodInMinutes: intervalMinutes,
  });
}

export async function stopAdapterPolling(adapterName: string): Promise<void> {
  const alarm = await browser.alarms.get(`${ADAPTER_ALARM_PREFIX}${adapterName}`);
  if (alarm) {
    await browser.alarms.clear(`${ADAPTER_ALARM_PREFIX}${adapterName}`);
  }
}

export async function updatePolling(): Promise<void> {
  const settings = await storage.getAll();
  
  await stopMasterPolling();
  
  const adapters = Object.keys(settings.installedAdapters);
  for (const adapter of adapters) {
    await stopAdapterPolling(adapter);
  }

  if (settings.fetchMode === 'together') {
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

export function onAlarm(callback: (alarm: browser.alarms.Alarm) => void): void {
  browser.alarms.onAlarm.addListener(callback);
}
