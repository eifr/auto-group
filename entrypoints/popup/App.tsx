import { useState, useEffect } from 'react';
import './style.css';

type Tab = 'installed' | 'store' | 'settings';

interface AdapterStatus {
  name: string;
  groupTitle: string;
  description: string;
  enabled: boolean;
  pollingInterval?: number;
  config: Record<string, any>;
}

interface Status {
  fetchMode: 'together' | 'individual';
  masterEnabled: boolean;
  globalPollingInterval: number;
  installedAdapters: Record<string, AdapterStatus>;
  installedList: string[];
}

const availableAdaptersList = [
  {
    name: 'github',
    groupTitle: '🔄 GitHub Reviews',
    description: 'Track PRs where you are a requested reviewer',
  },
];

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('installed');
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
      setStatus(response);
    } catch (err) {
      console.error('Failed to load status:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async (adapterName: string) => {
    setSaving(true);
    try {
      await browser.runtime.sendMessage({ type: 'INSTALL_ADAPTER', adapterName });
      await loadStatus();
      setSuccess('Adapter installed!');
    } catch (err) {
      setError('Failed to install adapter');
    } finally {
      setSaving(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  const handleUninstall = async (adapterName: string) => {
    setSaving(true);
    try {
      await browser.runtime.sendMessage({ type: 'UNINSTALL_ADAPTER', adapterName });
      await loadStatus();
      setSuccess('Adapter uninstalled');
    } catch (err) {
      setError('Failed to uninstall adapter');
    } finally {
      setSaving(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  const handleToggleAdapter = async (adapterName: string, enabled: boolean) => {
    try {
      await browser.runtime.sendMessage({ 
        type: 'UPDATE_ADAPTER_CONFIG', 
        adapterName, 
        enabled 
      });
      await loadStatus();
    } catch (err) {
      setError('Failed to update adapter');
    }
  };

  const handleAdapterIntervalChange = async (adapterName: string, interval: number) => {
    try {
      await browser.runtime.sendMessage({ 
        type: 'UPDATE_ADAPTER_CONFIG', 
        adapterName, 
        pollingInterval: interval 
      });
      await loadStatus();
    } catch (err) {
      setError('Failed to update interval');
    }
  };

  const handleSaveToken = async (adapterName: string, token: string) => {
    try {
      await browser.runtime.sendMessage({ 
        type: 'UPDATE_ADAPTER_CONFIG', 
        adapterName, 
        config: { token } 
      });
      await loadStatus();
      setSuccess('Token saved!');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError('Failed to save token');
    }
  };

  const handleSettingsUpdate = async (fetchMode: 'together' | 'individual', interval: number) => {
    setSaving(true);
    try {
      await browser.runtime.sendMessage({ 
        type: 'UPDATE_SETTINGS', 
        fetchMode, 
        globalPollingInterval: interval 
      });
      await loadStatus();
      setSuccess('Settings saved!');
    } catch (err) {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  const handleSyncNow = async () => {
    setSaving(true);
    try {
      await browser.runtime.sendMessage({ type: 'SYNC_NOW' });
      setSuccess('Sync triggered!');
      await loadStatus();
    } catch (err) {
      setError('Failed to sync');
    } finally {
      setSaving(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  if (loading || !status) {
    return (
      <div className="container">
        <div className="card">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="tabs">
        <button 
          className={`tab ${activeTab === 'installed' ? 'active' : ''}`}
          onClick={() => setActiveTab('installed')}
        >
          Installed
        </button>
        <button 
          className={`tab ${activeTab === 'store' ? 'active' : ''}`}
          onClick={() => setActiveTab('store')}
        >
          Store
        </button>
        <button 
          className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      {activeTab === 'installed' && (
        <InstalledTab 
          status={status} 
          onToggle={handleToggleAdapter}
          onIntervalChange={handleAdapterIntervalChange}
          onSaveToken={handleSaveToken}
          onUninstall={handleUninstall}
          onSyncNow={handleSyncNow}
          saving={saving}
        />
      )}

      {activeTab === 'store' && (
        <StoreTab 
          installedAdapters={status.installedList}
          onInstall={handleInstall}
          saving={saving}
        />
      )}

      {activeTab === 'settings' && (
        <SettingsTab 
          fetchMode={status.fetchMode}
          globalPollingInterval={status.globalPollingInterval}
          onUpdate={handleSettingsUpdate}
        />
      )}
    </div>
  );
}

function InstalledTab({ 
  status, 
  onToggle, 
  onIntervalChange, 
  onSaveToken,
  onUninstall,
  onSyncNow,
  saving 
}: {
  status: Status;
  onToggle: (name: string, enabled: boolean) => void;
  onIntervalChange: (name: string, interval: number) => void;
  onSaveToken: (name: string, token: string) => void;
  onUninstall: (name: string) => void;
  onSyncNow: () => void;
  saving: boolean;
}) {
  const [tokenInput, setTokenInput] = useState<Record<string, string>>({});

  const installedList = Object.keys(status.installedAdapters);

  if (installedList.length === 0) {
    return (
      <div className="card">
        <div className="empty-state">
          <p>No adapters installed</p>
          <p className="info-text">Go to Store to install adapters</p>
        </div>
      </div>
    );
  }

  return (
    <div className="adapter-list">
      {installedList.map(name => {
        const adapter = status.installedAdapters[name];
        return (
          <div key={name} className="card adapter-card">
            <h3>{adapter.groupTitle}</h3>

            {status.fetchMode === 'individual' && (
              <div className="form-group">
                <label>Polling Interval</label>
                <select
                  value={adapter.pollingInterval || 5}
                  onChange={(e) => onIntervalChange(name, Number(e.target.value))}
                >
                  <option value={1}>Every 1 minute</option>
                  <option value={5}>Every 5 minutes</option>
                  <option value={10}>Every 10 minutes</option>
                  <option value={30}>Every 30 minutes</option>
                </select>
              </div>
            )}

            {name === 'github' && (
              <div className="form-group">
                <label>GitHub Token</label>
                {adapter.config?.token ? (
                  <div className="token-configured">
                    <span className="token-badge">✓ Token configured</span>
                    <button 
                      className="btn btn-secondary"
                      onClick={() => {
                        onSaveToken(name, '');
                      }}
                    >
                      Remove Token
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="password"
                      placeholder="ghp_xxxxxxxxxxxx"
                      value={tokenInput[name] || ''}
                      onChange={(e) => setTokenInput({ ...tokenInput, [name]: e.target.value })}
                    />
                    <button 
                      className="btn btn-primary"
                      onClick={() => {
                        if (tokenInput[name]) {
                          onSaveToken(name, tokenInput[name]);
                        }
                      }}
                    >
                      Save Token
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="actions">
              <button 
                className="btn btn-secondary"
                onClick={onSyncNow}
                disabled={saving}
              >
                Sync Now
              </button>
              <button 
                className="btn btn-danger"
                onClick={() => onUninstall(name)}
                disabled={saving}
              >
                Uninstall
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StoreTab({ 
  installedAdapters, 
  onInstall, 
  saving 
}: {
  installedAdapters: string[];
  onInstall: (name: string) => void;
  saving: boolean;
}) {
  const availableToInstall = availableAdaptersList.filter(
    a => !installedAdapters.includes(a.name)
  );

  return (
    <div className="adapter-list">
      {availableToInstall.map(adapter => (
        <div key={adapter.name} className="card adapter-card">
          <div className="adapter-header">
            <div className="adapter-info">
              <h3>{adapter.groupTitle}</h3>
              <p className="info-text">{adapter.description}</p>
            </div>
          </div>
          <button 
            className="btn btn-primary"
            onClick={() => onInstall(adapter.name)}
            disabled={saving}
          >
            Install
          </button>
        </div>
      ))}
      {availableToInstall.length === 0 && (
        <div className="card">
          <p className="empty-state">All available adapters are installed!</p>
        </div>
      )}
    </div>
  );
}

function SettingsTab({
  fetchMode,
  globalPollingInterval,
  onUpdate,
}: {
  fetchMode: 'together' | 'individual';
  globalPollingInterval: number;
  onUpdate: (mode: 'together' | 'individual', interval: number) => void;
}) {
  const [mode, setMode] = useState(fetchMode);
  const [interval, setInterval] = useState(globalPollingInterval);

  const handleModeChange = (newMode: 'together' | 'individual') => {
    setMode(newMode);
    onUpdate(newMode, interval);
  };

  const handleIntervalChange = (newInterval: number) => {
    setInterval(newInterval);
    onUpdate(mode, newInterval);
  };

  return (
    <div className="card">
      <h3 className="card-title">Fetch Mode</h3>
      
      <div className="form-group">
        <div className="mode-options">
          <label className={`mode-option ${mode === 'together' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="mode"
              value="together"
              checked={mode === 'together'}
              onChange={() => handleModeChange('together')}
            />
            <span>Run together</span>
            <p className="info-text">All adapters sync with a shared interval</p>
          </label>
          <label className={`mode-option ${mode === 'individual' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="mode"
              value="individual"
              checked={mode === 'individual'}
              onChange={() => handleModeChange('individual')}
            />
            <span>Run individually</span>
            <p className="info-text">Each adapter has its own polling interval</p>
          </label>
        </div>
      </div>

      {mode === 'together' && (
        <div className="form-group">
          <label>Global Polling Interval</label>
          <select
            value={interval}
            onChange={(e) => handleIntervalChange(Number(e.target.value))}
          >
            <option value={1}>Every 1 minute</option>
            <option value={5}>Every 5 minutes</option>
            <option value={10}>Every 10 minutes</option>
            <option value={30}>Every 30 minutes</option>
          </select>
        </div>
      )}
    </div>
  );
}

export default App;
