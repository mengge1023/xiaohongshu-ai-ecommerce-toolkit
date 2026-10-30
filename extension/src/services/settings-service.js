(function (global) {
  function getErrorMessage(error) {
    return String(error?.message || error || "未知错误").trim() || "未知错误";
  }

  function getFeishuConnectionError(error) {
    return `飞书连接失败：${getErrorMessage(error)}`;
  }

  function withPendingFeishuConnection(settings) {
    return {
      ...settings,
      feishuConnected: false,
      feishuConnectionStatus: "pending",
      feishuConnectionError: ""
    };
  }

  function withFailedFeishuConnection(settings, error) {
    return {
      ...settings,
      feishuConnected: false,
      feishuConnectionStatus: "error",
      feishuConnectionError: getErrorMessage(error)
    };
  }

  function withConnectedFeishu(settings, tableId) {
    return {
      ...settings,
      tableId,
      feishuConnected: true,
      feishuConnectionStatus: "connected",
      feishuConnectionError: ""
    };
  }

  function getStoredFeishuConnectionError(settings) {
    return `飞书连接失败：${settings.feishuConnectionError || "请重新检查多维表格链接和自定义授权码。"}`;
  }

  function validateSettings(input) {
    const settings = {
      configName: (input?.configName || "默认多维表格").trim(),
      feishuUrl: (input?.feishuUrl || "").trim(),
      tat: (input?.tat || "").trim()
    };

    if (!settings.feishuUrl) {
      return { success: false, error: "请填写多维表格链接。" };
    }
    if (!settings.tat) {
      return { success: false, error: "请填写多维表格授权码。" };
    }

    const parsed = global.XhhFeishuUrl.parseFeishuUrl(settings.feishuUrl);
    if (!parsed) {
      return { success: false, error: "多维表格链接格式不对，请复制飞书多维表格的分享链接。" };
    }

    return {
      success: true,
      settings: {
        ...settings,
        ...parsed,
        tableId: (input?.tableId || parsed.tableId || "").trim()
      }
    };
  }

  async function saveAndConnect(input) {
    const validation = validateSettings(input);
    if (!validation.success) {
      return validation;
    }

    try {
      const resolved = await global.XhhFeishuLinkRepository.resolve(validation.settings);
      validation.settings.appToken = resolved.appToken;
    } catch (error) { return {success:false, error:getErrorMessage(error)}; }
    const pendingSettings = withPendingFeishuConnection({...validation.settings});
    await global.XhhStorageRepository.saveSettings(pendingSettings);

    let tableId;
    try {
      tableId = await global.XhhFeishuRepository.resolveTableId(
        validation.settings.appToken,
        validation.settings.tableId,
        validation.settings.tat
      );
    } catch (error) {
      const failedSettings = withFailedFeishuConnection(pendingSettings, error);
      await global.XhhStorageRepository.saveSettings(failedSettings);
      return {
        success: false,

        status: "feishu_connection_error",
        error: getFeishuConnectionError(error),
        tables: error.tables,
        settings: failedSettings
      };
    }

    const settings = withConnectedFeishu(pendingSettings, tableId);
    await global.XhhStorageRepository.saveSettings(settings);

    return {
      success: true,
      settings
    };
  }

  async function getSettings() {
    const settings = await global.XhhStorageRepository.getSettings();
    return {success: true, settings: {...settings}};
  }

  async function requireReadySettings() {
    const settings = await global.XhhStorageRepository.getSettings();
    if (!settings?.tat) return {success: false, error: "请先配置飞书表格连接"};
    const configuredSettings = {...settings};

    if (configuredSettings.feishuConnected === false) {
      return {
        success: false,

        status: "feishu_connection_error",
        error: getStoredFeishuConnectionError(configuredSettings),
        settings: configuredSettings
      };
    }

    const parsed = global.XhhFeishuUrl.parseFeishuUrl(configuredSettings.feishuUrl);
    if (!parsed) {
      return {
        success: false,
        error: "多维表格链接格式不对，请重新配置。"
      };
    }

    parsed.appToken = configuredSettings.appToken || parsed.appToken;
    if (!parsed.appToken) return {success:false,error:"请在设置页重新连接飞书表格。"};
    let tableId = configuredSettings.tableId || parsed.tableId;
    if (!tableId || !tableId.startsWith("tbl")) {
      try {
        tableId = await global.XhhFeishuRepository.resolveTableId(parsed.appToken, parsed.tableId, configuredSettings.tat);
      } catch (error) {
        const failedSettings = withFailedFeishuConnection({
          ...configuredSettings,
          appToken: parsed.appToken
        }, error);
        await global.XhhStorageRepository.saveSettings(failedSettings);
        return {
          success: false,

          status: "feishu_connection_error",
          error: getStoredFeishuConnectionError(failedSettings),
          settings: failedSettings
        };
      }
      await global.XhhStorageRepository.saveSettings(withConnectedFeishu({
        ...configuredSettings,
        appToken: parsed.appToken
      }, tableId));
    }

    return {
      success: true,
      settings: withConnectedFeishu({
        ...configuredSettings,
        appToken: parsed.appToken
      }, tableId)
    };
  }

  global.XhhSettingsService = {
    saveAndConnect,
    getSettings,
    requireReadySettings
  };
})(self);
