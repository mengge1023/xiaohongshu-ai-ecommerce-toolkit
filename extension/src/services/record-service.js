(function (global) {
  let addRecordInProgress = false;

  function buildTestRecord() {
    const now = Date.now();
    return {
      title: "大火箭测试记录，可删除",
      author: "大火箭",
      authorLink: "https://www.xiaohongshu.com",
      followers: 0,
      likes: 0,
      collects: 0,
      comments: 0,
      shares: 0,
      content: "这是一条用于测试飞书写入的记录。",
      tags: ["大火箭", "测试"],
      link: "https://www.xiaohongshu.com",
      dateInMilliseconds: now,
      noteType: "图文",
      platform: "小红书",
      totalLikes: 0,
      allImageUrls: []
    };
  }

  function normalizeRecord(input) {
    const now = Date.now();
    return {
      title: input?.title || "未命名小红书笔记",
      author: input?.author || "未知作者",
      authorLink: input?.authorLink || "",
      followers: global.XhhNumber.parseMetric(input?.followers),
      likes: global.XhhNumber.parseMetric(input?.likes),
      collects: global.XhhNumber.parseMetric(input?.collects),
      comments: global.XhhNumber.parseMetric(input?.comments),
      shares: global.XhhNumber.parseMetric(input?.shares),
      content: input?.content || "",
      tags: Array.isArray(input?.tags) ? input.tags.filter(Boolean).slice(0, 20) : [],
      link: input?.link || "",
      dateInMilliseconds: input?.dateInMilliseconds || null,
      noteType: input?.noteType || "图文",
      platform: "小红书",
      totalLikes: global.XhhNumber.parseMetric(input?.totalLikes),
      allImageUrls: Array.isArray(input?.allImageUrls) ? input.allImageUrls.filter(Boolean) : []
    };
  }

  async function addXhsRecord(input) {
    if (addRecordInProgress) {
      return {
        success: false,
        error: "上一条笔记还在保存到飞书，请完成后再采集下一篇。"
      };
    }

    addRecordInProgress = true;
    try {
      const active = await global.XhhSettingsService.requireReadySettings();
      if (!active.success) {
        return active;
      }

      const record = normalizeRecord(input);
      const result = await global.XhhFeishuRepository.addRecord(record, active.settings);
      if (!result.success) {
        return result;
      }

      return {
        success: true,
        recordId: result.recordId,
        configName: active.settings.configName,
        imageCount: result.imageCount,
        imageFailureCount: result.imageFailureCount,
        firstImageFailure: result.firstImageFailure
      };
    } finally {
      addRecordInProgress = false;
    }
  }

  async function testFeishuWrite() {
    const active = await global.XhhSettingsService.requireReadySettings();
    if (!active.success) {
      return active;
    }

    const result = await global.XhhFeishuRepository.addRecord(buildTestRecord(), active.settings);
    if (!result.success) {
      return result;
    }

    return {
      success: true,
      recordId: result.recordId,
      configName: active.settings.configName
    };
  }

  global.XhhRecordService = {
    addXhsRecord,
    testFeishuWrite
  };
})(self);
