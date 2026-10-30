(function () {
  const form = document.getElementById("settingsForm");
  const testButton = document.getElementById("testButton");
  const openXhsButton = document.getElementById("openXhsButton");
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("statusText");
  const connectionBadge = document.getElementById("connectionBadge");
  const feishuState = document.getElementById("feishuState");
  const readyState = document.getElementById("readyState");
  const feishuStep = document.getElementById("feishuStep");
  const startStep = document.getElementById("startStep");
  const feishuIndex = document.getElementById("feishuIndex");
  const startIndex = document.getElementById("startIndex");
  const fields = {
    feishuUrl: document.getElementById("feishuUrl"),
    tat: document.getElementById("tat")
  };
  let extensionContextInvalid = false;

  function getManifest() {
    try {
      if (!chrome?.runtime?.id) {
        extensionContextInvalid = true;
        return null;
      }
      return chrome.runtime.getManifest();
    } catch (error) {
      if ((error?.message || "").includes("Extension context invalidated")) {
        extensionContextInvalid = true;
      }
      return null;
    }
  }

  function setStepState(element, text, type) {
    element.textContent = text;
    element.className = type ? `step-state ${type}` : "step-state";
  }

  function isFeishuConnected(settings) {
    if (!settings) {
      return false;
    }
    if (settings.feishuConnected === false) {
      return false;
    }
    return settings.feishuConnected === true || Boolean(settings.appToken && settings.tableId && settings.tat);
  }

  function getFeishuConnectionError(settings) {
    return settings?.feishuConnectionError || "";
  }

  function setConnectedState(settings) {
    const feishuConnected = isFeishuConnected(settings);
    const ready = feishuConnected;
    const hasConnectionError = Boolean(settings?.feishuConnectionError);
    connectionBadge.textContent = ready ? "可采集" : "待连接飞书";
    connectionBadge.dataset.state = ready ? "connected" : "warning";
    fields.feishuUrl.disabled = false;
    fields.tat.disabled = false;
    document.getElementById("saveButton").disabled = false;
    testButton.disabled = !ready;
    feishuIndex.textContent = "1";
    startIndex.textContent = "2";
    feishuStep.classList.toggle("is-complete", feishuConnected);
    feishuStep.classList.toggle("has-error", hasConnectionError);
    startStep.classList.toggle("is-complete", ready);
    setStepState(feishuState, feishuConnected ? "已连接" : hasConnectionError ? "连接失败" : "待配置", feishuConnected ? "is-ok" : hasConnectionError ? "is-error" : "");
    setStepState(readyState, ready ? "可采集" : "待设置", ready ? "is-ok" : "");
  }

  function setStatus(message, type) {
    statusText.textContent = message || "";
    statusEl.className = type ? `status ${type}` : "status";
    if (type === "error") {
      connectionBadge.dataset.state = "error";
    }
  }

  function getFormData() {
    return {
      configName: "默认多维表格",
      feishuUrl: fields.feishuUrl.value.trim(),
      tat: fields.tat.value.trim(),
      tableId: document.getElementById("tableChoice")?.value || ""
    };
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      if (extensionContextInvalid) {
        resolve({ success: false, error: "插件刚刚更新过，请重新打开设置页。" });
        return;
      }

      try {
        if (!chrome?.runtime?.id) {
          extensionContextInvalid = true;
          resolve({ success: false, error: "插件刚刚更新过，请重新打开设置页。" });
          return;
        }

        chrome.runtime.sendMessage(message, (response) => {
          let error = null;
          try {
            error = chrome.runtime.lastError;
          } catch (runtimeError) {
            const messageText = runtimeError?.message || "";
            if (messageText.includes("Extension context invalidated")) {
              extensionContextInvalid = true;
              resolve({ success: false, error: "插件刚刚更新过，请重新打开设置页。" });
              return;
            }
            resolve({
              success: false,
              error: messageText || "插件通信失败，请重新打开设置页。"
            });
            return;
          }

          if (error) {
            const messageText = error.message || "";
            if (messageText.includes("Extension context invalidated")) {
              extensionContextInvalid = true;
            }
            resolve({
              success: false,
              error: messageText.includes("Extension context invalidated")
                ? "插件刚刚更新过，请重新打开设置页。"
                : messageText
            });
            return;
          }
          resolve(response || { success: false, error: "没有收到后台响应" });
        });
      } catch (error) {
        const messageText = error?.message || "";
        if (messageText.includes("Extension context invalidated")) {
          extensionContextInvalid = true;
        }
        resolve({
          success: false,
          error: messageText.includes("Extension context invalidated")
            ? "插件刚刚更新过，请重新打开设置页。"
            : messageText || "插件通信失败，请重新打开设置页。"
        });
      }
    });
  }

  async function loadSettings() {
    const response = await sendMessage({ action: "getSettings" });
    if (!response.success || !response.settings) {
      setConnectedState(null);
      fields.feishuUrl.disabled = true;
      fields.tat.disabled = true;
      document.getElementById("saveButton").disabled = true;
      setStatus(response.error || "无法读取插件配置，请重新打开设置页。", "error");
      return;
    }
    const settings = response.settings;
    fields.feishuUrl.value = settings.feishuUrl || "";
    fields.tat.value = settings.tat || "";
    setConnectedState(settings);
    if (isFeishuConnected(settings)) {
      const name = settings.configName || "默认多维表格";
      setStatus(`已连接到 ${name}，可以打开小红书开始采集。`, "ok");
    } else {
      const error = getFeishuConnectionError(settings);
      if (error) setStatus(`飞书连接失败：${error}`, "error");
      else setStatus("请填写飞书表格链接和自定义授权码，再点击保存并连接。", "");
    }
  }

  fields.feishuUrl.addEventListener("input", () => {
    const select = document.getElementById("tableChoice");
    if (select) select.value = "";
    const field = document.getElementById("tableChoiceField");
    if (field) field.hidden = true;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("正在识别表格并连接…知识库链接首次识别最多等待 20 秒；如打开飞书登录页，请登录后回来重试。", "");
    const submitButton = document.getElementById("saveButton");
    submitButton.disabled = true;

    const response = await sendMessage({
      action: "saveAndConnect",
      settings: getFormData()
    });

    submitButton.disabled = false;
    if (response.success) {
      setConnectedState(response.settings);
      const name = response.settings?.configName || "默认多维表格";
      setStatus(`连接成功，已准备写入 ${name}。`, "ok");
    } else {
      if (response.tables?.length) {
        const select = document.getElementById("tableChoice");
        select.replaceChildren(new Option("请选择数据表", ""));
        for (const table of response.tables) select.add(new Option(table.name, table.id));
        document.getElementById("tableChoiceField").hidden = false;
      }
      if (response.settings) setConnectedState(response.settings);
      setStatus(response.error || "连接失败。", "error");
    }
  });

  testButton.addEventListener("click", async () => {
    setStatus("正在测试飞书写入...", "");
    testButton.disabled = true;
    const response = await sendMessage({ action: "testFeishuWrite" });
    testButton.disabled = false;
    if (response.success) {
      setStatus("连接正常，测试记录已写入飞书。", "ok");
    } else {
      if (response.settings) {
        setConnectedState(response.settings);
      }
      setStatus(response.error || "连接检查失败。", "error");
    }
  });

  openXhsButton.addEventListener("click", () => {
    try {
      if (!chrome?.runtime?.id) {
        extensionContextInvalid = true;
        setStatus("插件刚刚更新过，请重新打开设置页。", "error");
        return;
      }
      chrome.tabs.create({ url: "https://www.xiaohongshu.com" });
    } catch (error) {
      const messageText = error?.message || "";
      if (messageText.includes("Extension context invalidated")) {
        extensionContextInvalid = true;
      }
      setStatus(
        messageText.includes("Extension context invalidated")
          ? "插件刚刚更新过，请重新打开设置页。"
          : messageText || "无法打开小红书，请重新打开设置页。",
        "error"
      );
    }
  });

  loadSettings();
})();
