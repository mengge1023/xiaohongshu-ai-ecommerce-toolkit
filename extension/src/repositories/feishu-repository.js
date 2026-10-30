(function (global) {
  const MEDIA_UPLOAD_URL = "https://base-api.feishu.cn/open-apis/drive/v1/medias/upload_all";
  const JPEG_UPLOAD_QUALITY = 0.92;
  const MAX_NOTE_IMAGE_COUNT = 30;
  const RECORD_WRITE_RETRY_DELAYS_MS = [800, 1600, 3000];
  const RETRYABLE_RECORD_WRITE_CODES = new Set([1254607, 1255040]);
  const CURRENT_TEMPLATE_FIELD_ORDER = [
    "标题",
    "正文",
    "平台",
    "笔记类型",
    "封面",
    "所有图片",
    "标签",
    "点赞数",
    "收藏数",
    "评论数",
    "日期",
    "链接",
    "作者",
  ];

  function getRecordUrl(appToken, tableId) {
    return `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
  }

  function getTablesUrl(appToken) {
    return `https://base-api.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`;
  }

  function isDebugLoggingEnabled(settings) {
    return Boolean(settings?.debugLogging || global.XHH_DEBUG === true);
  }

  function debugLog(settings, label, payload) {
    if (!isDebugLoggingEnabled(settings)) {
      return;
    }
    global.console?.log?.(`[XHH_DEBUG] ${label}`, payload);
  }

  function sleep(milliseconds) {
    if (typeof setTimeout !== "function" || milliseconds <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function shouldRetryRecordWrite(response, payload) {
    const code = Number(payload?.code);
    return response.status === 504 || RETRYABLE_RECORD_WRITE_CODES.has(code);
  }

  function getRecordWriteError(response, payload) {
    const code = Number(payload?.code);
    if (code === 1254607) {
      return "飞书表格正在处理上一轮变更，请稍后重试（1254607）。";
    }
    if (code === 1255040 || response.status === 504) {
      return "飞书写入超时，请稍后重试。";
    }
    return payload?.code ? `${payload.code} ${payload.msg || ""}`.trim() : `飞书写入失败：${response.status}`;
  }

  function cleanFileName(name) {
    const base = (name || "dahuojiang").replace(/[\\/:*?"<>|]/g, "").slice(0, 40);
    return base || "dahuojiang";
  }

  function normalizeImageUrl(imageUrl) {
    let normalized = String(imageUrl || "")
      .replace(/\\u002F/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .trim();

    if (normalized.startsWith("//")) {
      normalized = `https:${normalized}`;
    }
    if (/^http:\/\/.*(xhscdn|xiaohongshu|sns-webpic|sns-img|ci\.)/i.test(normalized)) {
      normalized = normalized.replace(/^http:\/\//i, "https://");
    }

    return normalized;
  }

  function getImageDedupeKey(imageUrl) {
    const normalizedUrl = normalizeImageUrl(imageUrl);
    if (!normalizedUrl) {
      return "";
    }
    try {
      const parsed = new URL(normalizedUrl);
      if (/(xhscdn|sns-webpic|sns-img|ci\.xiaohongshu|xiaohongshu)/i.test(parsed.hostname)) {
        return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
      }
      parsed.hash = "";
      parsed.search = "";
      return parsed.href.toLowerCase();
    } catch (error) {
      return normalizedUrl.split(/[?#]/)[0].toLowerCase();
    }
  }

  function dedupeImageUrls(imageUrls) {
    const urls = [];
    const seen = new Set();
    (imageUrls || []).forEach((imageUrl) => {
      if (!imageUrl) {
        return;
      }
      const key = getImageDedupeKey(imageUrl);
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      urls.push(imageUrl);
    });
    return urls;
  }

  async function fetchImageBlob(imageUrl) {
    const normalizedUrl = normalizeImageUrl(imageUrl);
    const attempts = [
      {
        credentials: "omit",
        referrer: "https://www.xiaohongshu.com/"
      },
      {
        credentials: "omit"
      }
    ];
    let lastError = null;

    for (const options of attempts) {
      try {
        const response = await fetch(normalizedUrl, options);
        if (!response.ok) {
          lastError = new Error(`图片下载失败：${response.status}`);
          continue;
        }

        const blob = await response.blob();
        if (!blob.size) {
          lastError = new Error("图片下载失败：文件为空");
          continue;
        }
        return blob;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("图片下载失败。");
  }

  function shouldConvertToJpeg(blob) {
    return ["image/webp", "image/avif"].includes(blob?.type);
  }

  async function convertImageForUpload(blob) {
    if (!shouldConvertToJpeg(blob)) {
      return blob;
    }
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      return blob;
    }

    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) {
        return blob;
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);

      const converted = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: JPEG_UPLOAD_QUALITY
      });
      return converted?.size ? converted : blob;
    } catch (error) {
      return blob;
    } finally {
      bitmap?.close?.();
    }
  }

  function getImageExtension(blob, imageUrl) {
    const byMime = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif"
    };
    if (byMime[blob.type]) {
      return byMime[blob.type];
    }

    const match = String(imageUrl || "").split("?")[0].match(/\.([a-z0-9]{3,4})$/i);
    const ext = match?.[1]?.toLowerCase();
    return /^(jpg|jpeg|png|webp|gif|avif)$/.test(ext) ? (ext === "jpeg" ? "jpg" : ext) : "jpg";
  }

  async function uploadImage(imageUrl, index, title, appToken, tat) {
    const sourceBlob = await fetchImageBlob(imageUrl);
    const blob = await convertImageForUpload(sourceBlob);
    const extension = getImageExtension(blob, imageUrl);
    const fileName = `${cleanFileName(title)}_${index + 1}.${extension}`;
    const formData = new FormData();
    formData.append("file_name", fileName);
    formData.append("parent_type", "bitable_file");
    formData.append("parent_node", appToken);
    formData.append("size", String(blob.size));
    formData.append("file", blob, fileName);

    const response = await fetch(MEDIA_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tat}`
      },
      body: formData
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0 || !payload?.data?.file_token) {
      throw new Error(payload?.msg || "图片上传飞书失败。");
    }

    return {
      file_token: payload.data.file_token
    };
  }

  async function uploadImages(imageUrls, title, appToken, tat) {
    const tokens = [];
    const failures = [];
    const uniqueUrls = dedupeImageUrls(Array.from(new Set((imageUrls || []).filter(Boolean)))).slice(0, MAX_NOTE_IMAGE_COUNT);
    const results = new Array(uniqueUrls.length);
    let nextIndex = 0;

    async function uploadWorker() {
      while (nextIndex < uniqueUrls.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await uploadImage(uniqueUrls[index], index, title, appToken, tat);
        } catch (error) {
          failures.push(error?.message || "图片上传失败。");
        }
      }
    }

    const workerCount = Math.min(3, uniqueUrls.length);
    await Promise.all(Array.from({ length: workerCount }, uploadWorker));
    results.forEach((token) => {
      if (token) {
        tokens.push(token);
      }
    });

    return {
      cover: tokens[0] || null,
      images: tokens,
      failureCount: failures.length,
      firstFailure: failures[0] || ""
    };
  }

  async function listTables(appToken, tat) {
    const response = await fetch(getTablesUrl(appToken), {
      headers: {
        Authorization: `Bearer ${tat}`
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0) {
      throw new Error(payload?.msg || "读取飞书数据表失败。");
    }
    return payload.data?.items || [];
  }

  async function resolveTableId(appToken, tableIdFromUrl, tat) {
    const tables = await listTables(appToken, tat);
    const exact = tables.find((table) => table.table_id === tableIdFromUrl);
    if (exact) {
      return exact.table_id;
    }

    if (!tableIdFromUrl) {
      const notes = tables.filter(table => table.name?.trim() === "笔记明细");
      if (notes.length === 1) return notes[0].table_id;
      if (tables.length === 1) return tables[0].table_id;
      const error = new Error("请选择要保存笔记的数据表，再点“保存并连接”。");
      error.tables = tables.map(table => ({id:table.table_id,name:table.name}));
      throw error;
    }
    throw new Error("链接中的数据表不存在或无权访问，请检查链接，不会写入其他表。");
  }

  function buildFields(record, uploads) {
    function linkValue(url, text) {
      if (!url) {
        return null;
      }
      return {
        link: url,
        text: text || url
      };
    }

    const rawFields = {
      "标题": record.title || "",
      "正文": record.content || "",
      "平台": record.platform || "小红书",
      "笔记类型": record.noteType || "图文",
      "封面": uploads.cover ? [uploads.cover] : null,
      "所有图片": uploads.images,
      "标签": record.tags || [],
      "点赞数": record.likes ?? null,
      "收藏数": record.collects ?? null,
      "评论数": record.comments ?? null,
      "日期": record.dateInMilliseconds || null,
      "链接": linkValue(record.link, record.link),
      "作者": record.author || "",
    };

    const fields = {};
    CURRENT_TEMPLATE_FIELD_ORDER.forEach((key) => {
      const value = rawFields[key];
      if (value === null || value === undefined || value === "") {
        return;
      }
      if (Array.isArray(value) && value.length === 0) {
        return;
      }
      fields[key] = value;
    });

    return fields;
  }

  async function addRecord(record, settings) {
    const tableId = settings.tableId?.startsWith("tbl")
      ? settings.tableId
      : await resolveTableId(settings.appToken, settings.tableId, settings.tat);
    const uploads = await uploadImages(record.allImageUrls, record.title, settings.appToken, settings.tat);
    if (uploads.failureCount > 0) {
      return {
        success: false,
        error: `图片上传不完整：成功 ${uploads.images.length} 张，失败 ${uploads.failureCount} 张，尚未保存笔记。${uploads.firstFailure || "请稍后重新采集。"}`
      };
    }
    const fields = buildFields(record, uploads);
    debugLog(settings, "record", record);
    debugLog(settings, "final fields", fields);

    let lastFailure = null;
    for (let attempt = 0; attempt <= RECORD_WRITE_RETRY_DELAYS_MS.length; attempt += 1) {
      const response = await fetch(getRecordUrl(settings.appToken, tableId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.tat}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ fields })
      });

      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.code === 0) {
        return {
          success: true,
          recordId: payload.data?.record?.record_id,
          imageCount: uploads.images.length,
          imageFailureCount: uploads.failureCount,
          firstImageFailure: uploads.firstFailure
        };
      }

      lastFailure = { response, payload };
      if (!shouldRetryRecordWrite(response, payload) || attempt === RECORD_WRITE_RETRY_DELAYS_MS.length) {
        break;
      }
      await sleep(RECORD_WRITE_RETRY_DELAYS_MS[attempt]);
    }

    return {
      success: false,
      error: getRecordWriteError(lastFailure.response, lastFailure.payload)
    };
  }

  global.XhhFeishuRepository = {
    resolveTableId,
    addRecord
  };
})(self);
