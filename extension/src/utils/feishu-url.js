(function (global) {
  function parseFeishuUrl(value) {
    if (typeof value !== "string") return null;
    const match = value.trim().match(/https:\/\/[^\s<>]+/);
    if (!match) return null;
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || !/(^|\.)feishu\.cn$/.test(url.hostname) || url.username || url.password) return null;
      const path = url.pathname.match(/^\/(base|wiki)\/([A-Za-z0-9]+)\/?$/);
      if (!path) return null;
      const tableId = url.searchParams.get("table") || "";
      if (tableId && !/^tbl[A-Za-z0-9]+$/.test(tableId)) return null;
      if (path[1] === "base") return {appToken:path[2],tableId};
      return {wikiToken:path[2],tableId,sourceUrl:url.origin+url.pathname};
    } catch { return null; }
  }
  global.XhhFeishuUrl = {parseFeishuUrl};
})(self);
