(function (global) {
  const PROFILE_LOAD_TIMEOUT_MS = 7000;
  const PROFILE_READY_RETRY_INTERVAL_MS = 400;
  const PROFILE_READY_MAX_ATTEMPTS = 10;
  const PROFILE_CACHE_TTL_MS = 30 * 60 * 1000;
  const profileMetricsCache = new Map();

  function sleep(ms) {
    return new Promise((resolve) => {
      global.setTimeout(resolve, ms);
    });
  }

  function isXhsProfileUrl(url) {
    try {
      const parsed = new URL(url);
      return /(^|\.)xiaohongshu\.com$/.test(parsed.hostname) &&
        parsed.pathname.includes("/user/profile/");
    } catch (error) {
      return false;
    }
  }

  function getRuntimeError() {
    try {
      return chrome.runtime.lastError;
    } catch (error) {
      return error;
    }
  }

  function createProfileTab(url) {
    return new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: false }, (tab) => {
        const error = getRuntimeError();
        if (error) {
          reject(new Error(error.message || "作者主页打开失败。"));
          return;
        }
        if (!tab?.id) {
          reject(new Error("作者主页打开失败。"));
          return;
        }
        resolve(tab);
      });
    });
  }

  function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
      let finished = false;

      function done() {
        if (finished) {
          return;
        }
        finished = true;
        chrome.tabs.onUpdated.removeListener(listener);
        global.clearTimeout(timer);
        resolve();
      }

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          done();
        }
      }

      const timer = global.setTimeout(done, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId, (tab) => {
        const error = getRuntimeError();
        if (!error && tab?.status === "complete") {
          done();
        }
      });
    });
  }

  function sendProfileExtractMessage(tabId, expectedAuthor) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, {
        action: "extractXhsProfileMetrics",
        expectedAuthor
      }, (response) => {
        const error = getRuntimeError();
        if (error) {
          resolve({
            success: false,
            error: error.message || "作者主页数据采集失败。"
          });
          return;
        }
        resolve(response || {
          success: false,
          error: "作者主页没有返回数据。"
        });
      });
    });
  }

  function normalizeAuthorName(name) {
    return String(name || "")
      .replace(/\s+/g, "")
      .replace(/-小红书.*/, "")
      .trim();
  }

  function hasAuthorMismatch(expectedAuthor, profileAuthor) {
    const expected = normalizeAuthorName(expectedAuthor);
    const actual = normalizeAuthorName(profileAuthor);
    if (!expected || !actual) {
      return false;
    }
    return !expected.includes(actual) && !actual.includes(expected);
  }

  function cloneMetrics(metrics) {
    return {
      author: metrics.author || "",
      authorLink: metrics.authorLink || "",
      followers: metrics.followers || "",
      totalLikes: metrics.totalLikes || ""
    };
  }

  function hasCompleteProfileMetrics(metrics) {
    return Boolean(metrics?.followers && metrics?.totalLikes);
  }

  function getCachedMetrics(authorLink, expectedAuthor) {
    const cached = profileMetricsCache.get(authorLink);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.cachedAt > PROFILE_CACHE_TTL_MS) {
      profileMetricsCache.delete(authorLink);
      return null;
    }
    if (hasAuthorMismatch(expectedAuthor, cached.metrics.author)) {
      return null;
    }
    return cloneMetrics(cached.metrics);
  }

  function setCachedMetrics(authorLink, metrics) {
    if (!authorLink || !hasCompleteProfileMetrics(metrics)) {
      return;
    }
    profileMetricsCache.set(authorLink, {
      cachedAt: Date.now(),
      metrics: cloneMetrics({
        ...metrics,
        authorLink: metrics.authorLink || authorLink
      })
    });
  }

  async function extractProfileMetricsWithRetry(tabId, expectedAuthor) {
    let response = null;
    for (let attempt = 0; attempt < PROFILE_READY_MAX_ATTEMPTS; attempt += 1) {
      response = await sendProfileExtractMessage(tabId, expectedAuthor);
      if (response?.success && hasCompleteProfileMetrics(response.metrics)) {
        return response;
      }
      if (attempt < PROFILE_READY_MAX_ATTEMPTS - 1) {
        await sleep(PROFILE_READY_RETRY_INTERVAL_MS);
      }
    }
    return response;
  }

  function closeProfileTab(tabId) {
    if (!tabId) {
      return;
    }
    chrome.tabs.remove(tabId, () => {
      void getRuntimeError();
    });
  }

  async function collectAuthorMetrics(authorLink, expectedAuthor) {
    if (!global.chrome?.tabs || !isXhsProfileUrl(authorLink)) {
      return {};
    }

    const cachedMetrics = getCachedMetrics(authorLink, expectedAuthor);
    if (cachedMetrics) {
      return cachedMetrics;
    }

    let tabId = null;
    try {
      const tab = await createProfileTab(authorLink);
      tabId = tab.id;
      await waitForTabComplete(tabId, PROFILE_LOAD_TIMEOUT_MS);

      const response = await extractProfileMetricsWithRetry(tabId, expectedAuthor);
      if (!response?.success || !response.metrics) {
        return {};
      }
      if (!hasCompleteProfileMetrics(response.metrics)) {
        return {};
      }
      if (hasAuthorMismatch(expectedAuthor, response.metrics.author)) {
        return {};
      }

      const metrics = {
        author: response.metrics.author || "",
        authorLink: response.metrics.authorLink || authorLink,
        followers: response.metrics.followers || "",
        totalLikes: response.metrics.totalLikes || ""
      };
      setCachedMetrics(authorLink, metrics);
      return metrics;
    } catch (error) {
      return {};
    } finally {
      closeProfileTab(tabId);
    }
  }

  global.XhhProfileService = {
    collectAuthorMetrics
  };
})(self);
