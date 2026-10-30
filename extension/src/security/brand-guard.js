(function (global) {
  const error = "插件文件不完整或已被修改，请重新获取完整的生财专属安装包。原飞书配置不会被清除。";
  const required = ['manifest.json', 'background.js', 'options.html', 'options.css', 'options.js', 'content.js',
    'src/security/brand-key.js', 'src/security/brand-guard.js', 'src/controllers/message-controller.js'];
  function bytes(value) {
    const text = value.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(text), c => c.charCodeAt(0));
  }
  async function read(file) {
    // Only bundled extension resources; no server, account, browsing data or telemetry.
    const response = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' });
    if (!response.ok) throw new Error('missing resource');
    return new Uint8Array(await response.arrayBuffer());
  }
  async function digest(content) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), value => value.toString(16).padStart(2, '0')).join('');
  }
  function canonicalManifest(content) {
    const value = JSON.parse(new TextDecoder().decode(content));
    if (value.update_url !== undefined && value.update_url !== 'https://clients2.google.com/service/update2/crx') throw new Error('update URL');
    if (value.key !== undefined && typeof value.key !== 'string') throw new Error('key');
    if (value.differential_fingerprint !== undefined && typeof value.differential_fingerprint !== 'string') throw new Error('fingerprint');
    delete value.key; delete value.differential_fingerprint; delete value.update_url;
    const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
    return new TextEncoder().encode(JSON.stringify(sorted(value)));
  }
  async function sameIconPixels(content, original) {
    const images = [];
    try {
      for (const data of [content, original]) images.push(await createImageBitmap(new Blob([data], { type: 'image/png' })));
      const [a, b] = images;
      if (a.width !== b.width || a.height !== b.height || a.width > 128 || a.height > 128) return false;
      const pixels = img => {
        const canvas = new OffscreenCanvas(img.width, img.height), ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      return await digest(pixels(a)) === await digest(pixels(b));
    } finally { images.forEach(img => img.close()); }
  }
  async function verify() {
    const envelope = JSON.parse(new TextDecoder().decode(await read('brand-integrity.json')));
    const payload = bytes(envelope.payload), signature = bytes(envelope.signature);
    const key = await crypto.subtle.importKey('jwk', global.DahuojiangBrandPublicKey,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, payload)) throw new Error('signature');
    const manifest = JSON.parse(new TextDecoder().decode(payload));
    if (manifest.schemaVersion !== 2 || manifest.product !== '小红书爆款采集插件（生财专属版）' || manifest.version !== chrome.runtime.getManifest().version
      || !Array.isArray(manifest.files) || manifest.files.length > 128) throw new Error('manifest');
    const paths = manifest.files.map(entry => entry.path);
    if (new Set(paths).size !== paths.length || required.some(file => !paths.includes(file))) throw new Error('coverage');
    await Promise.all(manifest.files.map(async entry => {
      if (!/^[a-zA-Z0-9_./-]+$/.test(entry.path) || entry.path.startsWith('/') || entry.path.split('/').includes('..')
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('entry');
      const content = await read(entry.path);
      if (content.length === entry.bytes && await digest(content) === entry.sha256) return;
      // Only signed, narrowly described installation transformations are allowed.
      if (entry.path === 'manifest.json' && /^[a-f0-9]{64}$/.test(entry.canonicalSha256 || '')
        && await digest(canonicalManifest(content)) === entry.canonicalSha256) return;
      if (/^assets\/icon(?:16|48|128)\.png$/.test(entry.path)
        && entry.originalIcon === entry.path.replace('assets/', 'assets/integrity/') && paths.includes(entry.originalIcon)
        && await sameIconPixels(content, await read(entry.originalIcon))) return;
      throw new Error('changed resource');
    }));
    return { success: true };
  }
  let pending;
  function requireIntegrity() {
    // Share concurrent checks, but re-read on the next operation; no persistent bypass flag.
    if (!pending) pending = verify().catch(() => ({ success: false, error })).finally(() => { pending = undefined; });
    return pending;
  }
  global.DahuojiangBrandGuard = { requireIntegrity };
})(self);
