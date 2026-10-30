(function (global) {
  async function handleMessage(message, sender) {
    const isSettings = sender?.id === chrome.runtime.id && sender?.url === chrome.runtime.getURL("options.html");
    if (message?.action !== "addXhsRecord" && !isSettings) return {success: false, error: "此操作仅允许在设置页执行"};
    if (message?.action === "addXhsRecord" && !(sender?.id === chrome.runtime.id && /^https:\/\/([a-z0-9-]+\.)*xiaohongshu\.com\//i.test(sender?.url || ""))) return {success: false, error: "采集来源无效"};
    const integrity = await global.DahuojiangBrandGuard?.requireIntegrity();
    if (!integrity?.success) return {success: false, error: integrity?.error || "插件完整性检查未通过，请重新获取生财专属安装包。"};
    switch (message?.action) {
      case "getSettings":
        return global.XhhSettingsService.getSettings();
      case "saveAndConnect":
        return global.XhhSettingsService.saveAndConnect(message.settings);
      case "testFeishuWrite":
        return global.XhhRecordService.testFeishuWrite();
      case "addXhsRecord": {
        const result = await global.XhhRecordService.addXhsRecord(message.record);
        // Never return local credentials to the page-facing content script.
        const {success, error, recordId, configName, imageCount, imageFailureCount, firstImageFailure} = result;
        return {success, error, recordId, configName, imageCount, imageFailureCount, firstImageFailure};
      }
      default:
        return {
          success: false,
          error: "未知操作。"
        };
    }
  }

  global.XhhMessageController = {
    handleMessage
  };
})(self);
