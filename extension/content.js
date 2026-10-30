(function () {
  const CONTENT_BUILD = "structured-note-v20261021-swiper-slide-order-15";
  const BUTTON_ID = "xhh-capture-button";
  const NOTICE_ID = "xhh-notice";
  const BADGE_ID = "xhh-ready-badge";
  const STYLE_ID = "xhh-style";
  const MAX_NOTE_IMAGE_COUNT = 30;
  let captureInProgress = false;
  let lastCaptureAt = 0;
  let extensionContextInvalid = false;
  let shareCaptureTimer = null;
  let noticeTimer = null;
  let cleanupObserver = null;
  let activeCaptureJob = null;
  const entryCoverCache = new Map();

  if (typeof globalThis.__XHH_CONTENT_CLEANUP__ === "function") {
    globalThis.__XHH_CONTENT_CLEANUP__();
  }

  function isDebugLoggingEnabled() {
    try {
      return globalThis.XHH_DEBUG === true || window.localStorage?.getItem("xhh_debug") === "1";
    } catch (error) {
      return globalThis.XHH_DEBUG === true;
    }
  }

  function debugLog(label, payload) {
    if (!isDebugLoggingEnabled()) {
      return;
    }
    console.log(`[XHH_DEBUG] ${label}`, payload);
  }

  function textOf(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function describeElementForDebug(element) {
    if (!element) {
      return null;
    }
    return {
      tagName: element.tagName || "",
      id: element.id || element.getAttribute?.("id") || "",
      className: String(element.className || "").slice(0, 160),
      textPreview: textOf(element).slice(0, 120)
    };
  }

  function firstText(selectors, root = document) {
    if (!root?.querySelector) {
      return "";
    }
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = textOf(element);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function findNoteRoot() {
    const anchor = document.querySelector("#detail-title") ||
      document.querySelector("#detail-desc") ||
      document.querySelector(".note-content") ||
      document.querySelector('[class*="note-detail"]');

    if (anchor) {
      let node = anchor;
      while (node && node !== document.body && node !== document.documentElement) {
        const className = String(node.className || "");
        const text = textOf(node);
        const hasMedia = hasDetailMediaSignal(node);
        const looksLikeDetail = /note|detail|modal|mask|container/i.test(className);
        const hasDetailAnchor = Boolean(node.querySelector("#detail-title, #detail-desc"));
        if (hasMedia && (looksLikeDetail || hasDetailAnchor) && text.length > 20) {
          return node;
        }
        node = node.parentElement;
      }
    }

    const candidates = [
      '[class*="note-detail"]',
      '[class*="noteDetail"]',
      '[class*="note-container"]',
      '[class*="noteContainer"]',
      '[class*="detail-container"]',
      '[class*="detailContainer"]',
      '[role="dialog"]'
    ];

    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element && (
        textOf(element).length > 0 ||
        element.querySelector("#detail-title, #detail-desc, img, video")
      )) {
        return element;
      }
    }

    return document.body;
  }

  function hasDetailMediaSignal(element) {
    if (!element?.querySelector) {
      return false;
    }
    if (element.querySelector("video, [class*=\"video\"], [class*=\"Video\"], [class*=\"player\"], [class*=\"Player\"], [class*=\"xgplayer\"], [style*=\"background-image\"]")) {
      return true;
    }
    return collectDomImageUrls(element).length > 0;
  }

  function metaContent(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.getAttribute("content") || "";
      if (value.trim()) {
        return value.trim();
      }
    }
    return "";
  }

  function getUrlFromElement(element) {
    if (!element) {
      return "";
    }
    const raw = element.getAttribute("href") || element.getAttribute("src") || "";
    if (!raw) {
      return "";
    }
    try {
      return new URL(raw, location.href).href;
    } catch (error) {
      return raw;
    }
  }

  function decodeLooseValue(value) {
    if (!value) {
      return "";
    }
    const raw = String(value)
      .replace(/\\u002F/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
    try {
      return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
    } catch (error) {
      return raw;
    }
  }

  function getSrcsetUrl(srcset) {
    if (!srcset) {
      return "";
    }
    const candidates = srcset.split(",")
      .map((item) => item.trim().split(/\s+/)[0])
      .filter(Boolean);
    return candidates[candidates.length - 1] || "";
  }

  function getScriptSource(rootDocument = document) {
    return Array.from(rootDocument.querySelectorAll("script"))
      .map((script) => script.textContent || "")
      .filter(Boolean)
      .join("\n");
  }

  function extractBalancedObject(source, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return source.slice(startIndex, index + 1);
        }
      }
    }

    return "";
  }

  function parseJsonText(text) {
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function matchEmptyCollectionConstructor(text, index, normalized) {
    if (!text.startsWith("new", index) || !/[:,\[]\s*$/.test(normalized)) {
      return null;
    }
    const match = text.slice(index).match(
      /^new\s+(Map|WeakMap|Set|WeakSet)\s*\(\s*(?:\[\s*\])?\s*\)/
    );
    if (!match || !/^\s*[,}\]]/.test(text.slice(index + match[0].length))) {
      return null;
    }
    return {
      length: match[0].length,
      replacement: /Set$/.test(match[1]) ? "[]" : "{}"
    };
  }

  // XHS serializes missing values as bare undefined and empty collection
  // constructors in __INITIAL_STATE__. Normalize only value tokens outside
  // strings; reject non-empty constructors and never execute page scripts.
  function parseSerializedState(text) {
    let normalized = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        normalized += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      const emptyCollection = matchEmptyCollectionConstructor(text, index, normalized);
      if (
        text.startsWith("undefined", index) &&
        /[:,\[]\s*$/.test(normalized) &&
        /^\s*[,}\]]/.test(text.slice(index + 9))
      ) {
        normalized += "null";
        index += 8;
      } else if (emptyCollection) {
        normalized += emptyCollection.replacement;
        index += emptyCollection.length - 1;
      } else {
        normalized += char;
      }
    }
    return parseJsonText(normalized);
  }

  function parseScriptJsonPayloads(rootDocument = document) {
    const payloads = [];
    const scripts = Array.from(rootDocument.querySelectorAll("script"));

    scripts.forEach((script) => {
      const text = script.textContent || "";
      const direct = parseJsonText(text.trim());
      if (direct) {
        payloads.push(direct);
      }

      const objectStarts = [
        text.indexOf("window.__INITIAL_STATE__"),
        text.indexOf("__INITIAL_STATE__"),
        text.indexOf("__NEXT_DATA__"),
        text.indexOf("__APOLLO_STATE__")
      ].filter((index) => index >= 0);

      objectStarts.forEach((markerIndex) => {
        const braceIndex = text.indexOf("{", markerIndex);
        if (braceIndex < 0) {
          return;
        }
        const objectText = extractBalancedObject(text, braceIndex);
        const parsed = parseSerializedState(objectText);
        if (parsed) {
          payloads.push(parsed);
        }
      });
    });

    return payloads;
  }

  function walkJson(value, visitor, path = []) {
    if (!value || typeof value !== "object") {
      return;
    }
    visitor(value, path);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkJson(item, visitor, path.concat(index)));
      return;
    }
    Object.keys(value).forEach((key) => walkJson(value[key], visitor, path.concat(key)));
  }

  function valueByPath(source, path) {
    return path.reduce((current, key) => current?.[key], source);
  }

  function objectHasNoteId(object, noteId) {
    if (!noteId || !object || typeof object !== "object") {
      return false;
    }
    const idKeys = ["noteId", "note_id", "id", "note_id_str", "noteIdStr"];
    return idKeys.some((key) => String(object[key] || "") === noteId);
  }

  function pathContainsNoteId(path, noteId) {
    return Boolean(noteId && Array.isArray(path) && path.some((key) => String(key) === noteId));
  }

  function objectHasDifferentNoteId(object, noteId) {
    if (!noteId || !object || typeof object !== "object") {
      return false;
    }
    const idKeys = ["noteId", "note_id", "note_id_str", "noteIdStr"];
    return idKeys.some((key) => {
      const value = object[key];
      return value !== undefined && value !== null && value !== "" && String(value) !== noteId;
    });
  }

  function extractNoteIdFromUrl(url) {
    const match = String(url || "").match(/\/(?:explore|search_result|red_video|discovery\/item)\/([A-Za-z0-9_-]+)/);
    return match?.[1] || "";
  }

  function rememberEntryCover(noteId, urls, source = "entry-card") {
    if (!noteId) {
      return;
    }
    const imageUrls = dedupeImageUrls((urls || [])
      .map(normalizeUrl)
      .filter(isLikelyContentImageUrl));
    if (imageUrls.length === 0) {
      return;
    }
    entryCoverCache.set(noteId, {
      urls: imageUrls.slice(0, 3),
      source,
      time: Date.now()
    });
    if (entryCoverCache.size > 60) {
      const oldestKey = entryCoverCache.keys().next().value;
      entryCoverCache.delete(oldestKey);
    }
  }

  function getRememberedEntryCoverUrls(noteId) {
    const entry = entryCoverCache.get(noteId);
    if (!entry) {
      return [];
    }
    if (Date.now() - entry.time > 30 * 60 * 1000) {
      entryCoverCache.delete(noteId);
      return [];
    }
    return entry.urls || [];
  }

  function extractEntryCoverUrlsFromCard(card) {
    if (!card?.querySelectorAll) {
      return [];
    }
    const urls = [];
    const mediaScope = card.querySelector?.(
      '[class*="cover"], [class*="Cover"], [class*="image"], [class*="Image"], [class*="photo"], [class*="Photo"], [class*="media"], [class*="Media"]'
    ) || card;
    Array.from(mediaScope.querySelectorAll("img, [style*='background-image']")).forEach((node) => {
      const url = node.tagName === "IMG" ? getImageUrl(node) : getBackgroundImageUrl(node);
      if (url) {
        urls.push(url);
      }
    });
    const backgroundUrl = getBackgroundImageUrl(mediaScope);
    if (backgroundUrl) {
      urls.unshift(backgroundUrl);
    }
    return dedupeImageUrls(urls);
  }

  function rememberEntryCoverFromClick(event) {
    const target = event?.target;
    if (!target?.closest) {
      return;
    }
    const link = target.closest('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/red_video/"], a[href*="/discovery/item/"]');
    const href = getUrlFromElement(link);
    const noteId = extractNoteIdFromUrl(href);
    if (!noteId) {
      return;
    }
    const card = link.closest?.(
      'section, article, li, [class*="note-item"], [class*="NoteItem"], [class*="feed"], [class*="Feed"], [class*="card"], [class*="Card"]'
    ) || link;
    rememberEntryCover(noteId, extractEntryCoverUrlsFromCard(card), "entry-click-card");
  }

  function elementBelongsToDifferentNote(element, noteId) {
    if (!element?.closest || !noteId) {
      return false;
    }
    const link = element.closest('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/red_video/"], a[href*="/discovery/item/"]');
    if (!link) {
      return false;
    }
    const linkedNoteId = extractNoteIdFromUrl(getUrlFromElement(link));
    return Boolean(linkedNoteId && linkedNoteId !== noteId);
  }

  function elementHasRelatedCardAncestor(element, boundary) {
    let node = element?.parentElement || null;
    while (node && node !== boundary && node !== document.body && node !== document.documentElement) {
      const className = String(node.className || "");
      if (/(recommend|related|feed|feeds|waterfall|card|comment|reply|suggest|author|avatar|profile|user)/i.test(className)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function selectKnownNoteObject(entry, noteId) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const candidates = [
      entry.note,
      entry.noteCard,
      entry.note_card,
      entry.noteDetail,
      entry.note_detail,
      entry.card,
      entry
    ];

    return candidates.find((candidate) => (
      isPlainObject(candidate) &&
      !objectHasDifferentNoteId(candidate, noteId) &&
      (
        objectHasNoteId(candidate, noteId) ||
        hasAnyOwnValue(candidate, ["type", "imageList", "image_list", "interactInfo", "interact_info", "video"])
      )
    )) || null;
  }

  function findKnownNoteDetailContext(payload, noteId) {
    if (!payload || typeof payload !== "object" || !noteId) {
      return null;
    }

    let found = null;
    const mapKeys = [
      "noteDetailMap",
      "note_detail_map",
      "noteMap",
      "note_map",
      "detailMap",
      "detail_map"
    ];

    walkJson(payload, (object, path) => {
      if (found || !isPlainObject(object)) {
        return;
      }

      for (const key of mapKeys) {
        const map = object[key];
        if (!isPlainObject(map) || !isPlainObject(map[noteId])) {
          continue;
        }

        const noteObject = selectKnownNoteObject(map[noteId], noteId);
        if (noteObject) {
          found = {
            object: noteObject,
            parent: map[noteId],
            payload,
            path: path.concat(key, noteId),
            source: key
          };
          return;
        }
      }
    });

    return found;
  }

  function findParsedNoteContext(noteId, rootDocument = document) {
    const payloads = parseScriptJsonPayloads(rootDocument);
    for (const payload of payloads) {
      const known = findKnownNoteDetailContext(payload, noteId);
      if (known) {
        return known;
      }
    }

    let best = null;
    let bestScore = -1;

    payloads.forEach((payload) => {
      walkJson(payload, (object, path) => {
        const hasExplicitNoteId = objectHasNoteId(object, noteId);
        if (!hasExplicitNoteId && !pathContainsNoteId(path, noteId)) {
          return;
        }
        const block = JSON.stringify(object);
        const score = scoreNoteBlock(block) + (hasExplicitNoteId ? 2 : 1);
        if (score > bestScore) {
          bestScore = score;
          best = { object, path, payload };
        }
      });
    });

    if (!best) {
      return null;
    }

    const parentPath = best.path.slice(0, -1);
    return {
      object: best.object,
      parent: valueByPath(best.payload, parentPath) || null,
      payload: best.payload
    };
  }

  function firstRegexValue(source, patterns) {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        return decodeLooseValue(match[1]).trim();
      }
    }
    return "";
  }

  function extractValueByKeys(source, keys) {
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`),
        new RegExp(`"${escaped}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`)
      ];
      const value = firstRegexValue(source, patterns);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function extractObjectValueByKeys(object, keys) {
    if (!object || typeof object !== "object") {
      return "";
    }

    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
        return String(object[key]);
      }
    }

    let found = "";
    walkJson(object, (candidate) => {
      if (found) {
        return;
      }
      for (const key of keys) {
        if (candidate[key] !== undefined && candidate[key] !== null && candidate[key] !== "") {
          found = String(candidate[key]);
          return;
        }
      }
    });

    return found;
  }

  function extractDirectObjectValueByKeys(object, keys) {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      return "";
    }

    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
        return String(object[key]);
      }
    }

    return "";
  }

  function getNoteMetricValue(noteContext, noteBlock, keys) {
    const fromObject = parseMetricValue(extractObjectValueByKeys(noteContext?.object, keys));
    if (fromObject) {
      return fromObject;
    }
    const fromParent = parseMetricValue(extractDirectObjectValueByKeys(noteContext?.parent, keys));
    if (fromParent) {
      return fromParent;
    }
    return parseMetricValue(extractValueByKeys(noteBlock, keys));
  }

  function getScopedNoteMetricValue(noteContext, keys) {
    const fromObject = parseMetricValue(extractObjectValueByKeys(noteContext?.object, keys));
    if (fromObject) {
      return fromObject;
    }
    return parseMetricValue(extractDirectObjectValueByKeys(noteContext?.parent, keys));
  }

  function isTrustedCurrentNoteContext(noteContext) {
    return /noteDetailMap|note_detail_map|noteMap|note_map|detailMap|detail_map/.test(noteContext?.source || "");
  }

  function findAllIndexes(source, value) {
    const indexes = [];
    let index = source.indexOf(value);
    while (index >= 0) {
      indexes.push(index);
      index = source.indexOf(value, index + value.length);
    }
    return indexes;
  }

  function scoreNoteBlock(block) {
    const checks = [
      /"likedCount"|"likeCount"|"liked_count"|"interactInfo"/,
      /"collectedCount"|"collectCount"|"collectNum"|"collected_count"/,
      /"commentCount"|"commentNum"|"comment_count"/,
      /"imageList"|"image_list"|"imageInfoList"|"image_info_list"|"imageInfos"|"image_infos"|"noteImageList"|"note_image_list"|"picList"|"pic_list"|"photoList"|"photo_list"|"images"|"urlDefault"|"url_default"|"urlPre"|"url_pre"|"urlList"|"url_list"|"url"|"masterUrl"|"master_url"|"imageUrl"|"image_url"/,
      /"tagList"|"hashTag"|"tag_list"/,
      /"user"|"userInfo"|"user_info"|"nickname"|"nickName"|"nick_name"/
    ];
    return checks.reduce((score, pattern) => score + (pattern.test(block) ? 1 : 0), 0);
  }

  function getCurrentNoteBlock(noteId) {
    const source = getScriptSource();
    if (!noteId) {
      return "";
    }

    let bestBlock = "";
    let bestScore = -1;
    const indexes = findAllIndexes(source, noteId);
    for (const index of indexes) {
      const objectStart = source.lastIndexOf("{", index);
      const start = objectStart >= 0 ? objectStart : Math.max(0, index - 200);
      const nextNoteId = source.slice(index + noteId.length).search(/"noteId"\s*:|"note_id"\s*:/);
      const end = nextNoteId >= 0
        ? Math.min(source.length, index + noteId.length + nextNoteId)
        : Math.min(source.length, index + 18000);
      const block = source.slice(start, end);
      const score = scoreNoteBlock(block);
      if (score > bestScore) {
        bestScore = score;
        bestBlock = block;
      }
    }

    return bestBlock || "";
  }

  function getCurrentNoteId() {
    const fromUrl = location.href.match(/\/(?:explore|search_result|red_video|discovery\/item)\/([A-Za-z0-9_-]+)/);
    if (fromUrl?.[1]) {
      return fromUrl[1];
    }

    const link = document.querySelector('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/red_video/"], a[href*="/discovery/item/"]');
    const fromLink = getUrlFromElement(link).match(/\/(?:explore|search_result|red_video|discovery\/item)\/([A-Za-z0-9_-]+)/);
    if (fromLink?.[1]) {
      return fromLink[1];
    }

    return "";
  }

  function getCurrentNoteIdFromLocation() {
    const fromUrl = location.href.match(/\/(?:explore|search_result|red_video|discovery\/item)\/([A-Za-z0-9_-]+)/);
    return fromUrl?.[1] || "";
  }

  function getNoteLink(noteId) {
    const currentUrl = location.href || "";
    if (noteId && new RegExp(`/(?:explore|search_result|red_video|discovery/item)/${noteId}(?:[/?#]|$)`).test(currentUrl)) {
      return currentUrl;
    }
    if (noteId) {
      return `https://www.xiaohongshu.com/explore/${noteId}`;
    }
    return currentUrl;
  }

  function isUsefulText(value) {
    const text = (value || "").trim();
    if (!text || text.length > 80) {
      return false;
    }
    return !/^(关注|已关注|分享|评论|收藏|点赞|赞|更多|展开|收起)$/.test(text);
  }

  function isLikelySearchHintText(value) {
    return /猜你想搜|大家都在搜|搜一搜|搜索/.test(value || "");
  }

  function isInNoiseSection(element) {
    const noise = element?.closest?.(
      '[class*="comment"], [class*="Comment"], [class*="reply"], [class*="Reply"], [class*="recommend"], [class*="Recommend"], [class*="feed"], [class*="Feed"], [class*="suggest"], [class*="Suggest"]'
    );
    if (!noise) return false;
    // A detail modal can live inside feeds-content__feed-layer. Only noise
    // inside the detail belongs to the note; its outer feed shell does not.
    const detail = element?.closest?.('#noteContainer, .note-container');
    if (detail && noise !== detail && elementContains(noise, detail)) return false;
    return true;
  }

  function elementContains(root, child) {
    let node = child;
    while (node) {
      if (node === root) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function findShareClickRoot(clickable, noteRoot) {
    if (noteRoot && noteRoot !== document.body && noteRoot !== document.documentElement && elementContains(noteRoot, clickable)) {
      return noteRoot;
    }

    const container = clickable?.closest?.(
      '#noteContainer, [class*="note-container"], [class*="noteContainer"], [class*="outer-link-container"], [class*="detail-container"], [class*="detailContainer"], [role="dialog"]'
    );
    if (!container || container === document.body || container === document.documentElement) {
      return noteRoot;
    }

    const hasDetailSignal = Boolean(
      container.querySelector?.('#detail-title, #detail-desc, .note-content, [class*="interaction-container"], [class*="interact-container"], [class*="engage-bar"], img, video')
    );
    return hasDetailSignal ? container : noteRoot;
  }

  function hasCaptureRootSignals(element) {
    if (!element?.querySelector) {
      return false;
    }

    const hasContentSignal = Boolean(element.querySelector(
      '#detail-title, #detail-desc, .note-content, [class*="note-content"], [class*="NoteContent"], h1'
    ));
    const hasInteractionSignal = Boolean(element.querySelector(
      '[class*="interaction-container"], [class*="InteractionContainer"], [class*="interact-container"], [class*="InteractContainer"], [class*="engage-bar"], [class*="EngageBar"], [class*="interaction-toolbar"], [class*="InteractionToolbar"], [class*="like-wrapper"], [class*="LikeWrapper"], [class*="collect-wrapper"], [class*="CollectWrapper"], [class*="comment-wrapper"], [class*="CommentWrapper"], [class*="chat-wrapper"], [class*="ChatWrapper"], [class*="share-wrapper"], [class*="ShareWrapper"]'
    ));

    return hasContentSignal && hasInteractionSignal;
  }

  function elementHasNoteId(element, noteId) {
    if (!element?.querySelectorAll || !noteId) {
      return false;
    }
    const noteUrlPattern = new RegExp(`/(?:explore|search_result|red_video|discovery/item)/${escapeRegExp(noteId)}(?:[/?#]|$)`);
    const links = Array.from(element.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/red_video/"], a[href*="/discovery/item/"]') || []);
    return links.some((link) => noteUrlPattern.test(getUrlFromElement(link)));
  }

  function isUsableCaptureRoot(element) {
    return Boolean(
      element &&
      element !== document.body &&
      element !== document.documentElement &&
      !isInNoiseSection(element) &&
      hasCaptureRootSignals(element)
    );
  }

  function findCaptureRoot(expectedNoteId = "", rootHint = null) {
    if (isUsableCaptureRoot(rootHint)) {
      return rootHint;
    }

    const selectors = [
      "#noteContainer",
      ".note-container",
      '[class*="note-container"]',
      ".noteContainer",
      '[class*="noteContainer"]',
      ".outer-link-container",
      '[class*="outer-link-container"]',
      ".detail-container",
      '[class*="detail-container"]',
      ".detailContainer",
      '[class*="detailContainer"]',
      '[role="dialog"]'
    ];
    const seen = new Set();

    for (const selector of selectors) {
      const candidates = [
        document.querySelector?.(selector),
        ...Array.from(document.querySelectorAll?.(selector) || [])
      ].filter(Boolean);

      for (const candidate of candidates) {
        if (seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);

        if (!isUsableCaptureRoot(candidate)) {
          continue;
        }
        if (!expectedNoteId || elementHasNoteId(candidate, expectedNoteId) || getCurrentNoteIdFromLocation() === expectedNoteId) {
          return candidate;
        }
      }
    }

    const noteRoot = findNoteRoot();
    const container = noteRoot?.closest?.(
      '#noteContainer, .note-container, [class*="note-container"], .noteContainer, [class*="noteContainer"], .outer-link-container, [class*="outer-link-container"], .detail-container, [class*="detail-container"], .detailContainer, [class*="detailContainer"], [role="dialog"]'
    );
    if (
      container &&
      isUsableCaptureRoot(container) &&
      (!expectedNoteId || elementHasNoteId(container, expectedNoteId) || getCurrentNoteIdFromLocation() === expectedNoteId)
    ) {
      return container;
    }

    return noteRoot;
  }

  function elementChildren(element) {
    return Array.from(element?.children || []);
  }

  function hasIconOnlySignal(element) {
    const text = textOf(element);
    const className = String(element?.className || "");
    return text.length <= 2 && Boolean(
      element?.querySelector?.("svg, img, use, path") ||
      /icon|svg/i.test(className)
    );
  }

  function isLikelyUnlabeledShareAction(clickable, noteRoot) {
    if (!hasIconOnlySignal(clickable)) {
      return false;
    }

    let node = clickable;
    for (let depth = 0; node && node !== noteRoot && depth < 5; depth += 1) {
      const parent = node.parentElement;
      const siblings = elementChildren(parent);
      const index = siblings.indexOf(node);
      if (index >= 0) {
        const previousText = siblings.slice(Math.max(0, index - 4), index)
          .map(textOf)
          .join(" ");
        const nearbyMetricCount = (previousText.match(/\d+(?:\.\d+)?\s*[万wWkK]?/g) || []).length;
        const actionClusterText = textOf(parent);
        if (nearbyMetricCount >= 3 && actionClusterText.length <= 40) {
          return true;
        }
      }
      node = parent;
    }

    return false;
  }

  function isExplicitShareControl(element, label = "") {
    const explicitLabel = /分享|share|Share|复制链接|复制笔记链接|copy\s*link|copy-link|copyLink/i.test(label || "");
    const explicitClass = Boolean(element?.closest?.(
      '[class*="share-wrapper"], [class*="ShareWrapper"], [class*="share-icon"], [class*="ShareIcon"], [class*="link-wrapper"], [class*="LinkWrapper"], [class*="link-icon"], [class*="LinkIcon"]'
    ));
    return explicitLabel || explicitClass;
  }

  function firstSafeText(selectors, root = document) {
    if (!root?.querySelectorAll && !root?.querySelector) {
      return "";
    }

    for (const selector of selectors) {
      const elements = root.querySelectorAll
        ? Array.from(root.querySelectorAll(selector))
        : [root.querySelector(selector)].filter(Boolean);
      const fallbackElement = root.querySelector?.(selector);
      if (fallbackElement && !elements.includes(fallbackElement)) {
        elements.push(fallbackElement);
      }
      for (const element of elements) {
        if (isInNoiseSection(element)) {
          continue;
        }
        const value = textOf(element);
        if (value && !isLikelySearchHintText(value)) {
          return value;
        }
      }

      if (!root.querySelectorAll && root.querySelector) {
        const element = root.querySelector(selector);
        if (element && !isInNoiseSection(element)) {
          const value = textOf(element);
          if (value && !isLikelySearchHintText(value)) {
            return value;
          }
        }
      }
    }

    return "";
  }

  function isLikelyContentImageUrl(url) {
    const raw = String(url || "").toLowerCase();
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
      return false;
    }
    if (!/(xhscdn|sns-webpic|sns-img|ci\.xiaohongshu|xiaohongshu)/.test(raw)) {
      return false;
    }
    return !/(avatar|head|profile|user|icon|logo|emoji|comment|grey)/.test(raw);
  }

  function collectImageUrlsFromObject(object, options = {}) {
    const urls = new Set();
    if (!object || typeof object !== "object") {
      return [];
    }

    const imageKeys = [
      "urlDefault",
      "url_default",
      "urlPre",
      "url_pre",
      "url",
      "masterUrl",
      "master_url",
      "imageUrl",
      "image_url",
      "original",
      "originalUrl",
      "original_url",
      "largeUrl",
      "large_url",
      "large",
      "cover",
      "coverUrl",
      "cover_url",
      "coverURL",
      "coverImage",
      "coverImageUrl",
      "cover_image",
      "cover_image_url",
      "poster",
      "posterUrl",
      "poster_url",
      "videoCover",
      "videoCoverUrl",
      "video_cover",
      "video_cover_url",
      "thumbnail",
      "thumbnailUrl",
      "thumbnail_url",
      "firstFrame",
      "firstFrameUrl",
      "first_frame_url",
      "src"
    ];

    const mediaKeys = [
      "imageList",
      "image_list",
      "imageInfoList",
      "image_info_list",
      "images",
      "image",
      "imageInfo",
      "imageInfos",
      "image_info",
      "image_infos",
      "media",
      "mediaList",
      "media_list",
      "noteImageList",
      "note_image_list",
      "picList",
      "pic_list",
      "photoList",
      "photo_list",
      "cover",
      "coverInfo",
      "cover_info",
      "poster",
      "posterInfo",
      "poster_info",
      "video",
      "videoInfo",
      "video_info",
      "videoCover",
      "video_cover",
      "thumbnail",
      "thumbnailInfo",
      "thumbnail_info"
    ];

    function collectFromCandidate(candidate, depth = 0) {
      if (!candidate || typeof candidate !== "object") {
        return;
      }
      if (objectHasDifferentNoteId(candidate, options.noteId)) {
        return;
      }
      imageKeys.forEach((key) => {
        if (options.skipVideoFields && /video/i.test(key)) {
          return;
        }
        const value = candidate[key];
        if (typeof value !== "string") {
          return;
        }
        const normalized = normalizeUrl(value);
        if (isLikelyContentImageUrl(normalized)) {
          urls.add(normalized);
        }
      });

      const urlList = Array.isArray(candidate.urlList) ? candidate.urlList : candidate.url_list;
      if (Array.isArray(urlList)) {
        urlList.forEach((url) => {
          const normalized = normalizeUrl(url);
          if (isLikelyContentImageUrl(normalized)) {
            urls.add(normalized);
          }
        });
      }

      if (depth >= 2) {
        return;
      }
      mediaKeys.forEach((key) => {
        if (options.skipVideoFields && /video/i.test(key)) {
          return;
        }
        const value = candidate[key];
        if (Array.isArray(value)) {
          value.forEach((item) => collectFromCandidate(item, depth + 1));
          return;
        }
        collectFromCandidate(value, depth + 1);
      });
    }

    collectFromCandidate(object);
    mediaKeys.forEach((key) => {
      if (options.skipVideoFields && /video/i.test(key)) {
        return;
      }
      const value = object[key];
      if (Array.isArray(value)) {
        value.forEach((item) => collectFromCandidate(item));
        return;
      }
      collectFromCandidate(value);
    });

    return Array.from(urls);
  }

  const STRUCTURED_IMAGE_LIST_KEYS = [
    "imageList",
    "image_list",
    "imageInfoList",
    "image_info_list",
    "imageInfos",
    "image_infos",
    "noteImageList",
    "note_image_list",
    "picList",
    "pic_list",
    "photoList",
    "photo_list",
    "pictureList",
    "picture_list",
    "imageResources",
    "image_resources",
    "images",
    "mediaList",
    "media_list",
    "mediaInfos",
    "media_infos"
  ];

  const STRUCTURED_SINGLE_IMAGE_KEYS = [
    "image",
    "imageInfo",
    "image_info",
    "cover",
    "coverInfo",
    "cover_info",
    "poster",
    "posterInfo",
    "poster_info",
    "thumbnail",
    "thumbnailInfo",
    "thumbnail_info"
  ];

  const STRUCTURED_COVER_IMAGE_KEYS = [
    "cover",
    "coverUrl",
    "cover_url",
    "coverURL",
    "coverImage",
    "coverImageUrl",
    "cover_image",
    "cover_image_url",
    "coverInfo",
    "cover_info"
  ];

  const STRUCTURED_VIDEO_IMAGE_KEYS = [
    "video",
    "videoInfo",
    "video_info",
    "videoCover",
    "video_cover"
  ];

  const CURRENT_NOTE_CONTAINER_KEYS = [
    "noteCard",
    "note_card",
    "noteInfo",
    "note_info",
    "noteDetail",
    "note_detail",
    "noteData",
    "note_data",
    "note",
    "card",
    "detail",
    "data",
    "item",
    "model"
  ];

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function collectCurrentNoteStructuredCandidates(object, noteId = "") {
    const candidates = [];
    const seen = new Set();

    function addCandidate(candidate, path) {
      if (!isPlainObject(candidate) || seen.has(candidate)) {
        return;
      }
      if (objectHasDifferentNoteId(candidate, noteId)) {
        return;
      }
      seen.add(candidate);
      candidates.push({ object: candidate, path });
    }

    function visitContainer(container, path, depth) {
      if (!isPlainObject(container) || depth > 2) {
        return;
      }
      addCandidate(container, path);

      CURRENT_NOTE_CONTAINER_KEYS.forEach((key) => {
        const value = container[key];
        if (!isPlainObject(value)) {
          return;
        }
        if (noteId && isPlainObject(value[noteId])) {
          visitContainer(value[noteId], `${path}.${key}.${noteId}`, depth + 1);
          return;
        }
        visitContainer(value, `${path}.${key}`, depth + 1);
      });
    }

    visitContainer(object, "$", 0);
    return candidates;
  }

  function hasStructuredMultiImageListEvidence(object, noteId = "") {
    return collectCurrentNoteStructuredCandidates(object, noteId).some(({ object: candidate }) => (
      STRUCTURED_IMAGE_LIST_KEYS.some((key) => Array.isArray(candidate[key]) && candidate[key].length > 1)
    ));
  }

  function isSearchResultSourceUrl() {
    return /[?&]xsec_source=(?:pc_search|web_search_result_notes)\b|[?&]source=web_search_result_notes\b|\/search_result(?:[/?#]|$)/.test(location.href || "");
  }

  function getDirectStructuredType(object) {
    const typeKeys = [
      "type",
      "noteType",
      "note_type",
      "mediaType",
      "media_type",
      "cardType",
      "card_type"
    ];
    return String(extractDirectObjectValueByKeys(object, typeKeys) || "").toLowerCase();
  }

  function isImageStructuredType(type) {
    return /image|normal|图文|photo/.test(type || "");
  }

  function hasTypedStructuredMultiImageListEvidence(object, noteId = "") {
    return collectCurrentNoteStructuredCandidates(object, noteId).some(({ object: candidate }) => {
      if (!isImageStructuredType(getDirectStructuredType(candidate))) {
        return false;
      }
      return STRUCTURED_IMAGE_LIST_KEYS.some((key) => Array.isArray(candidate[key]) && candidate[key].length > 1);
    });
  }

  function hasOwnValue(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key) &&
      object[key] !== undefined &&
      object[key] !== null &&
      object[key] !== "";
  }

  function hasAnyOwnValue(object, keys) {
    return keys.some((key) => hasOwnValue(object, key));
  }

  function isLikelyRelatedStructuredImageItem(candidate, noteId) {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    if (objectHasDifferentNoteId(candidate, noteId)) {
      return true;
    }
    if (objectHasNoteId(candidate, noteId)) {
      return false;
    }

    const noteTextKeys = [
      "title",
      "displayTitle",
      "display_title",
      "desc",
      "description",
      "content",
      "nickname",
      "nickName",
      "userId",
      "user_id",
      "author",
      "user"
    ];
    const noteMetricKeys = [
      "likedCount",
      "likeCount",
      "collectCount",
      "commentCount",
      "shareCount",
      "liked_count",
      "comment_count"
    ];
    const mediaKeys = STRUCTURED_IMAGE_LIST_KEYS.concat(STRUCTURED_SINGLE_IMAGE_KEYS);

    return hasAnyOwnValue(candidate, mediaKeys) &&
      (hasAnyOwnValue(candidate, noteTextKeys) || hasAnyOwnValue(candidate, noteMetricKeys));
  }

  function addStructuredImageUrl(urls, rawUrl) {
    const normalized = normalizeUrl(rawUrl);
    if (isLikelyContentImageUrl(normalized)) {
      urls.push(normalized);
    }
  }

  function collectDirectImageUrlsFromAsset(candidate, options = {}) {
    const urls = [];
    if (!candidate) {
      return urls;
    }
    if (typeof candidate === "string") {
      addStructuredImageUrl(urls, candidate);
      return urls;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => {
        collectDirectImageUrlsFromAsset(item, options).forEach((url) => urls.push(url));
      });
      return urls;
    }
    if (typeof candidate !== "object" || isLikelyRelatedStructuredImageItem(candidate, options.noteId)) {
      return urls;
    }

    const imageKeys = [
      "urlDefault",
      "url_default",
      "urlPre",
      "url_pre",
      "url",
      "masterUrl",
      "master_url",
      "imageUrl",
      "image_url",
      "original",
      "originalUrl",
      "original_url",
      "largeUrl",
      "large_url",
      "large",
      "cover",
      "coverUrl",
      "cover_url",
      "coverURL",
      "coverImage",
      "coverImageUrl",
      "cover_image",
      "cover_image_url",
      "poster",
      "posterUrl",
      "poster_url",
      "thumbnail",
      "thumbnailUrl",
      "thumbnail_url",
      "src"
    ];
    const videoKeys = [
      "videoCover",
      "videoCoverUrl",
      "video_cover",
      "video_cover_url",
      "firstFrame",
      "firstFrameUrl",
      "first_frame_url"
    ];

    imageKeys.concat(options.skipVideoFields ? [] : videoKeys).forEach((key) => {
      if (typeof candidate[key] === "string") {
        addStructuredImageUrl(urls, candidate[key]);
      }
    });

    const urlList = Array.isArray(candidate.urlList) ? candidate.urlList : candidate.url_list;
    if (Array.isArray(urlList)) {
      urlList.forEach((item) => {
        collectDirectImageUrlsFromAsset(item, options).forEach((url) => urls.push(url));
      });
    }

    [
      "info",
      "infoList",
      "info_list",
      "urlInfo",
      "url_info",
      "imageInfo",
      "image_info",
      "coverInfo",
      "cover_info",
      "posterInfo",
      "poster_info",
      "thumbnailInfo",
      "thumbnail_info"
    ].forEach((key) => {
      if (candidate[key] && typeof candidate[key] === "object") {
        collectDirectImageUrlsFromAsset(candidate[key], options).forEach((url) => urls.push(url));
      }
    });

    return urls;
  }

  function collectStructuredCoverUrlsFromCandidate(candidate, options = {}) {
    const urls = [];
    STRUCTURED_COVER_IMAGE_KEYS.forEach((key) => {
      if (!candidate?.[key]) {
        return;
      }
      collectDirectImageUrlsFromAsset(candidate[key], {
        ...options,
        skipVideoFields: true
      }).forEach((url) => urls.push(url));
    });
    return dedupeImageUrls(urls);
  }

  function isPreferredPublishImageListKey(key) {
    return /^(imageList|image_list|imageInfoList|image_info_list|imageInfos|image_infos|noteImageList|note_image_list|picList|pic_list|photoList|photo_list|pictureList|picture_list|images|imageResources|image_resources)$/.test(key);
  }

  function getStructuredImageListKeyScore(key) {
    if (/^(imageList|image_list|imageInfoList|image_info_list|imageInfos|image_infos)$/.test(key)) {
      return 500;
    }
    if (/^(noteImageList|note_image_list|picList|pic_list|photoList|photo_list|pictureList|picture_list)$/.test(key)) {
      return 430;
    }
    if (/^(images|imageResources|image_resources)$/.test(key)) {
      return 320;
    }
    if (/^(mediaList|media_list|mediaInfos|media_infos)$/.test(key)) {
      return -160;
    }
    return 0;
  }

  function getStructuredCandidatePathScore(path) {
    if (/\.(noteCard|note_card|noteDetail|note_detail|noteInfo|note_info|noteData|note_data)\b/.test(path || "")) {
      return 120;
    }
    if (/\.(card|detail|data|item|model|note)\b/.test(path || "")) {
      return 45;
    }
    return 0;
  }

  function hasNestedPreferredPublishList(candidate) {
    if (!isPlainObject(candidate)) {
      return false;
    }
    return CURRENT_NOTE_CONTAINER_KEYS.some((key) => {
      const value = candidate[key];
      if (!isPlainObject(value)) {
        return false;
      }
      return STRUCTURED_IMAGE_LIST_KEYS.some((listKey) => (
        isPreferredPublishImageListKey(listKey) &&
        Array.isArray(value[listKey]) &&
        value[listKey].length > 1
      ));
    });
  }

  function isNoisyStructuredImagePath(path) {
    return /comment|comments|reply|recommend|related|suggest|avatar|profile|emoji|sticker|brand|banner|ads?|advert/i.test(path || "");
  }

  function collectStructuredImageListCandidates(object, options = {}) {
    const listCandidates = [];
    const seenListKeys = new Set();
    const noteId = options.noteId || "";

    function addListCandidate(candidate, path, key, value) {
      if (!value || objectHasDifferentNoteId(candidate, noteId) || isNoisyStructuredImagePath(`${path}.${key}`)) {
        return;
      }
      const urls = dedupeImageUrls(collectDirectImageUrlsFromAsset(value, options));
      if (urls.length === 0) {
        return;
      }
      const identity = `${path}.${key}:${urls.map(getImageDedupeKey).join("|")}`;
      if (seenListKeys.has(identity)) {
        return;
      }
      seenListKeys.add(identity);
      const coverUrls = collectStructuredCoverUrlsFromCandidate(candidate, options);
      const domAnchorUrls = dedupeImageUrls(options.domAnchorUrls || []);
      const entryAnchorUrls = dedupeImageUrls(options.entryCoverUrls || []);
      listCandidates.push({
        urls,
        coverUrls,
        path,
        key,
        candidate,
        hasEntryAnchor: entryAnchorUrls.some((entryUrl) => findImageUrlIndexByKey(urls, entryUrl) >= 0),
        hasCoverAnchor: coverUrls.some((coverUrl) => findImageUrlIndexByKey(urls, coverUrl) >= 0),
        hasDomAnchor: domAnchorUrls.some((domUrl) => findImageUrlIndexByKey(urls, domUrl) >= 0),
        isPreferredPublishList: isPreferredPublishImageListKey(key)
      });
    }

    collectCurrentNoteStructuredCandidates(object, noteId).forEach(({ object: candidate, path }) => {
      STRUCTURED_IMAGE_LIST_KEYS.forEach((key) => {
        addListCandidate(candidate, path, key, candidate[key]);
      });
    });

    const seenObjects = new WeakSet();
    function visitDeep(value, path, depth) {
      if (!value || typeof value !== "object" || depth > 9 || isNoisyStructuredImagePath(path)) {
        return;
      }
      if (Array.isArray(value)) {
        value.slice(0, 80).forEach((item, index) => visitDeep(item, `${path}.${index}`, depth + 1));
        return;
      }
      if (!isPlainObject(value) || seenObjects.has(value) || objectHasDifferentNoteId(value, noteId)) {
        return;
      }
      seenObjects.add(value);
      STRUCTURED_IMAGE_LIST_KEYS.forEach((key) => {
        addListCandidate(value, path, key, value[key]);
      });
      Object.keys(value).forEach((key) => {
        if (STRUCTURED_IMAGE_LIST_KEYS.includes(key) || STRUCTURED_SINGLE_IMAGE_KEYS.includes(key)) {
          return;
        }
        visitDeep(value[key], `${path}.${key}`, depth + 1);
      });
    }

    visitDeep(object, "$", 0);
    return listCandidates;
  }

  function rotateImageUrlsToAnchor(urls, anchorUrls, source) {
    const orderedUrls = dedupeImageUrls(urls);
    const evidence = {
      source,
      anchorUrl: "",
      anchorIndex: -1,
      matched: false,
      applied: false
    };

    for (const anchorUrl of dedupeImageUrls(anchorUrls || [])) {
      const anchorIndex = findImageUrlIndexByKey(orderedUrls, anchorUrl);
      if (anchorIndex < 0) {
        continue;
      }
      evidence.anchorUrl = anchorUrl;
      evidence.anchorIndex = anchorIndex;
      evidence.matched = true;
      if (anchorIndex > 0) {
        evidence.applied = true;
        return {
          urls: orderedUrls.slice(anchorIndex).concat(orderedUrls.slice(0, anchorIndex)),
          evidence
        };
      }
      return {
        urls: orderedUrls,
        evidence
      };
    }

    return {
      urls: orderedUrls,
      evidence
    };
  }

  function rotateImageUrlsToSecondAnchor(urls, anchorUrls, source) {
    const orderedUrls = dedupeImageUrls(urls);
    const evidence = {
      source,
      anchorUrl: "",
      anchorIndex: -1,
      matched: false,
      applied: false,
      ignoredAnchorIndex: -1
    };

    for (const anchorUrl of dedupeImageUrls(anchorUrls || [])) {
      const anchorIndex = findImageUrlIndexByKey(orderedUrls, anchorUrl);
      if (anchorIndex < 0) {
        continue;
      }
      if (!evidence.matched) {
        evidence.anchorUrl = anchorUrl;
        evidence.anchorIndex = anchorIndex;
        evidence.matched = true;
      }
      if (anchorIndex === 1) {
        evidence.anchorUrl = anchorUrl;
        evidence.anchorIndex = anchorIndex;
        evidence.applied = true;
        return {
          urls: orderedUrls.slice(1).concat(orderedUrls.slice(0, 1)),
          evidence
        };
      }
      evidence.ignoredAnchorIndex = anchorIndex;
    }

    return {
      urls: orderedUrls,
      evidence
    };
  }

  function orderStructuredPublishImageUrls(urls, options = {}) {
    if (options.isPreferredPublishList) {
      return alignStructuredImageUrlsToAnchor(
        urls,
        dedupeImageUrls((options.entryCoverUrls || [])
          .concat(options.visibleDomCoverUrls || [])
          .concat(options.coverUrls || [])),
        "imageList-publish-order"
      );
    }

    const byEntryCover = rotateImageUrlsToSecondAnchor(urls, options.entryCoverUrls, "entry-card-cover-second");
    if (byEntryCover.evidence.applied) {
      return byEntryCover;
    }

    const byVisibleDomCover = rotateImageUrlsToSecondAnchor(urls, options.visibleDomCoverUrls, "visible-dom-cover-second");
    if (byVisibleDomCover.evidence.applied) {
      return byVisibleDomCover;
    }

    const byStructuredCoverSecond = rotateImageUrlsToSecondAnchor(urls, options.coverUrls, "structured-cover-second");
    if (byStructuredCoverSecond.evidence.applied) {
      return byStructuredCoverSecond;
    }

    return {
      urls: dedupeImageUrls(urls),
      evidence: {
        source: "structured-list-order",
        anchorUrl: "",
        anchorIndex: -1,
        matched: false,
        applied: false,
        entryCover: byEntryCover.evidence,
        visibleDomCover: byVisibleDomCover.evidence,
        structuredCoverSecond: byStructuredCoverSecond.evidence
      }
    };
  }

  function selectBestStructuredImageList(object, options = {}) {
    const evidence = {
      selectedPath: "",
      selectedKey: "",
      selectedScore: Number.NEGATIVE_INFINITY,
      candidateListCount: 0,
      ignoredMediaListBecausePublishList: 0,
      order: null
    };
    let best = null;
    const listCandidates = collectStructuredImageListCandidates(object, options);
    evidence.candidateListCount = listCandidates.length;

    const hasPreferredPublishList = options.noteType !== "视频" &&
      listCandidates.some((candidate) => candidate.isPreferredPublishList && candidate.urls.length > 1);
    if (hasPreferredPublishList) {
      evidence.ignoredMediaListBecausePublishList = listCandidates.filter((candidate) => !candidate.isPreferredPublishList).length;
    }

    listCandidates
      .filter((candidate) => !hasPreferredPublishList || candidate.isPreferredPublishList)
      .forEach((listCandidate) => {
        let score = listCandidate.urls.length > 1 ? 100 : 0;
        if (listCandidate.hasEntryAnchor) {
          score += 900;
        }
        if (isImageStructuredType(getDirectStructuredType(listCandidate.candidate))) {
          score += 80;
        }
        if (options.noteType === "视频" && listCandidate.hasCoverAnchor) {
          score += 35;
        }
        if (options.noteType === "视频" && listCandidate.hasDomAnchor && listCandidate.isPreferredPublishList) {
          score += 35;
        }
        if (objectHasNoteId(listCandidate.candidate, options.noteId)) {
          score += 30;
        }
        score += getStructuredImageListKeyScore(listCandidate.key);
        score += getStructuredCandidatePathScore(listCandidate.path);
        if (listCandidate.isPreferredPublishList && hasNestedPreferredPublishList(listCandidate.candidate)) {
          score -= 180;
        }
        score += Math.min(listCandidate.urls.length, MAX_NOTE_IMAGE_COUNT) * 3;

        if (!best || score > best.score || (score === best.score && listCandidate.urls.length > best.urls.length)) {
          best = {
            urls: listCandidate.urls,
            coverUrls: listCandidate.coverUrls,
            score,
            path: listCandidate.path,
            key: listCandidate.key,
            hasCoverAnchor: listCandidate.hasCoverAnchor,
            hasDomAnchor: listCandidate.hasDomAnchor,
            hasEntryAnchor: listCandidate.hasEntryAnchor,
            isPreferredPublishList: listCandidate.isPreferredPublishList
          };
        }
      });

    if (!best) {
      return { urls: [], coverUrls: [], evidence };
    }

    evidence.selectedPath = best.path;
    evidence.selectedKey = best.key;
    evidence.selectedScore = best.score;
    evidence.selectedHasCoverAnchor = best.hasCoverAnchor;
    evidence.selectedHasDomAnchor = best.hasDomAnchor;
    evidence.selectedHasEntryAnchor = best.hasEntryAnchor;
    evidence.selectedIsPreferredPublishList = best.isPreferredPublishList;
    const ordered = options.noteType === "视频" ? {
      urls: best.urls,
      evidence: {
        source: "video-list-order",
        anchorUrl: "",
        anchorIndex: -1,
        matched: false,
        applied: false
      }
    } : orderStructuredPublishImageUrls(best.urls, {
      isPreferredPublishList: best.isPreferredPublishList,
      entryCoverUrls: options.entryCoverUrls,
      visibleDomCoverUrls: options.visibleDomCoverUrls,
      coverUrls: best.coverUrls
    });
    evidence.order = ordered.evidence;
    return {
      urls: ordered.urls,
      coverUrls: best.coverUrls,
      evidence
    };
  }

  function collectStructuredImageUrlsFromCurrentNote(object, options = {}) {
    const urls = [];
    const evidence = {
      listKeys: [],
      skippedRelatedLists: 0
    };
    if (!object || typeof object !== "object") {
      return { urls, evidence };
    }

    if (options.preferSingleBestList) {
      const selected = selectBestStructuredImageList(object, options);
      if (selected.urls.length > 0) {
        return {
          urls: selected.urls,
          selectedCoverUrls: selected.coverUrls,
          evidence: {
            ...evidence,
            singleBestList: selected.evidence
          }
        };
      }
    }

    const candidates = collectCurrentNoteStructuredCandidates(object, options.noteId);

    candidates.forEach(({ object: candidate, path }) => {
      STRUCTURED_IMAGE_LIST_KEYS.forEach((key) => {
        const value = candidate[key];
        if (!value) {
          return;
        }
        evidence.listKeys.push(`${path}.${key}`);
        const before = urls.length;
        collectDirectImageUrlsFromAsset(value, options).forEach((url) => urls.push(url));
        if (before === urls.length && Array.isArray(value) && value.length > 0) {
          evidence.skippedRelatedLists += 1;
        }
      });
    });

    if (urls.length === 0) {
      candidates.forEach(({ object: candidate }) => {
        STRUCTURED_SINGLE_IMAGE_KEYS.forEach((key) => {
          collectDirectImageUrlsFromAsset(candidate[key], options).forEach((url) => urls.push(url));
        });
      });
    }

    if (options.noteType === "视频") {
      candidates.forEach(({ object: candidate }) => {
        STRUCTURED_VIDEO_IMAGE_KEYS.forEach((key) => {
          collectDirectImageUrlsFromAsset(candidate[key], {
            ...options,
            skipVideoFields: false
          }).forEach((url) => urls.push(url));
        });
        collectDirectImageUrlsFromAsset(candidate, {
          ...options,
          skipVideoFields: false
        }).forEach((url) => urls.push(url));
      });
    }

    return {
      urls: dedupeImageUrls(urls),
      evidence
    };
  }

  function collectStructuredCoverUrlsFromCurrentNote(object, options = {}) {
    const urls = [];
    const evidence = {
      coverKeys: []
    };
    if (!object || typeof object !== "object") {
      return { urls, evidence };
    }

    const isImageNote = options.noteType !== "视频";
    collectCurrentNoteStructuredCandidates(object, options.noteId).forEach(({ object: candidate, path }) => {
      STRUCTURED_COVER_IMAGE_KEYS.forEach((key) => {
        if (isImageNote && /video/i.test(key)) {
          return;
        }
        if (isImageNote && isPlainObject(candidate[key]) && hasVideoSignalInObject(candidate[key])) {
          return;
        }
        const before = urls.length;
        collectStructuredCoverUrlsFromCandidate({ [key]: candidate[key] }, options)
          .forEach((url) => urls.push(url));
        if (urls.length > before) {
          evidence.coverKeys.push(`${path}.${key}`);
        }
      });
    });

    return {
      urls: dedupeImageUrls(urls),
      evidence
    };
  }

  function normalizeUrl(raw) {
    let decoded = decodeLooseValue(raw);
    if (!decoded) {
      return "";
    }
    if (decoded.startsWith("//")) {
      decoded = `https:${decoded}`;
    }
    if (/^http:\/\/.*(xhscdn|xiaohongshu|sns-webpic|sns-img|ci\.)/i.test(decoded)) {
      decoded = decoded.replace(/^http:\/\//i, "https://");
    }
    try {
      return new URL(decoded, location.href).href;
    } catch (error) {
      return decoded;
    }
  }

  function getImageDedupeKey(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      return "";
    }
    try {
      const parsed = new URL(normalized, location.href);
      if (/(xhscdn|sns-webpic|sns-img|ci\.xiaohongshu|xiaohongshu)/i.test(parsed.hostname)) {
        const segments = parsed.pathname.split("/").filter(Boolean);
        const resourceName = segments[segments.length - 1] || "";
        const resourceBase = decodeURIComponent(resourceName).split("!")[0];
        if (resourceBase) {
          return `xhs:${resourceBase}`.toLowerCase();
        }
        return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
      }
      parsed.hash = "";
      parsed.search = "";
      return parsed.href.toLowerCase();
    } catch (error) {
      return normalized.split(/[?#]/)[0].toLowerCase();
    }
  }

  function getImageQualityScore(url) {
    const normalized = normalizeUrl(url).toLowerCase();
    let score = 0;
    if (/(^|[!_/-])(dft|default|origin|original|large|master)([_./-]|$)/.test(normalized)) {
      score += 10;
    }
    if (/(^|[!_/-])(prv|pre|preview|thumb|thumbnail)([_./-]|$)/.test(normalized)) {
      score -= 5;
    }
    return score;
  }

  function dedupeImageUrls(urls) {
    const result = [];
    const seen = new Map();
    const scores = new Map();
    (urls || []).forEach((url) => {
      if (!url) {
        return;
      }
      const key = getImageDedupeKey(url);
      if (!key) {
        return;
      }
      const score = getImageQualityScore(url);
      if (seen.has(key)) {
        if (score > (scores.get(key) ?? Number.NEGATIVE_INFINITY)) {
          result[seen.get(key)] = url;
          scores.set(key, score);
        }
        return;
      }
      seen.set(key, result.length);
      scores.set(key, score);
      result.push(url);
    });
    return result;
  }

  function parseMetricValue(value) {
    if (value === null || value === undefined || value === "") {
      return "";
    }
    const match = String(value).replace(/,/g, "").match(/(\d+(?:\.\d+)?)(\s*[万wWkK])?/);
    return match ? match[0].trim() : "";
  }

  const METRIC_CONTEXT_LABELS = [
    "关注",
    "粉丝",
    "获赞与收藏",
    "获赞和收藏",
    "赞藏",
    "点赞",
    "赞",
    "收藏",
    "评论",
    "分享",
    "转发",
    "fans",
    "followers",
    "likes",
    "collect",
    "favorite",
    "comment",
    "share"
  ];

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function endsWithMetricLabel(value) {
    const text = String(value || "").trim().toLowerCase();
    return METRIC_CONTEXT_LABELS.some((label) => text.endsWith(label.toLowerCase()));
  }

  function startsWithMetricLabel(value) {
    const text = String(value || "").trim().toLowerCase();
    return METRIC_CONTEXT_LABELS.some((label) => text.startsWith(label.toLowerCase()));
  }

  function parseMetricFromText(labelCandidates, root = document.body) {
    const pageText = root.innerText || "";
    for (const label of labelCandidates) {
      const escaped = escapeRegExp(label);
      const labelStart = `(^|[^\\u4e00-\\u9fa5A-Za-z])${escaped}`;
      const labelEnd = `(?=$|[^\\u4e00-\\u9fa5A-Za-z])`;
      const labelPattern = new RegExp(`${labelStart}${labelEnd}`, "gi");
      let labelMatch = labelPattern.exec(pageText);

      while (labelMatch) {
        const labelIndex = labelMatch.index + (labelMatch[1] || "").length;
        const labelTextEnd = labelIndex + label.length;
        const beforeText = pageText.slice(0, labelIndex);
        const afterText = pageText.slice(labelTextEnd);
        const beforeMatch = beforeText.match(/([\d.,]+\s*[万wWkK]?)\s*$/);
        const afterMatch = afterText.match(/^\s*[:：]?\s*([\d.,]+\s*[万wWkK]?)/);
        const beforeValue = beforeMatch?.[1]?.trim() || "";
        const afterValue = afterMatch?.[1]?.trim() || "";
        const beforePrefix = beforeValue
          ? beforeText.slice(0, beforeText.length - beforeMatch[0].length).slice(-12)
          : "";
        const afterSuffix = afterValue
          ? afterText.slice(afterMatch[0].length, afterMatch[0].length + 12)
          : "";
        const beforeBelongsToPreviousLabel = endsWithMetricLabel(beforePrefix);
        const afterBelongsToNextLabel = startsWithMetricLabel(afterSuffix);

        if (beforeBelongsToPreviousLabel && afterValue) {
          return afterValue;
        }
        if (afterBelongsToNextLabel && beforeValue) {
          return beforeValue;
        }
        if (afterValue) {
          return afterValue;
        }
        if (beforeValue) {
          return beforeValue;
        }

        labelMatch = labelPattern.exec(pageText);
      }
    }
    return "";
  }

  function getCurrentProfileUserId() {
    const match = location.href.match(/\/user\/profile\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }

  function objectHasProfileUserId(object, userId) {
    if (!object || typeof object !== "object" || !userId) {
      return false;
    }

    return [
      object.userId,
      object.user_id,
      object.userid,
      object.authorId,
      object.author_id,
      object.id
    ].some((value) => String(value || "") === userId);
  }

  function scoreProfileObject(object) {
    const block = JSON.stringify(object || {});
    const checks = [
      /"fans"|"fansCount"|"followerCount"|"followers"/,
      /"likedAndCollected"|"likesAndCollects"|"interactionCount"/,
      /"nickname"|"nickName"|"userName"/,
      /"userId"|"user_id"/
    ];
    return checks.reduce((score, pattern) => score + (pattern.test(block) ? 1 : 0), 0);
  }

  function findParsedProfileContext(userId) {
    const payloads = parseScriptJsonPayloads();
    let best = null;
    let bestScore = -1;

    payloads.forEach((payload) => {
      walkJson(payload, (object, path) => {
        if (!objectHasProfileUserId(object, userId)) {
          return;
        }

        const score = scoreProfileObject(object);
        if (score > bestScore) {
          bestScore = score;
          best = {
            object,
            parent: valueByPath(payload, path.slice(0, -1)) || null,
            payload
          };
        }
      });
    });

    return best;
  }

  function getProfileMetricValue(profileContext, keys) {
    const fromObject = parseMetricValue(extractDirectObjectValueByKeys(profileContext?.object, keys));
    if (fromObject) {
      return fromObject;
    }

    const fromParent = parseMetricValue(extractDirectObjectValueByKeys(profileContext?.parent, keys));
    if (fromParent) {
      return fromParent;
    }

    return "";
  }

  function parseProfileVisibleStats(text) {
    const source = String(text || "").replace(/\s+/g, " ").trim();
    const valuePattern = "([\\d.,]+\\s*[万wWkK]?)";
    const afterLabel = new RegExp(`关注\\s*${valuePattern}\\s*粉丝\\s*${valuePattern}\\s*(?:获赞与收藏|获赞和收藏|赞藏)\\s*${valuePattern}`);
    const afterMatch = source.match(afterLabel);
    if (afterMatch) {
      return {
        followers: afterMatch[2].trim(),
        totalLikes: afterMatch[3].trim()
      };
    }

    const beforeLabel = new RegExp(`${valuePattern}\\s*关注\\s*${valuePattern}\\s*粉丝\\s*${valuePattern}\\s*(?:获赞与收藏|获赞和收藏|赞藏)`);
    const beforeMatch = source.match(beforeLabel);
    if (beforeMatch) {
      return {
        followers: beforeMatch[2].trim(),
        totalLikes: beforeMatch[3].trim()
      };
    }

    return {};
  }

  function extractProfileAuthor(profileContext) {
    const fromObject = extractObjectValueByKeys(profileContext?.object, [
      "nickname",
      "nickName",
      "userName",
      "user_name",
      "name"
    ]);
    if (isUsefulText(fromObject)) {
      return fromObject;
    }

    const byDom = firstText([
      ".user-name",
      ".username",
      ".nickname",
      '[class*="user-name"]',
      '[class*="UserName"]',
      '[class*="nickname"]',
      '[class*="Nickname"]'
    ], document);
    if (isUsefulText(byDom)) {
      return byDom;
    }

    const byMeta = metaContent([
      'meta[property="og:title"]',
      'meta[name="title"]'
    ]);
    if (isUsefulText(byMeta)) {
      return byMeta.replace(/- 小红书.*/, "").trim();
    }

    return document.title.replace(/- 小红书.*/, "").trim();
  }

  function extractProfileMetricsFromCurrentPage() {
    const userId = getCurrentProfileUserId();
    const profileContext = findParsedProfileContext(userId);
    const visibleStats = parseProfileVisibleStats(document.body?.innerText || "");
    const source = `${document.body?.innerText || ""}\n${getScriptSource()}`;
    const followers = visibleStats.followers || getProfileMetricValue(profileContext, [
      "fans",
      "fansCount",
      "followerCount",
      "followers",
      "followersCount",
      "fans_count",
      "followers_count"
    ]) || parseMetricFromText(["粉丝", "fans", "followers"], document.body) ||
      firstRegexValue(source, [
        /"fans"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/,
        /"fansCount"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/,
        /"followers"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/,
        /"followerCount"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/
      ]);
    const totalLikes = visibleStats.totalLikes || getProfileMetricValue(profileContext, [
      "likedAndCollected",
      "likesAndCollects",
      "interactionCount",
      "likedCollectCount",
      "liked_collect_count",
      "totalFavorited",
      "total_favorited"
    ]) || parseMetricFromText(["获赞与收藏", "获赞和收藏", "赞藏"], document.body) ||
      firstRegexValue(source, [
        /"likedAndCollected"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/,
        /"likesAndCollects"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/,
        /"interactionCount"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/,
        /"likedCollectCount"\s*:\s*"?([\d.,]+(?:\s*[万wWkK])?)"?/
      ]);

    return {
      author: extractProfileAuthor(profileContext),
      authorLink: location.href.split("?")[0],
      followers,
      totalLikes
    };
  }

  function parseMetricBySelectors(root, selectors) {
    if (!root?.querySelectorAll) {
      return "";
    }
    for (const selector of selectors) {
      const elements = Array.from(root.querySelectorAll(selector));
      for (const element of elements) {
        const value = parseMetricValue(textOf(element));
        if (value) {
          return value;
        }
      }
    }
    return "";
  }

  function parseMetricAroundElement(element, keywords) {
    const candidates = [];
    let node = element;
    for (let depth = 0; node && depth < 4; depth += 1) {
      candidates.push(node);
      node = node.parentElement;
    }
    if (element.nextElementSibling) {
      candidates.push(element.nextElementSibling);
    }

    for (const candidate of candidates) {
      const label = [
        candidate.getAttribute?.("aria-label"),
        candidate.getAttribute?.("title"),
        textOf(candidate)
      ].filter(Boolean).join(" ");

      if (!keywords.some((keyword) => label.includes(keyword))) {
        continue;
      }

      const direct = parseMetricValue(label);
      if (direct) {
        return direct;
      }

      const countNodes = Array.from(candidate.querySelectorAll?.("span, div, em, strong, b") || []);
      for (const countNode of countNodes) {
        const value = parseMetricValue(textOf(countNode));
        if (value) {
          return value;
        }
      }
    }

    return "";
  }

  function getActionControlNodes(root) {
    return Array.from(root?.querySelectorAll?.(
      '[class*="like-wrapper"], [class*="LikeWrapper"], [class*="collect-wrapper"], [class*="CollectWrapper"], [class*="chat-wrapper"], [class*="ChatWrapper"], [class*="comment-wrapper"], [class*="CommentWrapper"], [class*="share-wrapper"], [class*="ShareWrapper"]'
    ) || []).filter((node) => !isInNoiseSection(node));
  }

  function collectActionMetricValues(root) {
    if (!root?.querySelectorAll) {
      return [];
    }
    const values = [];
    const elements = Array.from(root.querySelectorAll("button, a, span, div"));
    for (const element of elements) {
      if (isInNoiseSection(element)) {
        continue;
      }
      const text = textOf(element);
      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.className,
        text
      ].filter(Boolean).join(" ");
      if (element.tagName === "div" && getActionControlNodes(element).length >= 2) {
        continue;
      }
      const compactMetric = text.length <= 8 && Boolean(parseMetricValue(text));
      const hasActionHint = /(like|liked|collect|favorite|comment|chat|share|点赞|赞|收藏|评论|分享|转发|wrapper|count|interaction|engage)/i.test(label);
      if (!hasActionHint && !(compactMetric && element.tagName !== "div")) {
        continue;
      }
      const value = parseMetricValue(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`) ||
        (text.length <= 16 ? parseMetricValue(text) : "");
      if (value) {
        values.push(value);
      }
    }
    return values;
  }

  function parseMetricFromActionButton(root, actionNames, actionIndex) {
    if (!root?.querySelectorAll) {
      return "";
    }

    const elements = Array.from(root.querySelectorAll("button, span, div, a"));
    for (const element of elements) {
      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.className,
        textOf(element)
      ].filter(Boolean).join(" ");
      const looksLikeActionControl = /(like|liked|collect|favorite|star|comment|share|forward|点赞|赞|收藏|评论|分享|转发|wrapper|interaction|engage|action|toolbar)/i.test(label);
      if (isInNoiseSection(element) && !looksLikeActionControl) {
        continue;
      }

      const matchesAction = actionNames.some((name) => new RegExp(`(^|[^\\u4e00-\\u9fa5A-Za-z])${name}([^\\u4e00-\\u9fa5A-Za-z]|$)`).test(label));
      if (!matchesAction) {
        const classLabel = String(element.className || "").toLowerCase();
        const actionHints = {
          0: /like|liked/,
          1: /collect|favorite|star/,
          2: /comment|chat/,
          3: /share|forward/
        };
        const hint = actionHints[actionIndex];
        if (!hint || !hint.test(classLabel)) {
          continue;
        }
      }

      const ariaValue = parseMetricValue(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
      if (ariaValue) {
        return ariaValue;
      }

      const ownText = textOf(element);
      if (ownText.length <= 16) {
        const own = parseMetricValue(ownText);
        if (own) {
          return own;
        }
      }

      if (looksLikeActionControl && element.tagName !== "div") {
        continue;
      }

      const siblings = [
        element.nextElementSibling,
        element.previousElementSibling
      ].filter(Boolean);
      for (const sibling of siblings) {
        const value = parseMetricValue(textOf(sibling));
        if (value) {
          return value;
        }
      }

      const parentText = textOf(element.parentElement);
      if (parentText && parentText.length <= 24) {
        const parentValue = parseMetricValue(parentText);
        if (parentValue) {
          return parentValue;
        }
      }
    }

    const orderedValues = collectActionMetricValues(root);
    return orderedValues[actionIndex] || "";
  }

  function scoreActionRoot(candidate) {
    if (!candidate || isInNoiseSection(candidate)) {
      return -1;
    }

    const className = String(candidate.className || "");
    const lowerClassName = className.toLowerCase();
    if (/\bfraction\b/.test(lowerClassName)) {
      return -1;
    }

    const text = textOf(candidate);
    const actionNodes = getActionControlNodes(candidate);
    const metricValues = collectActionMetricValues(candidate);
    let score = 0;

    if (/buttons|engage-bar-style/.test(lowerClassName)) {
      score += 80;
    }
    if (/interact-container/.test(lowerClassName)) {
      score += 70;
    }
    if (/engage-bar|interaction-toolbar/.test(lowerClassName)) {
      score += 45;
    }
    if (/toolbar|footer|bottom|action/.test(lowerClassName)) {
      score += 20;
    }
    if (/interaction-container/.test(lowerClassName)) {
      score += 5;
    }

    score += Math.min(actionNodes.length, 4) * 14;
    score += Math.min(metricValues.length, 4) * 12;
    if (/\d/.test(text) && text.length <= 48) {
      score += 20;
    }
    if (text.length > 180) {
      score -= 80;
    }
    if (text.length > 600) {
      score -= 160;
    }

    return score;
  }

  function findActionRoot(root) {
    if (!root?.querySelectorAll) {
      return null;
    }

    const candidates = Array.from(root.querySelectorAll(
      '[class*="interact"], [class*="Interact"], [class*="action"], [class*="Action"], [class*="toolbar"], [class*="Toolbar"], [class*="footer"], [class*="Footer"], [class*="bottom"], [class*="Bottom"]'
    ));
    const scoredCandidates = candidates
      .map((candidate) => ({
        candidate,
        score: scoreActionRoot(candidate)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);

    return scoredCandidates[0]?.candidate || candidates.find((candidate) => !isInNoiseSection(candidate)) || null;
  }

  const ACTION_METRIC_KEYS = ["likes", "collects", "comments", "shares"];
  const ACTION_CLASS_HINTS = [
    /like|liked/i,
    /collect|favorite|star/i,
    /comment|chat/i,
    /share|forward/i
  ];

  function extractExplicitActionMetric(actionRoot, actionNames, actionIndex) {
    if (!actionRoot?.querySelectorAll) {
      return {
        value: "",
        sawControl: false
      };
    }

    const classHint = ACTION_CLASS_HINTS[actionIndex];
    const elements = Array.from(actionRoot.querySelectorAll("button, span, div, a"));
    let sawControl = false;

    for (const element of elements) {
      const classLabel = String(element.className || "");
      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        classLabel,
        textOf(element)
      ].filter(Boolean).join(" ");
      const matchesActionName = actionNames.some((name) =>
        new RegExp(`(^|[^\\u4e00-\\u9fa5A-Za-z])${name}([^\\u4e00-\\u9fa5A-Za-z]|$)`).test(label)
      );
      const matchesActionClass = Boolean(classHint && classHint.test(classLabel));
      if (!matchesActionName && !matchesActionClass) {
        continue;
      }

      sawControl = true;
      const attributeValue = parseMetricValue(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`);
      if (attributeValue) {
        return {
          value: attributeValue,
          sawControl
        };
      }

      const ownText = textOf(element);
      if (ownText.length <= 16) {
        const ownValue = parseMetricValue(ownText);
        if (ownValue) {
          return {
            value: ownValue,
            sawControl
          };
        }
      }

      const countNodes = Array.from(element.querySelectorAll?.('[class*="count"], span, em, strong, b') || []);
      for (const countNode of countNodes) {
        const countValue = parseMetricValue(textOf(countNode));
        if (countValue) {
          return {
            value: countValue,
            sawControl
          };
        }
      }
    }

    return {
      value: "",
      sawControl
    };
  }

  function extractActionMetricsFromRoot(root) {
    const actionRoot = findActionRoot(root);
    if (!actionRoot) {
      return {
        likes: "",
        collects: "",
        comments: "",
        shares: "",
        evidence: {
          source: "none"
        }
      };
    }

    const orderedValues = collectActionMetricValues(actionRoot);
    const explicitLikes = extractExplicitActionMetric(actionRoot, ["点赞", "赞", "like"], 0);
    const explicitCollects = extractExplicitActionMetric(actionRoot, ["收藏", "collect", "favorite"], 1);
    const explicitComments = extractExplicitActionMetric(actionRoot, ["评论", "comment", "chat"], 2);
    const explicitShares = extractExplicitActionMetric(actionRoot, ["分享", "转发", "share", "forward"], 3);
    const hasExplicitActionControls = [
      explicitLikes,
      explicitCollects,
      explicitComments,
      explicitShares
    ].some((item) => item.sawControl);
    const orderedFallback = (index) => {
      if (hasExplicitActionControls) {
        return "";
      }
      return orderedValues[index] || "";
    };
    const metrics = {
      likes: explicitLikes.value || orderedFallback(0),
      collects: explicitCollects.value || orderedFallback(1),
      comments: explicitComments.value || orderedFallback(2),
      shares: explicitShares.value || orderedFallback(3)
    };

    return {
      ...metrics,
      evidence: {
        source: Object.values(metrics).some(Boolean) ? "dom-action-bar" : "none",
        actionRoot: describeElementForDebug(actionRoot),
        orderedValues: orderedValues.slice(0, 4),
        explicitControls: {
          likes: explicitLikes,
          collects: explicitCollects,
          comments: explicitComments,
          shares: explicitShares
        }
      }
    };
  }

  function parseMetricNearKeywords(root, keywords, selectors = []) {
    const bySelector = parseMetricBySelectors(root, selectors);
    if (bySelector) {
      return bySelector;
    }

    const direct = parseMetricFromText(keywords, root);
    if (direct) {
      return direct;
    }

    const elements = Array.from(root.querySelectorAll("button, span, div, a"));
    for (const element of elements) {
      const around = parseMetricAroundElement(element, keywords);
      if (around) {
        return around;
      }

      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.className,
        textOf(element)
      ].filter(Boolean).join(" ");

      if (!keywords.some((keyword) => label.includes(keyword))) {
        continue;
      }

      const own = parseMetricValue(textOf(element));
      if (own) {
        return own;
      }

      const parentText = textOf(element.parentElement);
      if (parentText && parentText.length < 80) {
        const nearby = parseMetricFromText(keywords, element.parentElement);
        if (nearby) {
          return nearby;
        }
        const loose = parseMetricValue(parentText);
        if (loose) {
          return loose;
        }
      }
    }

    return "";
  }

  function extractMetric(root, keywords, selectors, scriptPatterns = []) {
    const byDom = parseMetricNearKeywords(root, keywords, selectors);
    if (byDom) {
      return byDom;
    }

    const source = getScriptSource(root.ownerDocument || document);
    return firstRegexValue(source, scriptPatterns);
  }

  function extractNoteMetric(root, noteContext, canonicalKeys, buttonNames, actionIndex, actionMetrics = null) {
    const fromStructuredObject = getScopedNoteMetricValue(noteContext, canonicalKeys);
    if (isTrustedCurrentNoteContext(noteContext) && fromStructuredObject !== "") {
      return fromStructuredObject;
    }

    const actionMetricKey = ACTION_METRIC_KEYS[actionIndex];
    const fromActionBar = actionMetricKey ? actionMetrics?.[actionMetricKey] : "";
    if (fromActionBar) {
      return fromActionBar;
    }

    if (fromStructuredObject) {
      return fromStructuredObject;
    }

    return parseMetricFromActionButton(findActionRoot(root) || root, buttonNames, actionIndex);
  }

  function addTagName(tags, value) {
    const tag = decodeLooseValue(value)
      .replace(/\[话题\]$/, "")
      .replace(/^#/, "")
      .trim();
    if (tag && isUsefulText(tag) && !isLikelySearchHintText(tag)) {
      tags.add(tag);
    }
  }

  function extractTagNamesFromObject(object) {
    const tags = new Set();
    if (!object || typeof object !== "object") {
      return [];
    }

    walkJson(object, (candidate) => {
      [
        "tagList",
        "tag_list",
        "hashTags",
        "hash_tags"
      ].forEach((key) => {
        if (!Array.isArray(candidate[key])) {
          return;
        }
        candidate[key].forEach((item) => {
          if (typeof item === "string") {
            addTagName(tags, item);
            return;
          }
          addTagName(tags, item?.name || item?.tagName || item?.tag_name || "");
        });
      });
    });

    return Array.from(tags);
  }

  function extractTagNamesFromBlock(noteBlock) {
    const tags = new Set();
    const tagListPattern = /"(?:tagList|tag_list|hashTags|hash_tags)"\s*:\s*\[([\s\S]*?)\]/g;
    let listMatch = tagListPattern.exec(noteBlock || "");
    while (listMatch) {
      const tagBlock = listMatch[1];
      const patterns = [
        /"name"\s*:\s*"([^"]+)"/g,
        /"tagName"\s*:\s*"([^"]+)"/g,
        /"tag_name"\s*:\s*"([^"]+)"/g
      ];
      patterns.forEach((pattern) => {
        let match = pattern.exec(tagBlock);
        while (match) {
          addTagName(tags, match[1]);
          match = pattern.exec(tagBlock);
        }
      });
      listMatch = tagListPattern.exec(noteBlock || "");
    }
    return Array.from(tags);
  }

  function extractTags(content, root, noteBlock = "", noteContext = null) {
    const tags = new Set();
    extractTagNamesFromObject(noteContext?.object).forEach((tag) => tags.add(tag));
    if (tags.size === 0) {
      extractTagNamesFromBlock(noteBlock).forEach((tag) => tags.add(tag));
    }

    const combined = `${content || ""}\n${noteBlock || ""}`;
    const patterns = [
      /#([^#\s]+?)(?:\[话题\])?#/g,
      /#([\u4e00-\u9fa5A-Za-z0-9_-]+)/g
    ];
    patterns.forEach((pattern) => {
      let match = pattern.exec(combined);
      while (match) {
        addTagName(tags, match[1]);
        match = pattern.exec(combined);
      }
    });

    return Array.from(tags);
  }

  function normalizeNoteContent(content) {
    // Topics belong to the source body as well as the separate tags field.
    return (content || "").trim();
  }

  function getImageUrl(image) {
    return image.currentSrc ||
      image.src ||
      getSrcsetUrl(image.getAttribute("srcset")) ||
      getSrcsetUrl(image.getAttribute("data-srcset")) ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-original") ||
      image.getAttribute("data-lazy") ||
      image.getAttribute("data-xhs-img") ||
      image.getAttribute("data-url") ||
      image.getAttribute("poster") ||
      "";
  }

  function isAvatarOrNoiseImage(image) {
    const raw = `${getImageUrl(image)} ${image.alt || ""} ${image.className || ""}`.toLowerCase();
    if (/avatar|head|profile|user|icon|logo|emoji|comment|grey/.test(raw)) {
      return true;
    }
    if (isInNoiseSection(image)) {
      return true;
    }
    return Boolean(image.closest(
      'a[href*="/user/"], [class*="avatar"], [class*="Avatar"], [class*="author"], [class*="Author"], [class*="user"], [class*="User"], [class*="profile"], [class*="Profile"], [class*="comment"], [class*="Comment"], [class*="recommend"], [class*="Recommend"]'
    ));
  }

  function addContentImageUrl(urls, rawUrl) {
    const normalized = normalizeUrl(rawUrl);
    if (isLikelyContentImageUrl(normalized)) {
      urls.add(normalized);
    }
  }

  function getBackgroundImageUrl(element) {
    const styleText = element?.style?.backgroundImage || element?.getAttribute?.("style") || "";
    const match = String(styleText).match(/url\(["']?([^"')]+)["']?\)/);
    return match?.[1] || "";
  }

  function getDomSlidePosition(node, root) {
    let current = node;
    while (current) {
      const classes = String(current.className || "").split(/\s+/);
      const rawIndex = current.getAttribute?.("data-swiper-slide-index");
      if (classes.includes("swiper-slide") && /^\d+$/.test(rawIndex ?? "")) {
        return {
          index: Number(rawIndex),
          duplicate: classes.includes("swiper-slide-duplicate")
        };
      }
      if (current === root) break;
      current = current.parentElement;
    }
    return { index: null, duplicate: false };
  }

  function collectDomImageUrlsWithEvidence(root, options = {}) {
    const entries = [];
    if (!root?.querySelectorAll) {
      return { urls: [], slideOrderVerified: false };
    }

    const mediaSelector = "picture source, video[poster], [data-src], [data-original], [data-lazy], [data-xhs-img], [data-url], [style*=\"background-image\"]";
    const mediaNodes = [
      ...(root.matches?.("img") ? [root] : []),
      ...(root.matches?.(mediaSelector) ? [root] : []),
      ...Array.from(root.querySelectorAll("img")),
      ...Array.from(root.querySelectorAll(mediaSelector))
    ];
    const seen = new Set();

    mediaNodes.forEach((node) => {
      if (!node || seen.has(node)) {
        return;
      }
      seen.add(node);

      if (isAvatarOrNoiseImage(node)) {
        return;
      }
      if (elementBelongsToDifferentNote(node, options.noteId)) {
        return;
      }
      if (elementHasRelatedCardAncestor(node, options.rootBoundary || root)) {
        return;
      }

      const width = node.naturalWidth || node.width || 0;
      const height = node.naturalHeight || node.height || 0;
      if (width > 0 && height > 0 && (width < 80 || height < 80)) {
        return;
      }

      const url = normalizeUrl(getImageUrl(node) || getBackgroundImageUrl(node));
      if (isLikelyContentImageUrl(url)) {
        entries.push({ url, ...getDomSlidePosition(node, root) });
      }
    });

    // Swiper inserts the last slide's clone before slide 0. DOM order and the
    // currently visible slide therefore cannot identify the published cover.
    const allIndexed = entries.length > 0 && entries.every((entry) => entry.index !== null);
    if (allIndexed) {
      entries.sort((a, b) => a.index - b.index || Number(a.duplicate) - Number(b.duplicate));
    }
    const urls = dedupeImageUrls(entries.map((entry) => entry.url));
    const indices = Array.from(new Set(entries.map((entry) => entry.index)));
    const slideOrderVerified = allIndexed && indices.length === urls.length &&
      indices.every((index, position) => index === position);
    return { urls, slideOrderVerified };
  }

  function collectDomImageUrls(root, options = {}) {
    return collectDomImageUrlsWithEvidence(root, options).urls;
  }

  function getElementRect(element) {
    const target = element?.getBoundingClientRect ? element : element?.parentElement;
    if (!target?.getBoundingClientRect) {
      return null;
    }
    const rect = target.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return rect;
  }

  function getViewportSize() {
    const doc = typeof document !== "undefined" ? document.documentElement : null;
    return {
      width: Math.max(
        Number(typeof window !== "undefined" ? window.innerWidth : 0) || 0,
        Number(doc?.clientWidth) || 0
      ),
      height: Math.max(
        Number(typeof window !== "undefined" ? window.innerHeight : 0) || 0,
        Number(doc?.clientHeight) || 0
      )
    };
  }

  function getVisibleImageScore(rect) {
    const viewport = getViewportSize();
    const viewportWidth = viewport.width || rect.right || 0;
    const viewportHeight = viewport.height || rect.bottom || 0;
    const visibleLeft = Math.max(0, rect.left);
    const visibleRight = Math.min(viewportWidth, rect.right);
    const visibleTop = Math.max(0, rect.top);
    const visibleBottom = Math.min(viewportHeight, rect.bottom);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const visibleArea = visibleWidth * visibleHeight;
    const totalArea = rect.width * rect.height;
    const visibleRatio = totalArea > 0 ? visibleArea / totalArea : 0;
    const viewportCenterX = viewportWidth ? viewportWidth / 2 : rect.left + rect.width / 2;
    const viewportCenterY = viewportHeight ? viewportHeight / 2 : rect.top + rect.height / 2;
    const elementCenterX = rect.left + rect.width / 2;
    const elementCenterY = rect.top + rect.height / 2;
    const centerDistance = Math.abs(elementCenterX - viewportCenterX) + Math.abs(elementCenterY - viewportCenterY);
    return {
      visibleArea,
      visibleRatio,
      centerDistance
    };
  }

  function collectVisibleDomImageUrls(root, options = {}) {
    if (!root?.querySelectorAll) {
      return [];
    }

    const mediaSelector = "picture source, video[poster], [data-src], [data-original], [data-lazy], [data-xhs-img], [data-url], [style*=\"background-image\"]";
    const mediaNodes = [
      ...(root.matches?.("img") ? [root] : []),
      ...(root.matches?.(mediaSelector) ? [root] : []),
      ...Array.from(root.querySelectorAll("img")),
      ...Array.from(root.querySelectorAll(mediaSelector))
    ];
    const seenNodes = new Set();
    const entries = [];

    mediaNodes.forEach((node, domIndex) => {
      if (!node || seenNodes.has(node)) {
        return;
      }
      seenNodes.add(node);

      if (isAvatarOrNoiseImage(node)) {
        return;
      }
      if (elementBelongsToDifferentNote(node, options.noteId)) {
        return;
      }
      if (elementHasRelatedCardAncestor(node, options.rootBoundary || root)) {
        return;
      }

      const width = node.naturalWidth || node.width || 0;
      const height = node.naturalHeight || node.height || 0;
      if (width > 0 && height > 0 && (width < 80 || height < 80)) {
        return;
      }

      const url = normalizeUrl(getImageUrl(node) || getBackgroundImageUrl(node));
      if (!isLikelyContentImageUrl(url)) {
        return;
      }

      const rect = getElementRect(node);
      if (!rect) {
        return;
      }
      const score = getVisibleImageScore(rect);
      if (score.visibleRatio < 0.45 || score.visibleArea < 6400) {
        return;
      }

      entries.push({
        url,
        domIndex,
        visibleArea: score.visibleArea,
        visibleRatio: score.visibleRatio,
        centerDistance: score.centerDistance
      });
    });

    entries.sort((left, right) => (
      right.visibleRatio - left.visibleRatio ||
      right.visibleArea - left.visibleArea ||
      left.centerDistance - right.centerDistance ||
      left.domIndex - right.domIndex
    ));

    return dedupeImageUrls(entries.map((entry) => entry.url));
  }

  function collectPerformanceImageUrls() {
    if (typeof performance === "undefined" || !performance.getEntriesByType) {
      return [];
    }

    return performance.getEntriesByType("resource")
      .map((entry) => entry.name || "")
      .filter(isLikelyContentImageUrl)
      .map(normalizeUrl)
      .slice(0, 12);
  }

  const REAL_VIDEO_SIGNAL_SELECTOR = 'video, [class*="xgplayer"], [class*="Xgplayer"], [class*="video-player"], [class*="VideoPlayer"], [class*="videoPlayer"], [class*="video"], [class*="Video"]';

  function hasRealVideoSignal(element) {
    if (!element) {
      return false;
    }
    return Boolean(element.matches?.(REAL_VIDEO_SIGNAL_SELECTOR) || element.querySelector?.(REAL_VIDEO_SIGNAL_SELECTOR));
  }

  function isMediaContainer(element) {
    const className = String(element?.className || "");
    return /note[-_]?scroller|noteScroller|swiper|slider|carousel|media|image|photo|video|xgplayer/i.test(className) && !isInNoiseSection(element);
  }

  const MEDIA_ROOT_SELECTOR = 'video, [class*="note-scroller"], [class*="noteScroller"], [class*="swiper"], [class*="Swiper"], [class*="slider"], [class*="Slider"], [class*="carousel"], [class*="Carousel"], [class*="media"], [class*="Media"], [class*="image"], [class*="Image"], [class*="photo"], [class*="Photo"], [class*="video"], [class*="Video"], [class*="player"], [class*="Player"], [class*="xgplayer"], [style*="background-image"]';

  function scoreMediaRoot(element) {
    if (!element || isInNoiseSection(element)) {
      return -1;
    }
    const className = String(element.className || "");
    let score = 0;
    if (/note[-_]?scroller|noteScroller/i.test(className)) {
      score += 120;
    }
    if (/swiper|slider|carousel/i.test(className)) {
      score += 70;
    }
    if (/image|photo/i.test(className)) {
      score += 50;
    }
    if (/media/i.test(className)) {
      score += 10;
    }
    if (/video|xgplayer/i.test(className)) {
      score += 65;
    }
    if (getBackgroundImageUrl(element)) {
      score += 80;
    }
    score += Math.min(collectDomImageUrls(element).length, 4) * 30;
    if (hasRealVideoSignal(element)) {
      score += 25;
    }
    return score;
  }

  function findMediaRoot(root) {
    if (!root?.querySelectorAll && !root?.querySelector) {
      return null;
    }
    const candidates = Array.from(root.querySelectorAll?.(MEDIA_ROOT_SELECTOR) || []);
    const fallback = root.querySelector?.(MEDIA_ROOT_SELECTOR);
    if (fallback && !candidates.includes(fallback)) {
      candidates.push(fallback);
    }
    if (isMediaContainer(root)) {
      candidates.push(root);
    }
    return candidates
      .map((candidate) => ({
        candidate,
        score: scoreMediaRoot(candidate)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.candidate || null;
  }

  function limitImageUrlsForNoteType(urls, noteType) {
    const uniqueUrls = dedupeImageUrls(Array.from(new Set((urls || []).filter(Boolean))));
    if (noteType === "视频") {
      return uniqueUrls.slice(0, 1);
    }
    return uniqueUrls.slice(0, MAX_NOTE_IMAGE_COUNT);
  }

  function hasMultiImageEvidence(root, mediaRoot, noteObject, structuredCount, domCount, noteId = "") {
    if (structuredCount <= 1) {
      return false;
    }

    if (isSearchResultSourceUrl() && hasTypedStructuredMultiImageListEvidence(noteObject, noteId)) {
      return true;
    }

    const countValue = extractDirectObjectValueByKeys(noteObject, [
      "imageCount",
      "image_count",
      "imagesCount",
      "images_count",
      "picCount",
      "pic_count",
      "picNum",
      "pic_num",
      "imageNum",
      "image_num"
    ]);
    if (Number.parseInt(countValue, 10) > 1) {
      return true;
    }

    const mediaClassName = String(mediaRoot?.className || "");
    if (/note[-_]?scroller|noteScroller|swiper|slider|carousel/i.test(mediaClassName)) {
      return true;
    }

    if (isLivePhotoNote(root)) {
      return true;
    }

    if (domCount > 1 && mediaRoot) {
      return true;
    }

    return Boolean(root?.querySelector?.(
      '[class*="swiper-pagination"], [class*="pagination"], [class*="indicator"], [class*="Indicator"], [class*="dot"], [class*="Dot"]'
    ));
  }

  function mergeImageUrls(primaryUrls, fallbackUrls) {
    const urls = [];
    (primaryUrls || []).forEach((url) => urls.push(url));
    (fallbackUrls || []).forEach((url) => urls.push(url));
    return dedupeImageUrls(urls);
  }

  function findImageUrlIndexByKey(urls, targetUrl) {
    const targetKey = getImageDedupeKey(targetUrl);
    if (!targetKey) {
      return -1;
    }
    return (urls || []).findIndex((url) => getImageDedupeKey(url) === targetKey);
  }

  function alignStructuredImageUrlsToAnchor(structuredUrls, anchorUrls, source) {
    const urls = dedupeImageUrls(structuredUrls);
    const evidence = {
      source,
      anchorUrl: "",
      anchorIndex: -1,
      matched: false,
      applied: false,
      ignoredForPublishOrder: true
    };
    const anchors = dedupeImageUrls(anchorUrls);
    for (const anchorUrl of anchors) {
      const anchorIndex = findImageUrlIndexByKey(urls, anchorUrl);
      if (anchorIndex < 0) {
        continue;
      }
      evidence.anchorUrl = anchorUrl;
      evidence.anchorIndex = anchorIndex;
      evidence.matched = true;
      return {
        urls,
        evidence
      };
    }

    return { urls, evidence };
  }

  function rotateLeadingImageToTail(urls, reason) {
    const orderedUrls = dedupeImageUrls(urls);
    const evidence = {
      source: "leading-tail-clone-fix",
      reason,
      applied: false,
      movedUrl: "",
      imageCount: orderedUrls.length
    };
    if (orderedUrls.length < 2) {
      return { urls: orderedUrls, evidence };
    }
    evidence.applied = true;
    evidence.movedUrl = orderedUrls[0];
    return {
      urls: orderedUrls.slice(1).concat(orderedUrls.slice(0, 1)),
      evidence
    };
  }

  function normalizeLeadingTailCloneUrls(urls, options = {}) {
    const orderedUrls = dedupeImageUrls(urls);
    const evidence = {
      source: "leading-tail-clone-fix",
      reason: "",
      applied: false,
      movedUrl: "",
      imageCount: orderedUrls.length
    };
    if (options.noteType === "视频" || orderedUrls.length < 2) {
      return { urls: orderedUrls, evidence };
    }
    if (options.selectedIsPreferredPublishList) {
      evidence.reason = "preferred-publish-list";
      return { urls: orderedUrls, evidence };
    }

    const selectedKey = options.selectedKey || "";
    const structuredOrder = options.structuredOrderAnchor || {};
    const secondAnchors = dedupeImageUrls([
      ...(options.entryCoverUrls || []),
      ...(options.visibleDomCoverUrls || []),
      ...(options.structuredCoverUrls || [])
    ]);
    const hasSecondAnchor = secondAnchors.some((anchorUrl) => findImageUrlIndexByKey(orderedUrls, anchorUrl) === 1);
    if (hasSecondAnchor) {
      return rotateLeadingImageToTail(orderedUrls, "second-anchor");
    }

    const selectedLooksLikeCarouselState = /^(mediaList|media_list|mediaInfos|media_infos)$/.test(selectedKey);
    if (
      selectedLooksLikeCarouselState &&
      (structuredOrder.source === "structured-list-order" || structuredOrder.source === "video-list-order" || !structuredOrder.source)
    ) {
      return rotateLeadingImageToTail(orderedUrls, `carousel-state-list:${selectedKey}`);
    }

    return { urls: orderedUrls, evidence };
  }

  function collectImageUrlsWithEvidence(root, noteBlock = "", noteContext = null, noteType = "图文", noteId = "", options = {}) {
    const evidence = {
      mediaRoot: null,
      structuredUrls: [],
      domUrls: [],
      visibleDomCoverUrls: [],
      orderedStructuredUrls: [],
      finalUrls: [],
      leadingTailCloneFix: null,
      policy: "",
      multiImageEvidence: false,
      entryCoverUrls: []
    };
    const entryCoverUrls = dedupeImageUrls(options.entryCoverUrls || getRememberedEntryCoverUrls(noteId));
    evidence.entryCoverUrls = entryCoverUrls;

    const mediaRoot = findMediaRoot(root);
    evidence.mediaRoot = describeElementForDebug(mediaRoot);
    let domResult = { urls: [], slideOrderVerified: false };
    if (mediaRoot) {
      domResult = collectDomImageUrlsWithEvidence(mediaRoot, { noteId, rootBoundary: mediaRoot });
    } else if (root && root !== document.body && root !== document.documentElement) {
      domResult = collectDomImageUrlsWithEvidence(root, { noteId, rootBoundary: root });
    }
    const domUrls = domResult.urls;
    evidence.domUrls = domUrls;
    evidence.domSlideOrderVerified = domResult.slideOrderVerified;
    const visibleDomCoverUrls = mediaRoot ?
      collectVisibleDomImageUrls(mediaRoot, { noteId, rootBoundary: mediaRoot }) :
      collectVisibleDomImageUrls(root, { noteId, rootBoundary: root }).slice(0, 2);
    evidence.visibleDomCoverUrls = visibleDomCoverUrls;
    const domAnchorUrls = dedupeImageUrls(visibleDomCoverUrls.concat(domUrls));

    const structuredResult = collectStructuredImageUrlsFromCurrentNote(noteContext?.object, {
      noteId: noteContext?.object ? noteId : "",
      noteType,
      skipVideoFields: noteType === "图文",
      preferSingleBestList: noteType === "图文",
      domAnchorUrls,
      visibleDomCoverUrls,
      entryCoverUrls
    });
    const structuredUrls = structuredResult.urls;
    evidence.structuredUrls = structuredUrls;
    evidence.structured = structuredResult.evidence;
    const structuredCoverResult = structuredResult.selectedCoverUrls?.length ?
      {
        urls: structuredResult.selectedCoverUrls,
        evidence: {
          source: "selected-structured-image-list"
        }
      } :
      collectStructuredCoverUrlsFromCurrentNote(noteContext?.object, {
        noteId: noteContext?.object ? noteId : "",
        noteType
      });
    evidence.structuredCoverUrls = structuredCoverResult.urls;
    evidence.structuredCover = structuredCoverResult.evidence;

    const hasStructuredMultiOrder = noteType === "图文" &&
      (
        structuredUrls.length > 1 ||
        hasMultiImageEvidence(root, mediaRoot, noteContext?.object, structuredUrls.length, domUrls.length, noteId)
      );
    evidence.multiImageEvidence = hasStructuredMultiOrder;
    let orderedStructuredUrls = structuredUrls;
    evidence.structuredOrderAnchor = structuredResult.evidence?.singleBestList?.order || {
      source: "imageList-publish-order",
      matched: false,
      applied: false
    };
    evidence.orderedStructuredUrls = orderedStructuredUrls;

    const hasPreferredPublishList = Boolean(structuredResult.evidence?.singleBestList?.selectedIsPreferredPublishList);
    const useDomSlideOrder = noteType === "图文" && !hasPreferredPublishList &&
      domResult.slideOrderVerified && structuredUrls.every((url) => findImageUrlIndexByKey(domUrls, url) >= 0);
    let urls = [];
    if (noteType === "视频") {
      urls = mergeImageUrls(domUrls, structuredUrls);
      evidence.policy = "video-dom-first";
    } else if (useDomSlideOrder) {
      urls = domUrls;
      evidence.policy = "dom-slide-index-order";
    } else if (hasStructuredMultiOrder) {
      urls = mergeImageUrls(orderedStructuredUrls, domUrls);
      evidence.policy = "structured-publish-order";
    } else if (structuredUrls.length > 0 && structuredUrls.length <= 1) {
      urls = mergeImageUrls(structuredUrls, domUrls);
      evidence.policy = "single-structured-image";
    } else if (domUrls.length > 0) {
      urls = mergeImageUrls(mediaRoot && domUrls.length > 1 ? domUrls : domUrls.slice(0, 1), []);
      evidence.policy = mediaRoot && domUrls.length > 1 ? "dom-media-order" : "single-dom-cover";
    } else if (structuredUrls.length > 0) {
      urls = mergeImageUrls(structuredUrls.slice(0, 1), []);
      evidence.policy = "single-structured-fallback";
    }

    const normalizedTailClone = useDomSlideOrder ? {
      urls,
      evidence: { source: "dom-slide-index-order", applied: false }
    } : normalizeLeadingTailCloneUrls(urls, {
      noteType,
      selectedKey: structuredResult.evidence?.singleBestList?.selectedKey || "",
      selectedIsPreferredPublishList: structuredResult.evidence?.singleBestList?.selectedIsPreferredPublishList || false,
      structuredOrderAnchor: evidence.structuredOrderAnchor,
      entryCoverUrls,
      visibleDomCoverUrls,
      structuredCoverUrls: structuredCoverResult.urls
    });
    urls = normalizedTailClone.urls;
    evidence.leadingTailCloneFix = normalizedTailClone.evidence;

    const source = noteBlock || "";
    const imagePatterns = [
      /"urlDefault"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"url_default"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"urlPre"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"url_pre"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"url"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"masterUrl"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"master_url"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"imageUrl"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"image_url"\s*:\s*"([^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g,
      /"(https?:\\?\/\\?\/[^"]*(?:xhscdn|sns-webpic|sns-img|ci\.xiaohongshu)[^"]*)"/g
    ];
    if (urls.length === 0 && source && !noteContext?.object) {
      const blockUrls = [];
      imagePatterns.forEach((pattern) => {
        let match = pattern.exec(source);
        while (match) {
          const normalized = normalizeUrl(match[1]);
          if (isLikelyContentImageUrl(normalized)) {
            blockUrls.push(normalized);
          }
          match = pattern.exec(source);
        }
      });
      urls = dedupeImageUrls(blockUrls);
      evidence.policy = "note-block-fallback";
    }

    if (urls.length === 0) {
      const metaImages = [
        metaContent(['meta[property="og:image"]']),
        metaContent(['meta[name="twitter:image"]'])
      ];
      const metaUrls = [];
      metaImages.forEach((url) => {
        const normalized = normalizeUrl(url);
        if (isLikelyContentImageUrl(normalized)) {
          metaUrls.push(normalized);
        }
      });
      urls = dedupeImageUrls(metaUrls);
      evidence.policy = "meta-fallback";
    }

    evidence.finalUrls = limitImageUrlsForNoteType(urls, noteType);
    return {
      urls: evidence.finalUrls,
      evidence
    };
  }

  function collectImageUrls(root, noteBlock = "", noteContext = null, noteType = "图文", noteId = "") {
    return collectImageUrlsWithEvidence(root, noteBlock, noteContext, noteType, noteId).urls;
  }

  function isLivePhotoNote(root) {
    const text = root.innerText || "";
    if (/\bLIVE\b|实况|live图|Live图/.test(text)) {
      return true;
    }

    return Boolean(root.querySelector(
      '[class*="live-photo"], [class*="livePhoto"], [class*="LivePhoto"], [class*="livephoto"], [aria-label*="LIVE"], [aria-label*="实况"], [title*="LIVE"], [title*="实况"]'
    ));
  }

  function getStructuredNoteType(noteContext, noteBlock) {
    const typeKeys = [
      "type",
      "noteType",
      "note_type",
      "mediaType",
      "media_type",
      "cardType",
      "card_type"
    ];
    const fromObject = extractDirectObjectValueByKeys(noteContext?.object, typeKeys);
    const rawType = fromObject || (!noteContext ? extractValueByKeys(noteBlock, typeKeys) : "");
    const normalized = String(rawType || "").toLowerCase();
    if (/video|视频/.test(normalized)) {
      return "视频";
    }
    if (/image|normal|图文|photo/.test(normalized)) {
      return "图文";
    }
    return "";
  }

  function hasVideoSignalInObject(object) {
    if (!object || typeof object !== "object") {
      return false;
    }

    const directVideoKeys = [
      "video",
      "videoInfo",
      "video_info",
      "videoUrl",
      "video_url",
      "videoId",
      "video_id",
      "videoCover",
      "videoCoverUrl",
      "video_cover",
      "video_cover_url"
    ];

    return directVideoKeys.some((key) => {
      const value = object[key];
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return Boolean(value);
    });
  }

  function hasVideoSignalInBlock(noteBlock) {
    return /"type"\s*:\s*"video"|"noteType"\s*:\s*"video"|"video(?:Info|Url|Id|Cover)"\s*:|"video_(?:info|url|id|cover)"\s*:/.test(noteBlock || "");
  }

  function hasVideoSignalInDom(root) {
    const mediaRoot = findMediaRoot(root);
    return hasRealVideoSignal(mediaRoot) || (
      !mediaRoot && root !== document.body && root !== document.documentElement && hasRealVideoSignal(root)
    );
  }

  function hasImageSignalInDom(root) {
    const mediaRoot = findMediaRoot(root);
    return collectDomImageUrls(mediaRoot).length > 0 || (
      root !== document.body &&
      root !== document.documentElement &&
      collectDomImageUrls(root).length > 0
    );
  }

  function extractCarouselImageCount(root, mediaRoot) {
    const sources = [
      textOf(mediaRoot),
      textOf(root)
    ];
    for (const text of sources) {
      const match = String(text || "").match(/(?:^|[^\d])\d+\s*\/\s*(\d+)(?:[^\d]|$)/);
      const count = Number.parseInt(match?.[1] || "", 10);
      if (Number.isFinite(count) && count > 1) {
        return count;
      }
    }
    return 0;
  }

  function hasDomMultiImageCarouselEvidence(root, mediaRoot, domImageCount) {
    if (!mediaRoot || hasRealVideoSignal(mediaRoot)) {
      return false;
    }

    const mediaClassName = String(mediaRoot.className || "");
    const looksLikeCarousel = /note[-_]?scroller|noteScroller|swiper|slider|carousel|image|photo/i.test(mediaClassName);
    if (looksLikeCarousel && domImageCount > 1) {
      return true;
    }

    return extractCarouselImageCount(root, mediaRoot) > 1 && domImageCount > 0;
  }

  function isRedVideoUrl() {
    return /\/red_video\/[A-Za-z0-9_-]+(?:[/?#]|$)/.test(location.href || "");
  }

  function detectNoteTypeWithEvidence(root, noteContext = null, noteBlock = "", noteId = "") {
    if (isRedVideoUrl()) {
      return {
        value: "视频",
        evidence: {
          source: "red-video-url"
        }
      };
    }
    if (isLivePhotoNote(root)) {
      return {
        value: "图文",
        evidence: {
          source: "live-photo"
        }
      };
    }
    const structuredType = getStructuredNoteType(noteContext, noteBlock);
    const domHasVideo = hasVideoSignalInDom(root);
    const domHasImage = hasImageSignalInDom(root);
    const objectHasVideo = hasVideoSignalInObject(noteContext?.object);
    const blockHasVideo = !noteContext && hasVideoSignalInBlock(noteBlock);
    const structuredImageCount = collectStructuredImageUrlsFromCurrentNote(noteContext?.object, {
      noteId,
      noteType: "图文",
      skipVideoFields: true
    }).urls.length;
    const structuredPublishSelection = selectBestStructuredImageList(noteContext?.object, {
      noteId,
      noteType: "图文",
      skipVideoFields: true,
      preferSingleBestList: true,
      entryCoverUrls: getRememberedEntryCoverUrls(noteId)
    });
    const hasPreferredPublishSequence = structuredPublishSelection.urls.length > 1 &&
      structuredPublishSelection.evidence?.selectedIsPreferredPublishList;
    const hasTypedStructuredMultiImages = hasTypedStructuredMultiImageListEvidence(noteContext?.object, noteId);
    const mediaRoot = findMediaRoot(root);
    const mediaDomImageCount = collectDomImageUrls(mediaRoot, { noteId, rootBoundary: mediaRoot || root }).length;
    const mediaClassName = String(mediaRoot?.className || "");
    const mediaRootLooksImageCarousel = Boolean(
      domHasImage &&
      !domHasVideo &&
      /note[-_]?scroller|noteScroller|swiper|slider|carousel|image|photo/i.test(mediaClassName)
    );
    const domMultiImageCarousel = !domHasVideo && hasDomMultiImageCarouselEvidence(root, mediaRoot, mediaDomImageCount);

    if (domHasVideo && structuredType === "视频") {
      return {value: "视频", evidence: {source: "current-video-with-structured-type", structuredType, domHasVideo}};
    }

    if (hasPreferredPublishSequence) {
      return {
        value: "图文",
        evidence: {
          source: "preferred-structured-publish-sequence",
          structuredType,
          domHasImage,
          domHasVideo,
          objectHasVideo,
          structuredImageCount,
          selectedImageList: structuredPublishSelection.evidence
        }
      };
    }

    if (isTrustedCurrentNoteContext(noteContext) && structuredType) {
      return {
        value: structuredType,
        evidence: {
          source: "trusted-structured-type",
          structuredType,
          domHasImage,
          domHasVideo,
          objectHasVideo,
          structuredImageCount
        }
      };
    }

    if (domMultiImageCarousel) {
      return {
        value: "图文",
        evidence: {
          source: "dom-multi-image-carousel",
          structuredType,
          domHasImage,
          domHasVideo,
          objectHasVideo,
          mediaDomImageCount,
          structuredImageCount,
          mediaRoot: describeElementForDebug(mediaRoot)
        }
      };
    }

    if (
      !domHasVideo &&
      (
        (isSearchResultSourceUrl() && structuredImageCount > 1 && hasTypedStructuredMultiImages) ||
        (structuredType === "图文" && (domHasImage || structuredImageCount > 0)) ||
        (structuredImageCount > 1 && (structuredType !== "视频" || mediaRootLooksImageCarousel))
      )
    ) {
      return {
        value: "图文",
        evidence: {
          source: "structured-current-image-sequence",
          structuredType,
          domHasImage,
          domHasVideo,
          objectHasVideo,
          structuredImageCount,
          hasTypedStructuredMultiImages,
          mediaRoot: describeElementForDebug(mediaRoot)
        }
      };
    }

    if (structuredType === "图文" && domHasImage) {
      return {
        value: "图文",
        evidence: {
          source: "structured-image-with-dom-image",
          structuredType,
          domHasImage,
          domHasVideo,
          objectHasVideo,
          structuredImageCount
        }
      };
    }

    if (domHasVideo) {
      return {
        value: "视频",
        evidence: {
          source: "dom-video",
          structuredType,
          domHasImage
        }
      };
    }

    if (structuredType === "视频") {
      return {
        value: "视频",
        evidence: {
          source: "structured-type",
          structuredType,
          domHasImage
        }
      };
    }

    if ((objectHasVideo || blockHasVideo) && !domHasImage) {
      return {
        value: "视频",
        evidence: {
          source: objectHasVideo ? "structured-video-signal" : "block-video-signal",
          structuredType,
          domHasImage
        }
      };
    }

    return {
      value: "图文",
      evidence: {
        source: "default-image",
        structuredType,
        domHasImage,
        objectHasVideo
      }
    };
  }

  function detectNoteType(root, noteContext = null, noteBlock = "", noteId = "") {
    return detectNoteTypeWithEvidence(root, noteContext, noteBlock, noteId).value;
  }

  function normalizeStructuredText(value) {
    return decodeLooseValue(value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function isUsefulStructuredText(value, maxLength = 2000) {
    const text = normalizeStructuredText(value);
    return Boolean(text && text.length <= maxLength && !isLikelySearchHintText(text));
  }

  function extractStructuredTextValue(noteContext, noteBlock, keys, maxLength = 2000) {
    const direct = normalizeStructuredText(extractDirectObjectValueByKeys(noteContext?.object, keys));
    if (isUsefulStructuredText(direct, maxLength)) {
      return direct;
    }

    const nested = normalizeStructuredText(extractObjectValueByKeys(noteContext?.object, keys));
    if (isUsefulStructuredText(nested, maxLength)) {
      return nested;
    }

    const parent = normalizeStructuredText(extractDirectObjectValueByKeys(noteContext?.parent, keys));
    if (isUsefulStructuredText(parent, maxLength)) {
      return parent;
    }

    const fromBlock = normalizeStructuredText(extractValueByKeys(noteBlock, keys));
    if (isUsefulStructuredText(fromBlock, maxLength)) {
      return fromBlock;
    }

    return "";
  }

  function firstStructuredObjectByKeys(object, keys) {
    if (!object || typeof object !== "object") {
      return null;
    }
    for (const key of keys) {
      if (isPlainObject(object[key])) {
        return object[key];
      }
    }
    return null;
  }

  function getCurrentNoteContainerObjects(noteContext) {
    const objects = [];
    const seen = new Set();
    function add(value) {
      if (!isPlainObject(value) || seen.has(value)) {
        return;
      }
      seen.add(value);
      objects.push(value);
    }
    add(noteContext?.object);
    CURRENT_NOTE_CONTAINER_KEYS.forEach((key) => {
      add(noteContext?.object?.[key]);
      add(noteContext?.parent?.[key]);
    });
    add(noteContext?.parent);
    return objects;
  }

  function getStructuredUserObject(noteContext) {
    const userObjectKeys = [
      "user",
      "userInfo",
      "user_info",
      "author",
      "authorInfo",
      "author_info",
      "owner",
      "ownerInfo",
      "owner_info"
    ];
    for (const candidate of getCurrentNoteContainerObjects(noteContext)) {
      const userObject = firstStructuredObjectByKeys(candidate, userObjectKeys);
      if (userObject) {
        return userObject;
      }
    }
    return null;
  }

  function extractStructuredAuthor(noteContext, noteBlock) {
    const userObject = getStructuredUserObject(noteContext);
    const userAuthorKeys = [
      "nickname",
      "nickName",
      "nick_name",
      "userName",
      "user_name",
      "authorName",
      "author_name",
      "name"
    ];
    const authorKeys = userAuthorKeys.filter((key) => key !== "name");
    const fromUserObject = normalizeStructuredText(extractDirectObjectValueByKeys(userObject, userAuthorKeys));
    if (isUsefulText(fromUserObject)) {
      return fromUserObject;
    }

    const fromObject = normalizeStructuredText(extractDirectObjectValueByKeys(noteContext?.object, authorKeys));
    if (isUsefulText(fromObject)) {
      return fromObject;
    }

    for (const candidate of getCurrentNoteContainerObjects(noteContext)) {
      const fromCandidate = normalizeStructuredText(extractDirectObjectValueByKeys(candidate, authorKeys));
      if (isUsefulText(fromCandidate)) {
        return fromCandidate;
      }
    }

    return "";
  }

  function extractStructuredUserId(noteContext, noteBlock) {
    const noteUserIdKeys = [
      "userId",
      "user_id",
      "authorId",
      "author_id",
      "ownerId",
      "owner_id"
    ];
    const userObjectIdKeys = [
      "userId",
      "user_id",
      "authorId",
      "author_id",
      "ownerId",
      "owner_id",
      "id"
    ];
    const userObject = getStructuredUserObject(noteContext);
    const direct = extractDirectObjectValueByKeys(noteContext?.object, noteUserIdKeys);
    if (direct) {
      return direct;
    }
    const fromUserObject = extractDirectObjectValueByKeys(userObject, userObjectIdKeys);
    if (fromUserObject) {
      return fromUserObject;
    }
    for (const candidate of getCurrentNoteContainerObjects(noteContext)) {
      const fromCandidate = extractDirectObjectValueByKeys(candidate, noteUserIdKeys);
      if (fromCandidate) {
        return fromCandidate;
      }
    }
    return firstRegexValue(noteBlock, [
      /"userId"\s*:\s*"([^"]+)"/,
      /"user_id"\s*:\s*"([^"]+)"/,
      /"authorId"\s*:\s*"([^"]+)"/,
      /"author_id"\s*:\s*"([^"]+)"/,
      /"(?:user|userInfo|user_info|author|authorInfo|author_info)"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/
    ]);
  }

  function parseDateLikeValue(value) {
    if (value === undefined || value === null || value === "") {
      return NaN;
    }
    const raw = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      let timestamp = Number(raw);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return NaN;
      }
      if (timestamp < 100000000000) {
        timestamp *= 1000;
      } else if (timestamp > 100000000000000) {
        timestamp = Math.round(timestamp / 1000);
      }
      return timestamp;
    }

    const now = Date.now();
    const today = new Date(now);
    const dayMs = 24 * 60 * 60 * 1000;
    const timeParts = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const parsedHour = timeParts ? Number(timeParts[1]) : 0;
    const parsedMinute = timeParts ? Number(timeParts[2]) : 0;
    const parsedSecond = timeParts ? Number(timeParts[3] || 0) : 0;
    const buildLocalTimestamp = (year, month, day, hour = 0, minute = 0, second = 0) => {
      const date = new Date(year, month - 1, day, hour, minute, second);
      if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day ||
        date.getHours() !== hour ||
        date.getMinutes() !== minute
      ) {
        return NaN;
      }
      return date.getTime();
    };

    if (/刚刚|刚才/.test(raw)) {
      return now;
    }
    if (/今天/.test(raw)) {
      return buildLocalTimestamp(
        today.getFullYear(),
        today.getMonth() + 1,
        today.getDate(),
        parsedHour,
        parsedMinute,
        parsedSecond
      );
    }
    if (/昨天/.test(raw)) {
      const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      return buildLocalTimestamp(
        yesterday.getFullYear(),
        yesterday.getMonth() + 1,
        yesterday.getDate(),
        parsedHour,
        parsedMinute,
        parsedSecond
      );
    }
    if (/前天/.test(raw)) {
      const beforeYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
      return buildLocalTimestamp(
        beforeYesterday.getFullYear(),
        beforeYesterday.getMonth() + 1,
        beforeYesterday.getDate(),
        parsedHour,
        parsedMinute,
        parsedSecond
      );
    }

    const relativeDays = raw.match(/(\d+)\s*天前/);
    if (relativeDays) {
      return now - Number(relativeDays[1]) * dayMs;
    }
    const relativeHours = raw.match(/(\d+)\s*小时前/);
    if (relativeHours) {
      return now - Number(relativeHours[1]) * 60 * 60 * 1000;
    }
    const relativeMinutes = raw.match(/(\d+)\s*分钟前/);
    if (relativeMinutes) {
      return now - Number(relativeMinutes[1]) * 60 * 1000;
    }

    const normalized = raw
      .replace(/[年月.]/g, "/")
      .replace(/日/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const fullDate = normalized.match(/(?:^|[^\d])(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (fullDate) {
      return buildLocalTimestamp(
        Number(fullDate[1]),
        Number(fullDate[2]),
        Number(fullDate[3]),
        Number(fullDate[4] || 0),
        Number(fullDate[5] || 0),
        Number(fullDate[6] || 0)
      );
    }

    const partialDate = normalized.match(/(?:^|[^\d])(\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (partialDate) {
      const month = Number(partialDate[1]);
      const day = Number(partialDate[2]);
      const hour = Number(partialDate[3] || 0);
      const minute = Number(partialDate[4] || 0);
      const second = Number(partialDate[5] || 0);
      let timestamp = buildLocalTimestamp(today.getFullYear(), month, day, hour, minute, second);
      if (Number.isFinite(timestamp) && timestamp > now + dayMs) {
        timestamp = buildLocalTimestamp(today.getFullYear() - 1, month, day, hour, minute, second);
      }
      return timestamp;
    }

    return Date.parse(normalized);
  }

  function extractPublishDateInMilliseconds(root, noteContext, noteBlock) {
    const dateKeys = [
      "publishTime",
      "publish_time",
      "createTime",
      "create_time",
      "createdTime",
      "created_time",
      "createdAt",
      "created_at",
      "updateTime",
      "update_time",
      "lastUpdateTime",
      "last_update_time",
      "timestamp",
      "time",
      "date"
    ];
    const structuredDate = extractDirectObjectValueByKeys(noteContext?.object, dateKeys) ||
      extractObjectValueByKeys(noteContext?.object, dateKeys) ||
      extractDirectObjectValueByKeys(noteContext?.parent, dateKeys) ||
      extractValueByKeys(noteBlock, dateKeys);
    const structuredTimestamp = parseDateLikeValue(structuredDate);
    if (Number.isFinite(structuredTimestamp)) {
      return structuredTimestamp;
    }

    const dateText = firstText([
      ".date",
      ".publish-time",
      '[class*="date"]',
      '[class*="time"]'
    ], root);
    const domTimestamp = parseDateLikeValue(dateText);
    return Number.isFinite(domTimestamp) ? domTimestamp : null;
  }

  function getProfileUserIdFromUrl(url) {
    const match = String(url || "").match(/\/user\/profile\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }

  function cleanAuthorCandidateText(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^(作者|用户)[:：]\s*/, "")
      .replace(/\s*(关注|已关注)$\s*/, "")
      .trim();
    if (!text || text.length > 60) {
      return "";
    }
    if (/https?:\/\/|xiaohongshu\.com|\/user\/profile\//i.test(text)) {
      return "";
    }
    if (/^(关注|已关注|粉丝|获赞与收藏|分享|评论|收藏|点赞|赞|更多)$/.test(text)) {
      return "";
    }
    return text;
  }

  function getTextFromProfileLink(link) {
    const directText = cleanAuthorCandidateText(textOf(link));
    if (directText) {
      return directText;
    }
    const textNodes = Array.from(link?.querySelectorAll?.(
      '[class*="nickname"], [class*="Nickname"], [class*="name"], [class*="Name"], span'
    ) || []);
    for (const node of textNodes) {
      const text = cleanAuthorCandidateText(textOf(node));
      if (text) {
        return text;
      }
    }
    return "";
  }

  function extractDomAuthorFromProfileLink(root, expectedAuthorLink = "") {
    const expectedUserId = getProfileUserIdFromUrl(expectedAuthorLink);
    const candidates = Array.from(root?.querySelectorAll?.(
      'a[href*="/user/profile/"], a[href*="user/profile"]'
    ) || []).filter((candidate) => !isInNoiseSection(candidate));
    const orderedCandidates = candidates
      .map((candidate, index) => ({
        candidate,
        index,
        url: getUrlFromElement(candidate)
      }))
      .filter((item) => /\/user\/profile\//.test(item.url))
      .sort((left, right) => {
        const leftMatchesExpected = expectedUserId && getProfileUserIdFromUrl(left.url) === expectedUserId ? 1 : 0;
        const rightMatchesExpected = expectedUserId && getProfileUserIdFromUrl(right.url) === expectedUserId ? 1 : 0;
        return rightMatchesExpected - leftMatchesExpected || left.index - right.index;
      });

    for (const item of orderedCandidates) {
      const text = getTextFromProfileLink(item.candidate);
      if (isUsefulText(text)) {
        return text;
      }
    }
    return "";
  }

  function extractAuthorLink(root, noteBlock = "", noteContext = null) {
    const structuredUserId = extractStructuredUserId(noteContext, noteBlock);
    if (structuredUserId) {
      return `https://www.xiaohongshu.com/user/profile/${structuredUserId}`;
    }

    const candidates = Array.from(root.querySelectorAll?.(
      'a[href*="/user/"], a[href*="/profile/"], a[href*="/explore/user"], a[href*="user/profile"]'
    ) || []);
    const domLink = candidates
      .filter((candidate) => !isInNoiseSection(candidate))
      .map(getUrlFromElement)
      .find((url) => /\/user\/profile\//.test(url));
    if (domLink) {
      return domLink;
    }

    return getUrlFromElement(candidates[0]);
  }

  function extractTitle(root, noteBlock = "", noteContext = null) {
    const title = firstSafeText([
      "#detail-title",
      ".title",
      '[class*="title"]',
      "h1"
    ], root);
    if (title) {
      return title;
    }
    const structuredTitle = extractStructuredTextValue(noteContext, noteBlock, [
      "displayTitle",
      "display_title",
      "title",
      "noteTitle",
      "note_title"
    ], 160);
    if (structuredTitle) {
      return structuredTitle;
    }
    const metaTitle = metaContent([
      'meta[property="og:title"]',
      'meta[name="title"]'
    ]);
    return metaTitle || document.title.replace(/- 小红书.*/, "").trim();
  }

  function extractRawContent(root, noteBlock = "", noteContext = null) {
    return firstSafeText([
      "#detail-desc",
      '[class*="note-content"]',
      '[class*="NoteContent"]'
    ], root) || extractStructuredTextValue(noteContext, noteBlock, [
      "desc",
      "description",
      "content",
      "noteDesc",
      "note_desc",
      "text"
    ], 5000) || metaContent([
      'meta[property="og:description"]',
      'meta[name="description"]'
    ]);
  }

  function extractContent(root, noteBlock = "", noteContext = null) {
    return normalizeNoteContent(extractRawContent(root, noteBlock, noteContext));
  }

  function extractAuthor(root, noteBlock = "", noteContext = null, authorLink = "") {
    const byDomProfileLink = extractDomAuthorFromProfileLink(root, authorLink);
    if (byDomProfileLink) {
      return byDomProfileLink;
    }

    const byStructured = extractStructuredAuthor(noteContext, noteBlock);
    if (byStructured) {
      return byStructured;
    }

    const byDom = firstSafeText([
      ".author .name",
      ".user .name",
      ".username",
      ".user-name",
      '[class*="nickname"]',
      '[class*="Nickname"]',
      '[class*="user-name"]',
      '[class*="UserName"]',
      '[class*="author"] [class*="name"]',
      '[class*="Author"] [class*="name"]',
      '[class*="user"] [class*="name"]',
      '[class*="User"] [class*="name"]'
    ], root);
    if (isUsefulText(byDom)) {
      return byDom;
    }

    const byMeta = metaContent([
      'meta[name="author"]',
      'meta[property="article:author"]'
    ]);
    if (isUsefulText(byMeta)) {
      return byMeta;
    }

    return "未知作者";
  }

  async function extractRecord(options = {}) {
    const expectedNoteId = options.expectedNoteId || "";
    const root = findCaptureRoot(expectedNoteId, options.rootHint || null);
    const noteId = expectedNoteId || getCurrentNoteId();
    const entryCoverUrls = dedupeImageUrls(options.entryCoverUrls || getRememberedEntryCoverUrls(noteId));
    const noteBlock = getCurrentNoteBlock(noteId);
    const noteContext = findParsedNoteContext(noteId);
    const actionMetrics = extractActionMetricsFromRoot(root);
    const rawContent = extractRawContent(root, noteBlock, noteContext);
    const content = normalizeNoteContent(rawContent);
    const title = extractTitle(root, noteBlock, noteContext);
    const authorLink = extractAuthorLink(root, noteBlock, noteContext);
    const followers = getNoteMetricValue(noteContext, noteBlock, [
      "fans",
      "fansCount",
      "followerCount",
      "followers",
      "followersCount",
      "fans_count",
      "followers_count"
    ]);
    const totalLikes = getNoteMetricValue(noteContext, noteBlock, [
      "likedAndCollected",
      "likesAndCollects",
      "interactionCount",
      "likedCollectCount",
      "liked_collect_count",
      "totalFavorited",
      "total_favorited"
    ]);
    const noteTypeResult = detectNoteTypeWithEvidence(root, noteContext, noteBlock, noteId);
    const noteType = noteTypeResult.value;
    const imageResult = collectImageUrlsWithEvidence(root, noteBlock, noteContext, noteType, noteId, {
      entryCoverUrls
    });
    const record = {
      noteId,
      title,
      author: extractAuthor(root, noteBlock, noteContext, authorLink),
      authorLink,
      followers,
      likes: extractNoteMetric(root, noteContext, [
        "likedCount",
        "likeCount",
        "likes",
        "liked_count",
        "like_count",
        "liked_count_num"
      ], ["点赞", "赞"], 0, actionMetrics),
      collects: extractNoteMetric(root, noteContext, [
        "collectedCount",
        "collectCount",
        "collectionCount",
        "favoriteCount",
        "favCount",
        "collectNum",
        "collectionNum",
        "favoriteNum",
        "noteCollectCount",
        "collectCountStr",
        "collectedCountStr",
        "collects",
        "collected",
        "collected_count",
        "collect_count",
        "collection_count",
        "favorite_count",
        "collect_num",
        "collection_num",
        "favorite_num",
        "note_collect_count"
      ], ["收藏", "collect", "favorite"], 1, actionMetrics),
      comments: extractNoteMetric(root, noteContext, [
        "commentCount",
        "commentsCount",
        "noteCommentCount",
        "noteCommentsCount",
        "commentNum",
        "commentsNum",
        "commentCountStr",
        "commentsCountStr",
        "commentTotal",
        "totalComment",
        "comments",
        "comment_count",
        "comments_count",
        "note_comment_count",
        "note_comments_count",
        "comment_num",
        "comments_num",
        "comment_total",
        "total_comment"
      ], ["评论", "comment", "chat"], 2, actionMetrics),
      shares: extractNoteMetric(root, noteContext, [
        "shareCount",
        "shares",
        "share_count"
      ], ["分享", "转发"], 3, actionMetrics),
      content,
      tags: extractTags(rawContent, root, noteBlock, noteContext),
      link: getNoteLink(noteId),
      dateInMilliseconds: extractPublishDateInMilliseconds(root, noteContext, noteBlock),
      noteType,
      platform: "小红书",
      totalLikes,
      allImageUrls: imageResult.urls,
      expectedImageCount: noteType === "图文" ? Math.min(MAX_NOTE_IMAGE_COUNT, Math.max(
        imageResult.evidence.structuredUrls.length,
        ...Array.from(root?.querySelectorAll?.('.fraction, .swiper-pagination-fraction') || [])
          .filter((element) => !isInNoiseSection(element))
          .map((element) => Number(textOf(element).match(/^\d+\s*\/\s*(\d+)$/)?.[1]) || 0)
      )) : 0,
      debugEvidence: {
        expectedNoteId,
        selectedRoot: describeElementForDebug(root),
        metricEvidence: actionMetrics.evidence,
        noteTypeEvidence: noteTypeResult.evidence,
        imageEvidence: imageResult.evidence
      }
    };
    return record;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      if (extensionContextInvalid) {
        resolve({
          success: false,
          error: "插件刚刚更新过，请刷新当前小红书页面后再采集。"
        });
        return;
      }

      try {
        if (!chrome?.runtime?.id) {
          extensionContextInvalid = true;
          resolve({
            success: false,
            error: "插件刚刚更新过，请刷新当前小红书页面后再采集。"
          });
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
              resolve({
                success: false,
                error: "插件刚刚更新过，请刷新当前小红书页面后再采集。"
              });
              return;
            }
            resolve({
              success: false,
              error: messageText || "插件通信失败，请刷新当前页面后重试。"
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
                ? "插件刚刚更新过，请刷新当前小红书页面后再采集。"
                : messageText
            });
            return;
          }
          resolve(response || { success: false, error: "没有收到后台响应。" });
        });
      } catch (error) {
        const messageText = error?.message || "";
        if (messageText.includes("Extension context invalidated")) {
          extensionContextInvalid = true;
        }
        resolve({
          success: false,
          error: messageText.includes("Extension context invalidated")
            ? "插件刚刚更新过，请刷新当前小红书页面后再采集。"
            : messageText || "插件通信失败，请刷新当前页面后重试。"
        });
      }
    });
  }

  function showNotice(message, type, duration = 4200) {
    let notice = document.getElementById(NOTICE_ID);
    if (!notice) {
      notice = document.createElement("div");
      notice.id = NOTICE_ID;
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    notice.dataset.type = type || "info";
    if (noticeTimer) {
      window.clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    if (duration > 0) {
      noticeTimer = window.setTimeout(() => {
        if (notice) {
          notice.remove();
        }
        noticeTimer = null;
      }, duration);
    }
  }

  function buildSaveSuccessMessage(response) {
    const target = response.configName || "默认多维表格";
    if (response.imageFailureCount > 0 && response.imageCount === 0) {
      return `已保存到飞书：${target}。但图片上传失败：${response.firstImageFailure || "请稍后重试"}`;
    }
    if (response.imageFailureCount > 0) {
      return `已保存到飞书：${target}。部分图片上传失败。`;
    }
    const count = Number.isInteger(response.imageCount) ? `（${response.imageCount} 张图片）` : "";
    return `已保存到飞书：${target}${count}。`;
  }

  function normalizeCaptureJob(jobOrSource) {
    if (typeof jobOrSource === "string") {
      return {
        source: jobOrSource,
        noteId: getCurrentNoteId(),
        rootHint: null,
        entryCoverUrls: getRememberedEntryCoverUrls(getCurrentNoteId()),
        clickTime: Date.now()
      };
    }
    const noteId = jobOrSource?.noteId || getCurrentNoteId();
    return {
      source: jobOrSource?.source || "share-click",
      noteId,
      rootHint: jobOrSource?.rootHint || null,
      entryCoverUrls: dedupeImageUrls(jobOrSource?.entryCoverUrls || getRememberedEntryCoverUrls(noteId)),
      clickTime: jobOrSource?.clickTime || Date.now()
    };
  }

  function startCaptureJob(job) {
    if (!job?.noteId) {
      return;
    }
    if (captureInProgress) {
      debugLog("ignored busy click", {
        activeNoteId: activeCaptureJob?.noteId || "",
        ignoredNoteId: job.noteId
      });
      showNotice("正在保存上一条笔记，请完成后再采集下一条。", "info", 1800);
      return;
    }

    captureInProgress = true;
    activeCaptureJob = job;
    captureCurrentNote(job).finally(() => {
      captureInProgress = false;
      activeCaptureJob = null;
    });
  }

  function validateRecordScope(record, job) {
    if (job.noteId && record.noteId !== job.noteId) {
      throw new Error("采集到的笔记和点击的笔记不一致，已停止写入，请重新点击当前笔记分享按钮。");
    }
    if (record.expectedImageCount > record.allImageUrls.length) {
      throw new Error(`图片未采集完整：应有 ${record.expectedImageCount} 张，读取到 ${record.allImageUrls.length} 张，尚未保存。请稍后重新点击分享。`);
    }
  }

  async function completeCurrentNoteImages(record) {
    if (record.noteType !== "图文" || (
      record.allImageUrls.length > 1 && record.allImageUrls.length >= record.expectedImageCount
    )) return record;

    // Collection/profile overlays are SPA navigation: inline scripts still
    // describe the entry page. Read this note's HTML without navigating the tab.
    const url = new URL(record.link, location.href);
    if (url.origin !== new URL(location.href).origin || extractNoteIdFromUrl(url.href) !== record.noteId) {
      throw new Error("笔记链接不一致，已停止补齐图片。");
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url.href, {
        credentials: "same-origin",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`详情读取失败（${response.status}）`);
      const finalUrl = new URL(response.url || url.href);
      if (finalUrl.origin !== url.origin || extractNoteIdFromUrl(finalUrl.href) !== record.noteId) {
        throw new Error("详情返回了其他页面");
      }
      const html = await response.text();
      if (html.length > 5000000) throw new Error("详情数据过大");
      const detailDocument = new DOMParser().parseFromString(html, "text/html");
      const context = findParsedNoteContext(record.noteId, detailDocument);
      if (!context) throw new Error("详情暂未返回该笔记的图片列表");
      const result = collectStructuredImageUrlsFromCurrentNote(context.object, {
        noteId: record.noteId,
        noteType: "图文",
        skipVideoFields: true,
        preferSingleBestList: true
      });
      const urls = limitImageUrlsForNoteType(result.urls, "图文");
      if (!urls.length || urls.length < record.expectedImageCount || urls.length < record.allImageUrls.length) {
        throw new Error("详情图片列表尚未完整");
      }
      if (getCurrentNoteId() !== record.noteId) throw new Error("当前笔记已切换，已停止保存，请点击新笔记的分享按钮。");
      return {
        ...record,
        allImageUrls: urls,
        expectedImageCount: Math.max(record.expectedImageCount || 0, urls.length),
        debugEvidence: {...record.debugEvidence, imageCompletion: {source: "note-detail-html", imageCount: urls.length}}
      };
    } catch (error) {
      // Already complete single-image notes can still be saved if the optional
      // verification fails. Known missing images must never be written.
      if (record.allImageUrls.length > 0 && record.allImageUrls.length >= record.expectedImageCount && getCurrentNoteId() === record.noteId) {
        return record;
      }
      throw new Error(`自动补齐图片未成功，尚未保存。${error.name === "AbortError" ? "读取超时，请稍后再点分享。" : error.message}`);
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function captureCurrentNote(jobOrSource) {
    const job = normalizeCaptureJob(jobOrSource);
    if (extensionContextInvalid) {
      showNotice("插件刚刚更新过，请刷新当前小红书页面后再采集。", "error");
      return;
    }
    lastCaptureAt = Date.now();
    showNotice("正在保存到飞书...", "info", 0);

    try {
      let record = await extractRecord({
        expectedNoteId: job.noteId,
        rootHint: job.rootHint,
        entryCoverUrls: job.entryCoverUrls
      });
      if (record.noteType === "图文" && (record.allImageUrls.length <= 1 || record.expectedImageCount > record.allImageUrls.length)) {
        showNotice("正在读取完整图片，请稍候...", "info", 0);
        record = await completeCurrentNoteImages(record);
      }
      validateRecordScope(record, job);
      debugLog("record", record);
      const response = await sendMessage({
        action: "addXhsRecord",
        source: job.source,
        record
      });

      if (response.success) {
        showNotice(buildSaveSuccessMessage(response), "success", 8000);
      } else {
        if ((response.error || "").includes("刷新当前")) {
          extensionContextInvalid = true;
        }
        showNotice(response.error || "采集失败，请检查设置。", "error");
      }
    } catch (error) {
      showNotice(error?.message || "采集失败。", "error");
    }
  }

  function isShareClick(event) {
    const noteId = getCurrentNoteIdFromLocation();
    if (!noteId) {
      return null;
    }

    const target = event.target;
    if (!target || target.closest(`#${BUTTON_ID}`)) {
      return null;
    }
    const clickable = target.closest("button, a, div, span");
    if (!clickable) {
      return null;
    }

    const label = [
      clickable.getAttribute("aria-label"),
      clickable.getAttribute("title"),
      clickable.dataset?.tooltip,
      textOf(clickable),
      clickable.className || "",
      clickable.innerHTML || ""
    ].filter(Boolean).join(" ");
    if (/复制链接|复制笔记链接|copy\s*link|copy-link|copyLink/i.test(label)) return null;
    const explicitShareControl = isExplicitShareControl(clickable, label);
    if (isInNoiseSection(clickable) && !explicitShareControl) {
      return null;
    }

    const noteRoot = findShareClickRoot(clickable, findNoteRoot());
    if (!noteRoot || noteRoot === document.body || noteRoot === document.documentElement || !elementContains(noteRoot, clickable)) {
      return null;
    }

    const looksLikeShare = /分享|share|Share/i.test(label);
    const hasShareIcon = /share|Share|forward|Forward/.test(label);
    const looksLikeCopyLink = /复制链接|复制笔记链接|copy\s*link|copy-link|copyLink|link-wrapper|linkWrapper|link-icon|icon-link/i.test(label);
    const shouldCapture = looksLikeShare || hasShareIcon || looksLikeCopyLink || explicitShareControl || isLikelyUnlabeledShareAction(clickable, noteRoot);
    if (!shouldCapture) {
      return null;
    }
    return {
      noteId,
      rootHint: noteRoot,
      entryCoverUrls: getRememberedEntryCoverUrls(noteId),
      source: "share-click",
      clickTime: Date.now()
    };
  }

  function injectStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.documentElement.appendChild(style);
    }
    if (style.dataset) {
      style.dataset.xhhBuild = CONTENT_BUILD;
    }
    style.textContent = `
      /* xhh-content-build:${CONTENT_BUILD} */
      #${NOTICE_ID} {
        position: fixed;
        left: 50%;
        top: 24px;
        transform: translateX(-50%);
        z-index: 2147483647;
        min-width: 240px;
        max-width: min(560px, calc(100vw - 32px));
        padding: 12px 18px;
        border-radius: 6px;
        background: #ffffff;
        color: #20242a;
        font-size: 14px;
        line-height: 1.5;
        text-align: center;
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.18);
        border: 1px solid #dfe3e8;
      }
      #${NOTICE_ID}[data-type="success"] {
        color: #2f8f46;
      }
      #${NOTICE_ID}[data-type="error"] {
        color: #c93535;
      }
    `;
  }

  function removeFloatingControls() {
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(BADGE_ID)?.remove();
  }

  function keepFloatingControlsRemoved() {
    removeFloatingControls();
    cleanupObserver = new MutationObserver(removeFloatingControls);
    cleanupObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function handleBodyClick(event) {
    rememberEntryCoverFromClick(event);
    const captureJob = isShareClick(event);
    if (!captureJob) {
      return;
    }
    startCaptureJob(captureJob);
  }

  function handleKeydown(event) {
    return false;
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    if (message?.action !== "extractXhsProfileMetrics") {
      return false;
    }

    Promise.resolve()
      .then(() => ({
        success: true,
        metrics: extractProfileMetricsFromCurrentPage()
      }))
      .catch((error) => ({
        success: false,
        error: error?.message || "作者主页数据采集失败。"
      }))
      .then(sendResponse);

    return true;
  }

  function initialize() {
    document.documentElement?.setAttribute?.("data-xhh-build", CONTENT_BUILD);
    injectStyles();
    keepFloatingControlsRemoved();

    document.body.addEventListener("click", handleBodyClick, true);

    chrome?.runtime?.onMessage?.addListener?.(handleRuntimeMessage);

    globalThis.__XHH_CONTENT_CLEANUP__ = () => {
      document.body?.removeEventListener("click", handleBodyClick, true);
      chrome?.runtime?.onMessage?.removeListener?.(handleRuntimeMessage);
      cleanupObserver?.disconnect();
      cleanupObserver = null;
      if (shareCaptureTimer) {
        window.clearTimeout(shareCaptureTimer);
        shareCaptureTimer = null;
      }
      if (noticeTimer) {
        window.clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      entryCoverCache.clear();
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
