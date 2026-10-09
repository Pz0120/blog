(function(global) {
  'use strict';

  const ADMIN_TOKEN_KEY = 'koobai_admin_token';

  const byId = id => global.document.getElementById(id);

  const getAdminToken = () => global.localStorage.getItem(ADMIN_TOKEN_KEY) || '';

  const setAdminToken = token => global.localStorage.setItem(ADMIN_TOKEN_KEY, token);

  const clearAdminToken = () => global.localStorage.removeItem(ADMIN_TOKEN_KEY);

  const utf8ToBase64 = value => global.btoa(
    Array.from(new global.TextEncoder().encode(value), byte => String.fromCodePoint(byte)).join('')
  );

  const base64ToUtf8 = value => new global.TextDecoder().decode(
    Uint8Array.from(global.atob(value), character => character.charCodeAt(0))
  );

  async function secureFetch(url, options = {}) {
    options.headers = { ...options.headers, 'x-admin-token': getAdminToken() };
    const response = await global.fetch(url, options);
    if (response.status === 401) throw new Error('401');
    return response;
  }

  function saveDraft(key, value) {
    global.localStorage.setItem(key, JSON.stringify(value));
  }

  function loadDraft(key) {
    const saved = global.localStorage.getItem(key);
    if (!saved) return null;
    try {
      return JSON.parse(saved);
    } catch (_error) {
      return null;
    }
  }

  function removeDraft(key) {
    global.localStorage.removeItem(key);
  }

  function yamlString(value) {
    return JSON.stringify(String(value ?? ''));
  }

  function parseYamlScalar(value) {
    const source = String(value ?? '').trim();
    if (source.startsWith('"')) {
      try {
        return JSON.parse(source);
      } catch (_error) {
        return source.replace(/(^"|"$)/g, '');
      }
    }
    if (source.startsWith("'") && source.endsWith("'")) {
      return source.slice(1, -1).replace(/''/g, "'");
    }
    return source;
  }

  function frontMatterScalar(frontMatter, key) {
    const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(frontMatter || '').match(new RegExp(`^${escapedKey}:\\s*(.*)$`, 'm'));
    return match ? parseYamlScalar(match[1]) : '';
  }

  function validatePathSegment(value, options = {}) {
    let normalized = String(value || '').trim();
    if (options.markdownFilename) normalized = normalized.replace(/\.md$/i, '');
    if (!normalized) return { ok: true, value: '' };
    const invalid = normalized === '.'
      || normalized === '..'
      || normalized.length > 180
      || /[\/\\%?#\u0000-\u001F\u007F]/.test(normalized);
    return invalid
      ? { ok: false, value: normalized, error: options.markdownFilename ? '文件名不能包含路径、URL 保留字符或控制字符' : '路径不能包含斜杠、URL 保留字符或控制字符' }
      : { ok: true, value: normalized };
  }

  function validateFilename(value) {
    return validatePathSegment(value, { markdownFilename: true });
  }

  function validateSlug(value) {
    return validatePathSegment(value);
  }

  function uniqueStrings(values) {
    return [...new Set((values || []).map(value => String(value).trim()).filter(Boolean))];
  }

  /* 走过记录在 front matter 里的字段名（YAML 下划线 → 内部驼峰）。
     与上游 docs/zouguo-data-contract.md 的 place 结构逐字对应。 */
  const ZOUGUO_PLACE_FIELDS = {
    id: 'id',
    name: 'name',
    longitude: 'longitude',
    latitude: 'latitude',
    precision: 'precision',
    privacy: 'privacy',
    country: 'country',
    country_code: 'countryCode',
    region: 'region',
    region_code: 'regionCode',
    locality: 'locality',
    locality_code: 'localityCode',
    provider: 'provider',
    provider_id: 'providerId'
  };

  const ZOUGUO_NUMBER_FIELDS = new Set(['longitude', 'latitude']);

  /* place 对象 → front matter 里的 zouguo 块（不含开头缩进，调用方拼） */
  function zouguoLines(zouguo) {
    if (!zouguo || !zouguo.place || !zouguo.occurredAt) return [];
    const place = zouguo.place;
    const lines = ['zouguo:', `  occurred_at: ${zouguo.occurredAt}`, '  place:'];
    Object.keys(ZOUGUO_PLACE_FIELDS).forEach(yamlKey => {
      const value = place[ZOUGUO_PLACE_FIELDS[yamlKey]];
      if (value === undefined || value === null || value === '') {
        /* 坐标和 id 是必填（Hugo 模板缺了会直接让构建失败），其余空值省略 */
        if (ZOUGUO_NUMBER_FIELDS.has(yamlKey)) return;
        return;
      }
      if (ZOUGUO_NUMBER_FIELDS.has(yamlKey)) {
        lines.push(`    ${yamlKey}: ${Number(value)}`);
      } else {
        lines.push(`    ${yamlKey}: ${yamlString(value)}`);
      }
    });
    return lines;
  }

  /* front matter 文本 → { occurredAt, place }，用于「编辑旧文章」时回填 */
  function parseZouguoBlock(frontMatter) {
    const blockMatch = String(frontMatter || '')
      .match(/(?:^|\n)zouguo:[ \t]*\n([\s\S]*?)(?=\n[A-Za-z0-9_-]+:[ \t]*|$)/);
    if (!blockMatch) return null;

    const block = blockMatch[1];
    const occurredMatch = block.match(/^[ \t]*occurred_at:[ \t]*(.+)$/m);
    const place = {};
    const fieldRe = /^[ \t]+([a-z_]+):[ \t]*(.*)$/gm;
    let match;
    while ((match = fieldRe.exec(block)) !== null) {
      const yamlKey = match[1];
      if (yamlKey === 'place' || yamlKey === 'occurred_at') continue;
      const internalKey = ZOUGUO_PLACE_FIELDS[yamlKey];
      if (!internalKey) continue;
      const raw = match[2].trim();
      place[internalKey] = ZOUGUO_NUMBER_FIELDS.has(yamlKey)
        ? Number(raw)
        : parseYamlScalar(raw);
    }

    /* 模板要求这几个字段齐全，缺了就当没写过走过，免得带着半截数据去发布 */
    if (!occurredMatch || !place.id || !place.name
      || !Number.isFinite(place.longitude) || !Number.isFinite(place.latitude)) {
      return null;
    }
    return { occurredAt: parseYamlScalar(occurredMatch[1]), place };
  }

  function buildPostMarkdown(values) {
    const lines = [
      '---',
      `title: ${yamlString(values.title)}`,
      `date: ${values.date}`,
      `slug: ${yamlString(values.slug)}`
    ];
    if (values.image) lines.push(`image: ${yamlString(values.image)}`);
    if (values.description) lines.push(`description: ${yamlString(values.description)}`);
    const tags = uniqueStrings(values.tags);
    if (tags.length) {
      lines.push('tags:');
      tags.forEach(tag => lines.push(`  - ${yamlString(tag)}`));
    }
    lines.push(...zouguoLines(values.zouguo));
    lines.push('---', '');
    return `${lines.join('\n')}\n${String(values.content || '')}`;
  }

  function buildLaodaoMarkdown(values) {
    const lines = ['---', `date: ${values.date}`];
    const tags = uniqueStrings(values.tags);
    if (tags.length) {
      lines.push('laodaotags:');
      tags.forEach(tag => lines.push(`  - ${yamlString(tag)}`));
    }
    if (values.location) {
      lines.push(`location: ${yamlString(values.location.name)}`);
      lines.push(`latlng: ${yamlString(`${values.location.lat},${values.location.lng}`)}`);
    }
    if (values.device) lines.push(`device: ${yamlString(values.device)}`);
    lines.push('---', '');
    return `${lines.join('\n')}\n${String(values.content || '')}\n`;
  }

  function createDirtyTracker() {
    let dirty = false;
    const beforeUnload = event => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('beforeunload', beforeUnload);
    }
    return {
      mark: () => { dirty = true; },
      clear: () => { dirty = false; },
      isDirty: () => dirty,
      destroy: () => {
        if (typeof global.removeEventListener === 'function') {
          global.removeEventListener('beforeunload', beforeUnload);
        }
      }
    };
  }

  async function fetchTagTitles(path) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await global.fetch(`${path}${separator}t=${Date.now()}`);
    if (!response.ok) return [];
    const text = await response.text();
    const xml = new global.DOMParser().parseFromString(text, 'text/xml');
    const titles = Array.from(xml.querySelectorAll('item title')).map(item => item.textContent);
    return [...new Set(titles)];
  }

  /* HEIC 支持：iPhone 默认拍摄格式，浏览器原生无法解码。
     用 heic2any（WASM）在浏览器里转成 JPEG，再走正常的压缩流程。
     库按需懒加载——非 HEIC 用户不用下载这 200KB。 */
  var heic2anyPromise = null;
  function loadHeic2any() {
    if (heic2anyPromise) return heic2anyPromise;
    heic2anyPromise = new Promise(function (resolve, reject) {
      if (typeof global.heic2any !== 'undefined') { resolve(); return; }
      var script = global.document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('HEIC 转换库加载失败')); };
      global.document.head.appendChild(script);
    });
    return heic2anyPromise;
  }

  function isHeic(file) {
    var t = (file.type || '').toLowerCase();
    if (t === 'image/heic' || t === 'image/heif') return true;
    var name = (file.name || '').toLowerCase();
    return name.endsWith('.heic') || name.endsWith('.heif');
  }

  function convertHeic(file) {
    return loadHeic2any().then(function () {
      return global.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
    }).then(function (result) {
      // heic2any 可能返回数组（多帧 HEIC）或单 blob
      var blob = Array.isArray(result) ? result[0] : result;
      return new File([blob], (file.name || 'image').replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg'),
        { type: 'image/jpeg', lastModified: Date.now() });
    });
  }

  /* 把文件解码成一个 Image。
     HEIC 要先转 JPEG —— 这一步很慢，所以只做一次，两个尺寸共用同一张解码结果。 */
  function decodeImage(file) {
    return new Promise(function (resolve, reject) {
      var source = file;
      var ready = isHeic(file)
        ? convertHeic(file).then(function (jpeg) { source = jpeg; })
        : Promise.resolve();
      ready.then(function () {
        var reader = new global.FileReader();
        reader.onload = function (event) {
          var image = new global.Image();
          image.onload = function () { resolve(image); };
          image.onerror = reject;
          image.src = event.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(source);
      }).catch(reject);
    });
  }

  /* 算等比缩放后的目标尺寸。
     两种约束都保留：maxEdge 限制最长边（用于原图，保证总像素不失控），
     maxWidth 限制宽度（用于派生图，因为卡片和封面的槽位是按宽度定的，
     和 params.toml 里的 smallWidth / largeWidth 语义一致）。 */
  function targetSize(image, options) {
    var width = image.width;
    var height = image.height;
    if (options.maxWidth) {
      if (width > options.maxWidth) {
        height = height * options.maxWidth / width;
        width = options.maxWidth;
      }
    } else if (options.maxEdge) {
      if (width > height) {
        if (width > options.maxEdge) { height = height * options.maxEdge / width; width = options.maxEdge; }
      } else if (height > options.maxEdge) {
        width = width * options.maxEdge / height;
        height = options.maxEdge;
      }
    }
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }

  function drawToWebp(image, options, quality) {
    return new Promise(function (resolve, reject) {
      var size = targetSize(image, options);
      var canvas = global.document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext('2d').drawImage(image, 0, 0, size.width, size.height);
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('IMAGE_COMPRESSION_FAILED'));
      }, 'image/webp', quality);
    });
  }

  const FULL_MAX_EDGE = 1500;
  const FULL_QUALITY = 0.75;
  /* 两档派生图，按宽度缩。卡片槽位（走过时间线约 390px、首页约 252px）用 _thumb；
     列表页大封面是 2:1、显示宽 800px，用 _large 才不至于发虚。 */
  const THUMB_WIDTH = 640;
  const LARGE_WIDTH = 960;
  const THUMB_QUALITY = 0.72;
  /* 后缀必须与 params.toml 的 services.images.thumbnailSuffix / largeSuffix 一致，
     主题靠它们推导地址。改一处就要改另一处。 */
  const THUMB_SUFFIX = '_thumb';
  const LARGE_SUFFIX = '_large';

  function uploadOne(config, filename, blob) {
    return secureFetch(`${config.workerUrl}/api/upload?name=${filename}`, {
      method: 'POST',
      body: blob
    });
  }

  function publicUrl(config, filename, payload) {
    if (payload && payload.url) return payload.url;
    return `${String(config.upyunDomain || '').replace(/\/$/, '')}/${filename}`;
  }

  /* 派生图失败不能连累主图 —— 前端会自动回退到原图 */
  async function uploadVariant(config, filename, blob) {
    try {
      const response = await uploadOne(config, filename, blob);
      if (!response.ok) return '';
      let payload = {};
      try {
        payload = await response.json();
      } catch (_error) {}
      return publicUrl(config, filename, payload);
    } catch (_error) {
      return '';
    }
  }

  async function uploadImage(file, config, folder) {
    /* 只解码一次：HEIC 转 JPEG 很慢，两个尺寸共用同一张解码结果 */
    const image = await decodeImage(file);
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const filename = `${folder}/${stamp}.webp`;

    const full = await drawToWebp(image, { maxEdge: FULL_MAX_EDGE }, FULL_QUALITY);
    const response = await uploadOne(config, filename, full);
    if (!response.ok) throw new Error(`UPLOAD_${response.status || 'FAILED'}`);
    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {}
    const url = publicUrl(config, filename, payload);

    const thumb = await drawToWebp(image, { maxWidth: THUMB_WIDTH }, THUMB_QUALITY);
    const thumbFilename = `${folder}/${stamp}${THUMB_SUFFIX}.webp`;
    const thumbUrl = await uploadVariant(config, thumbFilename, thumb);

    const large = await drawToWebp(image, { maxWidth: LARGE_WIDTH }, THUMB_QUALITY);
    const largeFilename = `${folder}/${stamp}${LARGE_SUFFIX}.webp`;
    const largeUrl = await uploadVariant(config, largeFilename, large);

    return { filename, url, thumbUrl, largeUrl };
  }

  function renderMarkdown(parser, source, options = {}) {
    const fallback = options.fallback || '*空空如也*';
    const markdown = source || (options.allowEmpty ? '' : fallback);
    return parser.parse(options.trim ? markdown.trim() : markdown);
  }

  function repositoryUrl(config) {
    return `https://api.github.com/repos/${config.owner}/${config.repo}`;
  }

  function commitsUrl(config, path, perPage = 3) {
    return `${repositoryUrl(config)}/commits?path=${path}&per_page=${perPage}&sha=${config.branch}`;
  }

  function contentsUrl(config, path, includeRef = false) {
    const url = encodeURI(`${repositoryUrl(config)}/contents/${path}`);
    return includeRef ? `${url}?ref=${config.branch}` : url;
  }

  const api = {
    ADMIN_TOKEN_KEY,
    byId,
    getAdminToken,
    setAdminToken,
    clearAdminToken,
    utf8ToBase64,
    base64ToUtf8,
    secureFetch,
    saveDraft,
    loadDraft,
    removeDraft,
    yamlString,
    parseYamlScalar,
    frontMatterScalar,
    validateFilename,
    validateSlug,
    buildPostMarkdown,
    zouguoLines,
    parseZouguoBlock,
    buildLaodaoMarkdown,
    createDirtyTracker,
    fetchTagTitles,
    uploadImage,
    renderMarkdown,
    repositoryUrl,
    commitsUrl,
    contentsUrl
  };

  global.JingzheEditor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
