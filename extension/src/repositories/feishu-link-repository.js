(function (global) {
  async function resolve(parsed) {
    if (parsed.appToken) return parsed;
    const url = new URL(parsed.sourceUrl);
    const tabs = await chrome.tabs.query({url: `${url.origin}/wiki/*`});
    let tab = tabs.find(t => new URL(t.url).pathname === url.pathname);
    if (!tab) tab = await chrome.tabs.create({url: parsed.sourceUrl, active: true});
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, {action:'resolveFeishuWiki', wikiToken:parsed.wikiToken});
        if (result?.success && /^[A-Za-z0-9]+$/.test(result.appToken)) return {...parsed,appToken:result.appToken};
        if (result?.error) throw new Error(result.error);
      } catch (error) {
        if (!/Receiving end|Could not establish|message port|asynchronous response/i.test(error.message)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('请在打开的飞书页面完成登录，待表格显示后回到这里再点“保存并连接”。已打开的旧页面请先刷新。');
  }
  global.XhhFeishuLinkRepository = {resolve};
})(self);
