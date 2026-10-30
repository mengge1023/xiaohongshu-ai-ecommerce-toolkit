// Resolve only this Wiki page. No access to extension storage or authorisation codes.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.action !== 'resolveFeishuWiki') return;
  const match = location.pathname.match(/^\/wiki\/([A-Za-z0-9]+)\/?$/);
  if (!match || match[1] !== message.wikiToken) return;
  const query = new URLSearchParams({wiki_token:match[1],expand_shortcut:'true',with_deleted:'true'});
  fetch(`${location.origin}/space/api/wiki/v2/tree/get_node/?${query}`, {credentials:'same-origin',signal:AbortSignal.timeout(10000)})
    .then(r => r.json()).then(payload => {
      const node = payload?.data;
      if (payload.code !== 0 || !node) throw new Error('请先登录飞书并确认可以打开这份表格，再重新连接。');
      if (node.wiki_token !== match[1] || node.entity_delete_flag || Number(node.obj_type) !== 8 || !/^[A-Za-z0-9]+$/.test(node.obj_token || '')) throw new Error('这个链接不是可用的多维表格，请复制表格页面的分享链接。');
      respond({success:true,appToken:node.obj_token});
    }).catch(error => respond({success:false,error:error.name==='TimeoutError' ? '飞书响应超时，请稍后重新连接。' : error.message}));
  return true;
});
