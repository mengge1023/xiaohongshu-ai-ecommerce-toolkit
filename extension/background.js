importScripts(
  "src/security/brand-key.js",
  "src/security/brand-guard.js",
  "src/utils/feishu-url.js",
  "src/utils/number.js",
  "src/repositories/feishu-link-repository.js",
  "src/repositories/storage-repository.js",
  "src/repositories/feishu-repository.js",
  "src/services/settings-service.js",
  "src/services/record-service.js",
  "src/controllers/message-controller.js"
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  self.XhhMessageController.handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        success: false,
        error: error?.message || "后台处理失败。"
      });
    });

  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Keep Feishu credentials inaccessible to content scripts.
chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});

// Retire the local learning-account session without contacting the server.
chrome.storage.local.remove("dahuojiang_session");
