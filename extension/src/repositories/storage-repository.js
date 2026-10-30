(function (global) {
  const SETTINGS_KEY = "xhh_settings";

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, resolve);
    });
  }

  async function getSettings() {
    const result = await storageGet([SETTINGS_KEY]);
    return result[SETTINGS_KEY] || null;
  }

  async function saveSettings(settings) {
    await storageSet({ [SETTINGS_KEY]: settings });
    return settings;
  }

  global.XhhStorageRepository = {
    getSettings,
    saveSettings
  };
})(self);
