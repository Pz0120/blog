/* 共享地点选择器：搜地名 / 在地图上选点 / 用当前位置。
 *
 * 逻辑从 editor-zouguo.js 里那份已经上线验证过的实现抽出来，保证两个编辑器
 * （写走过、写随笔时顺带记走过）行为一致，尤其是这几个踩过坑的点：
 *
 *   · proximity=ip      搜「西湖」时偏向访客所在地，不然会返回别的城市的西湖区
 *   · precision 排序    poi 排在 locality 前面，避免行政区中心顶掉真实地点
 *   · 双数据源           Mapbox 国内景区覆盖差，OpenStreetMap 常常有；两者互补
 *   · 地图点选           搜索总有误差，最终兜底是让用户在图上直接点
 *   · pickerStyle()     用站点自己的样式，编辑器地图必须和走过页观感一致
 *
 * 注意：这段逻辑原本只住在 editor-zouguo.js 里。独立的走过编辑器下线后，
 * 这里成了唯一一份实现 —— 改行为时不会再有两份要同步。
 *
 * 产出统一的 place 结构，字段与上游 docs/zouguo-data-contract.md 对齐。
 * 样式在 place-picker.css。
 */
(function (global) {
  'use strict';

  var DEFAULT_GL_JS = 'https://registry.npmmirror.com/mapbox-gl/3.26.0/files/dist/mapbox-gl.js';
  var DEFAULT_GL_CSS = 'https://registry.npmmirror.com/mapbox-gl/3.26.0/files/dist/mapbox-gl.css';
  var LAST_PLACE_KEY = 'jingzhe_last_place';

  /* 排序权重：越具体越靠前 */
  var TYPE_ORDER = { poi: 0, address: 1, neighborhood: 2, place: 3, locality: 4, region: 5, country: 6, district: 7 };

  /* ------------------------------------------------------------------ */
  /* 名字处理                                                            */
  /*                                                                     */
  /* Nominatim 的 display_name 会把整条行政链串起来，比如                  */
  /*   「澳門美高梅, 柏嘉街, 新口岸新填海區 (皇朝區), 大堂區, 澳門,         */
  /*     999078, 中国」                                                  */
  /* 直接存进 front matter 又长又重复，地图卡片上也没法看。                */
  /* 上游作者手写的名字是「杭州 · 临平山公园」这种短名，这里按同样的习惯    */
  /* 自动生成：有城市就用「城市 · 地点」，地点本身已经带城市前缀就不再重复。 */
  /* ------------------------------------------------------------------ */

  function conciseName(shortName, locality, region) {
    var spot = String(shortName || '').trim();
    var label = String(locality || region || '').trim();
    if (!spot) return label;
    if (!label || label === spot) return spot;
    /* 「澳門美高梅」已经含「澳門」，再拼一次就成了废话 */
    if (spot.indexOf(label) === 0) return spot;
    return label + ' · ' + spot;
  }

  /* 结果列表第二行：去掉开头和第一行重复的那一段 */
  function trimAddress(fullName, shortName) {
    var full = String(fullName || '').trim();
    var spot = String(shortName || '').trim();
    if (!full) return '';
    if (spot && full.indexOf(spot) === 0) {
      return full.slice(spot.length).replace(/^[\s,，]+/, '').trim();
    }
    return full;
  }

  var glPromise = null;
  var cssLoaded = false;

  function isDarkMode() {
    var explicit = global.document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;
    return Boolean(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /* 带重试的 fetch —— api.mapbox.com 在国内会间歇性断连 */
  async function fetchJson(url, attempts) {
    var lastError = null;
    for (var i = 0; i < (attempts || 3); i += 1) {
      try {
        var response = await fetch(url);
        if (response.ok) return await response.json();
        if (response.status === 401 || response.status === 403) {
          throw new Error('Mapbox 令牌无效或无权限');
        }
        lastError = new Error('HTTP ' + response.status);
      } catch (error) {
        lastError = error;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 600 * (i + 1)); });
    }
    throw lastError || new Error('请求失败');
  }

  function precisionOf(feature) {
    var type = (feature.place_type && feature.place_type[0]) || '';
    if (type === 'address' || type === 'poi') return 'poi';
    if (type === 'country' || type === 'region' || type === 'district') return 'region';
    if (type === 'place' || type === 'locality' || type === 'neighborhood' || type === 'postcode') {
      return 'locality';
    }
    return 'poi';
  }

  function contextValue(feature, key) {
    var list = feature.context || [];
    for (var i = 0; i < list.length; i += 1) {
      if (String(list[i].id || '').indexOf(key + '.') === 0) return list[i];
    }
    return null;
  }

  /* Mapbox feature → 契约里的 place 结构 */
  function toPlace(feature) {
    var center = feature.center || (feature.geometry && feature.geometry.coordinates) || [];
    var longitude = Number(center[0]);
    var latitude = Number(center[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error('这个地点没有坐标，换一个结果试试');
    }

    var countryEntry = contextValue(feature, 'country');
    var regionEntry = contextValue(feature, 'region');
    var placeEntry = contextValue(feature, 'place');
    var localityEntry = contextValue(feature, 'locality');

    /* countryCode 必须是两位大写：优先国家条目，退而取地区码的前两位 */
    var countryCode = '';
    if (countryEntry && countryEntry.short_code) {
      countryCode = String(countryEntry.short_code).toUpperCase();
    } else if (regionEntry && regionEntry.short_code) {
      countryCode = String(regionEntry.short_code).split('-')[0].toUpperCase();
    }
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new Error('识别不出这个地点的国家代码，换个更具体的结果');
    }

    /* id 只能用小写字母数字和 . _ : -（服务端会校验） */
    var rawId = String(feature.id || '').toLowerCase().replace(/[^a-z0-9._:-]/g, '-');
    var id = 'mapbox:' + (rawId || 'x' + Date.now());

    var localityText = (placeEntry && placeEntry.text) || (localityEntry && localityEntry.text) || '';
    var regionText = (regionEntry && regionEntry.text) || '';

    return {
      id: id,
      name: conciseName(feature.text || feature.place_name, localityText, regionText),
      longitude: longitude,
      latitude: latitude,
      precision: precisionOf(feature),
      privacy: 'public',
      country: (countryEntry && countryEntry.text) || '',
      countryCode: countryCode,
      region: regionText,
      regionCode: (regionEntry && regionEntry.short_code) || '',
      locality: localityText,
      localityCode: '',
      provider: 'mapbox',
      providerId: String(feature.id || '')
    };
  }

  function candidateFromMapbox(feature) {
    try {
      return {
        name: feature.text || feature.place_name || '',
        fullName: feature.place_name || '',
        place: toPlace(feature)
      };
    } catch (_error) {
      return null;                       /* 缺国家代码之类的结果直接丢掉 */
    }
  }

  /* Nominatim（OpenStreetMap）：国内景区覆盖比 Mapbox 好得多。
     OSM 的 country_code 是小写，要转大写。 */
  function candidateFromNominatim(item) {
    var address = item.address || {};
    var longitude = Number(item.lon);
    var latitude = Number(item.lat);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

    var countryCode = String(address.country_code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) return null;

    var osmType = String(item.osm_type || '').toLowerCase();
    var osmId = String(item.osm_id || '');
    var id = ('osm:' + osmType + ':' + osmId).toLowerCase().replace(/[^a-z0-9._:-]/g, '-');

    var type = String(item.type || '');
    var precision = 'poi';
    if (/^(city|town|village|hamlet|municipality|suburb|neighbourhood|borough)$/.test(type)) {
      precision = 'locality';
    } else if (/^(state|province|region|county|administrative|country)$/.test(type)) {
      precision = 'region';
    }

    var locality = address.city || address.town || address.village
      || address.county || address.municipality || '';
    var region = address.state || address.province || '';
    var shortName = item.name || String(item.display_name || '').split(',')[0] || '';

    return {
      name: shortName,
      fullName: item.display_name || '',
      place: {
        id: id,
        name: conciseName(shortName, locality, region),
        longitude: longitude,
        latitude: latitude,
        precision: precision,
        privacy: 'public',
        country: address.country || '',
        countryCode: countryCode,
        region: region,
        regionCode: '',
        locality: locality,
        localityCode: '',
        provider: 'nominatim',
        providerId: item.osm_type ? (item.osm_type + '/' + item.osm_id) : ''
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* 组装 UI                                                             */
  /* ------------------------------------------------------------------ */

  function el(tag, className, text) {
    var node = global.document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function create(options) {
    var opts = options || {};
    var root = opts.root;
    if (!root) throw new Error('地点选择器缺少挂载点');
    var CONFIG = opts.config || {};
    var token = CONFIG.mapboxToken || '';

    var pickedPlace = null;
    var pickerMap = null;
    var pickerMarker = null;
    var pickerLngLat = null;
    var searchSeq = 0;
    var destroyed = false;

    /* --- DOM --- */
    root.innerHTML = '';
    root.classList.add('jingzhe-place');

    var searchRow = el('div', 'zg-search-row');
    var queryInput = el('input', 'zg-input');
    queryInput.type = 'search';
    queryInput.placeholder = opts.placeholder || '输入地名，越具体越准，如「西湖景区」「天安门广场」';
    var searchBtn = el('button', 'zg-search-btn', '搜索');
    searchBtn.type = 'button';
    searchRow.appendChild(queryInput);
    searchRow.appendChild(searchBtn);

    var tools = el('div', 'zg-tools');
    var globalLabel = el('label', 'zg-checkbox');
    var globalCheck = el('input');
    globalCheck.type = 'checkbox';
    globalLabel.appendChild(globalCheck);
    globalLabel.appendChild(el('span', null, '搜索全球'));
    var pickBtn = el('button', 'zg-link-btn', '在地图上选点');
    pickBtn.type = 'button';
    var locateBtn = el('button', 'zg-link-btn', '用当前位置');
    locateBtn.type = 'button';
    tools.appendChild(globalLabel);
    tools.appendChild(pickBtn);
    tools.appendChild(locateBtn);

    var statusEl = el('p', 'zg-status');
    statusEl.hidden = true;

    var resultsList = el('ul', 'zg-results');
    resultsList.hidden = true;

    var pickedBox = el('div', 'zg-picked');
    pickedBox.hidden = true;

    var pickerWrap = el('div', 'zg-picker');
    pickerWrap.hidden = true;
    var mapEl = el('div', 'zg-picker-map');
    var pickerHint = el('p', 'zg-picker-hint', '拖动图钉选位置，或直接点地图');
    var confirmRow = el('div', 'zg-picker-actions');
    var confirmBtn = el('button', 'zg-search-btn', '用这个位置');
    confirmBtn.type = 'button';
    var cancelPickBtn = el('button', 'zg-link-btn', '收起地图');
    cancelPickBtn.type = 'button';
    confirmRow.appendChild(confirmBtn);
    confirmRow.appendChild(cancelPickBtn);
    pickerWrap.appendChild(mapEl);
    pickerWrap.appendChild(pickerHint);
    pickerWrap.appendChild(confirmRow);

    [searchRow, tools, statusEl, resultsList, pickedBox, pickerWrap].forEach(function (node) {
      root.appendChild(node);
    });

    function setStatus(text, isError) {
      if (!text) { statusEl.hidden = true; statusEl.textContent = ''; return; }
      statusEl.hidden = false;
      statusEl.textContent = text;
      statusEl.classList.toggle('is-error', Boolean(isError));
    }

    function notify() {
      if (typeof opts.onChange === 'function') opts.onChange(pickedPlace);
    }

    /* --- 搜索 --- */

    function mapboxToken() { return token; }

    async function geocodeForward(keyword, worldwide) {
      if (!mapboxToken()) throw new Error('缺少 Mapbox 令牌，无法搜索地名');
      var scope = worldwide ? '' : '&country=cn';
      var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
        encodeURIComponent(keyword) + '.json?language=zh-Hans&limit=6' + scope +
        '&proximity=ip&access_token=' + encodeURIComponent(mapboxToken());
      var data = await fetchJson(url, 3);
      return (data && data.features) || [];
    }

    async function geocodeReverse(longitude, latitude) {
      if (!mapboxToken()) throw new Error('缺少 Mapbox 令牌，无法反查地名');
      var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
        longitude + ',' + latitude + '.json?language=zh-Hans&limit=1' +
        '&types=place,locality,neighborhood,region,postcode&access_token=' +
        encodeURIComponent(mapboxToken());
      var data = await fetchJson(url, 3);
      return ((data && data.features) || [])[0] || null;
    }

    async function searchNominatim(keyword, worldwide) {
      var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1' +
        '&limit=6&accept-language=zh-CN&q=' + encodeURIComponent(keyword) +
        (worldwide ? '' : '&countrycodes=cn');
      var response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var list = await response.json();
      return (Array.isArray(list) ? list : []).map(candidateFromNominatim).filter(Boolean);
    }

    function hideResults() {
      resultsList.hidden = true;
      resultsList.innerHTML = '';
    }

    function renderResults(candidates) {
      resultsList.innerHTML = '';
      candidates.forEach(function (candidate) {
        var li = el('li');
        var button = el('button', 'zg-result');
        button.type = 'button';
        button.appendChild(el('span', 'zg-result-name', candidate.name));
        /* 地址行去掉开头和名字重复的那一段，否则第一行「西湖」第二行又以
           「西湖, ...」开头，看着就是废话 */
        var address = trimAddress(candidate.fullName, candidate.name);
        if (address) button.appendChild(el('span', 'zg-result-addr', address));
        button.addEventListener('click', function () { selectCandidate(candidate); });
        li.appendChild(button);
        resultsList.appendChild(li);
      });
      resultsList.hidden = false;
    }

    async function search() {
      var keyword = queryInput.value.trim();
      if (!keyword) { setStatus('先输入一个地名'); return; }

      var worldwide = globalCheck.checked;
      var seq = ++searchSeq;
      searchBtn.disabled = true;
      setStatus('搜索中…');
      hideResults();

      try {
        /* 两个数据源一起查，合并去重。Mapbox 对国内景区覆盖有限，
           OpenStreetMap 常常有；反过来 Mapbox 对国外地名、连锁店更全。 */
        var settled = await Promise.all([
          geocodeForward(keyword, worldwide)
            .then(function (list) { return list.map(candidateFromMapbox).filter(Boolean); })
            .catch(function () { return []; }),
          searchNominatim(keyword, worldwide).catch(function () { return []; })
        ]);
        if (seq !== searchSeq || destroyed) return;

        var candidates = settled[0].concat(settled[1]);
        var seen = {};
        candidates = candidates.filter(function (item) {
          var key = item.place.longitude.toFixed(3) + ',' + item.place.latitude.toFixed(3);
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        });
        candidates.sort(function (a, b) {
          var pa = TYPE_ORDER[a.place.precision] != null ? TYPE_ORDER[a.place.precision] : 9;
          var pb = TYPE_ORDER[b.place.precision] != null ? TYPE_ORDER[b.place.precision] : 9;
          return pa - pb;
        });

        if (!candidates.length) {
          setStatus('两个数据源都没找到。换个写法，勾「搜索全球」，或者点「在地图上选点」直接标位置。');
          return;
        }
        setStatus('找到 ' + candidates.length + ' 个，点一个确认');
        renderResults(candidates);
      } catch (error) {
        if (seq !== searchSeq || destroyed) return;
        setStatus('搜索失败：' + (error.message || error) + '（可重试）', true);
      } finally {
        searchBtn.disabled = false;
      }
    }

    function selectCandidate(candidate) {
      if (!candidate || !candidate.place) return;
      pickedPlace = candidate.place;
      /* 完整地址只在界面上做悬停提示用。写进 front matter 的字段由
         editor-core 的白名单决定，这个额外属性不会漏进 YAML。 */
      pickedPlace.fullName = candidate.fullName || '';
      hideResults();
      pickerWrap.hidden = true;
      setStatus('');
      renderPicked();
      try {
        global.localStorage.setItem(LAST_PLACE_KEY, JSON.stringify(pickedPlace));
      } catch (_error) { /* localStorage 不可用就算了 */ }
      notify();
    }

    function renderPicked() {
      pickedBox.innerHTML = '';
      if (!pickedPlace) { pickedBox.hidden = true; return; }

      var body = el('div', 'zg-picked-body');
      /* 第一行是存进文章里的短名（「杭州市 · 西湖」），不是整条行政链 */
      var nameEl = el('span', 'zg-picked-name', pickedPlace.name);
      /* 完整地址放到 title 里，鼠标悬停能看全，也不占版面 */
      if (pickedPlace.fullName) nameEl.title = pickedPlace.fullName;
      body.appendChild(nameEl);

      /* 副行只放坐标和精度。
         不再重复省市 —— 主行的短名里已经带了城市（“天门市 · 西湖”），
         副行再写一遍“湖北省 · 天门市”就是同一条信息的第二次出现。
         要核对周边环境，悬停看完整地址。 */
      body.appendChild(el('span', 'zg-picked-meta',
        pickedPlace.longitude.toFixed(5) + ', ' + pickedPlace.latitude.toFixed(5)
        + ' · ' + pickedPlace.precision));

      var clearBtn = el('button', 'zg-link-btn', '清除');
      clearBtn.type = 'button';
      clearBtn.addEventListener('click', function () { clear(); });

      pickedBox.appendChild(body);
      pickedBox.appendChild(clearBtn);
      pickedBox.hidden = false;
    }

    function clear() {
      pickedPlace = null;
      pickerLngLat = null;
      if (pickerMarker) pickerMarker.setLngLat([112.8, 30.2]);
      hideResults();
      setStatus('');
      renderPicked();
      notify();
    }

    /* --- 地图选点 --- */

    function pickerStyle() {
      return isDarkMode()
        ? (CONFIG.mapboxDarkStyle || 'mapbox://styles/mapbox/dark-v11')
        : (CONFIG.mapboxLightStyle || 'mapbox://styles/mapbox/light-v11');
    }

    function loadScriptOnce(url) {
      if (glPromise) return glPromise;
      glPromise = new Promise(function (resolve, reject) {
        var script = global.document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = function () { resolve(); };
        script.onerror = function () { reject(new Error('地图库加载失败，检查一下网络')); };
        global.document.head.appendChild(script);
      });
      return glPromise;
    }

    function loadCssOnce(href) {
      if (cssLoaded || global.document.querySelector('link[data-jingzhe-gl]')) {
        cssLoaded = true;
        return;
      }
      var link = global.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-jingzhe-gl', '1');
      global.document.head.appendChild(link);
      cssLoaded = true;
    }

    function setPickerPoint(lngLat) {
      pickerLngLat = lngLat;
      if (pickerMarker) pickerMarker.setLngLat(lngLat);
    }

    async function ensurePickerMap() {
      if (pickerMap) return pickerMap;
      if (!mapboxToken()) throw new Error('缺少 Mapbox 令牌');

      setStatus('正在加载地图库…');
      loadCssOnce(CONFIG.mapboxCssUrl || DEFAULT_GL_CSS);
      await loadScriptOnce(CONFIG.mapboxJsUrl || DEFAULT_GL_JS);
      if (typeof global.mapboxgl === 'undefined') throw new Error('地图库没加载出来');
      if (destroyed) return null;

      global.mapboxgl.accessToken = mapboxToken();
      var start = pickerLngLat
        ? [pickerLngLat.lng, pickerLngLat.lat]
        : (pickedPlace ? [pickedPlace.longitude, pickedPlace.latitude] : [112.8, 30.2]);

      pickerMap = new global.mapboxgl.Map({
        container: mapEl,
        style: pickerStyle(),
        center: start,
        zoom: (pickerLngLat || pickedPlace) ? 12 : 3.5,
        attributionControl: false
      });

      pickerMarker = new global.mapboxgl.Marker({ draggable: true, color: '#994d61' })
        .setLngLat(start)
        .addTo(pickerMap);
      pickerMarker.on('dragend', function () {
        var p = pickerMarker.getLngLat();
        setPickerPoint({ lng: p.lng, lat: p.lat });
      });

      /* 点地图任意处也能放图钉 —— 手机上拖动不如点一下方便 */
      pickerMap.on('click', function (event) {
        setPickerPoint({ lng: event.lngLat.lng, lat: event.lngLat.lat });
      });

      /* 没选过点时，用设备定位作为起点 */
      if (!pickerLngLat && !pickedPlace && global.navigator.geolocation) {
        global.navigator.geolocation.getCurrentPosition(function (position) {
          if (destroyed || !pickerMap) return;
          var here = { lng: position.coords.longitude, lat: position.coords.latitude };
          setPickerPoint(here);
          pickerMap.flyTo({ center: [here.lng, here.lat], zoom: 12 });
        }, function () { /* 拒绝定位就用默认视野 */ },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
      }

      return pickerMap;
    }

    async function togglePicker(force) {
      var show = typeof force === 'boolean' ? force : pickerWrap.hidden;
      if (!show) { pickerWrap.hidden = true; return; }

      pickerWrap.hidden = false;
      pickBtn.disabled = true;
      try {
        await ensurePickerMap();
        setStatus('在地图上拖图钉或点一下，选好点「用这个位置」');
        /* 容器刚显示出来时尺寸是 0，必须 resize 否则地图是灰的 */
        global.setTimeout(function () { if (pickerMap) pickerMap.resize(); }, 60);
      } catch (error) {
        setStatus('地图打不开：' + (error.message || error), true);
        pickerWrap.hidden = true;
      } finally {
        pickBtn.disabled = false;
      }
    }

    async function confirmPicker() {
      if (!pickerLngLat) { setStatus('先在图上选一个位置', true); return; }
      confirmBtn.disabled = true;
      setStatus('正在反查地名…');
      try {
        var feature = await geocodeReverse(pickerLngLat.lng, pickerLngLat.lat);
        var candidate = feature ? candidateFromMapbox(feature) : null;
        if (candidate) {
          selectCandidate(candidate);
          setStatus('已按你选的位置填入，确认地名对不对');
        } else {
          setStatus('这个点反查不到地名（可能太偏），换个说法或直接搜索', true);
        }
      } catch (error) {
        setStatus('反查失败：' + (error.message || error) + '（可重试）', true);
      } finally {
        confirmBtn.disabled = false;
      }
    }

    async function useCurrentLocation() {
      if (!global.navigator.geolocation) { setStatus('这个浏览器不支持定位', true); return; }
      locateBtn.disabled = true;
      setStatus('正在获取位置…（手机上会弹出授权）');
      global.navigator.geolocation.getCurrentPosition(async function (position) {
        if (destroyed) return;
        try {
          var feature = await geocodeReverse(position.coords.longitude, position.coords.latitude);
          var candidate = feature ? candidateFromMapbox(feature) : null;
          if (candidate) {
            selectCandidate(candidate);
            setStatus('已按当前位置填入，确认地名对不对');
          } else {
            setStatus('当前位置反查不到地名，改用「在地图上选点」吧', true);
          }
        } catch (error) {
          setStatus('反查失败：' + (error.message || error), true);
        } finally {
          locateBtn.disabled = false;
        }
      }, function () {
        locateBtn.disabled = false;
        setStatus('拿不到位置（可能被拒绝或超时）', true);
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }

    searchBtn.addEventListener('click', search);
    queryInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); search(); }
    });
    pickBtn.addEventListener('click', function () { togglePicker(); });
    cancelPickBtn.addEventListener('click', function () { togglePicker(false); });
    confirmBtn.addEventListener('click', confirmPicker);
    locateBtn.addEventListener('click', useCurrentLocation);

    setStatus(opts.hint || '搜地名，或在地图上直接点位置');

    return {
      getPlace: function () { return pickedPlace; },
      setPlace: function (place) {
        pickedPlace = place || null;
        pickerLngLat = null;
        renderPicked();
        notify();
      },
      clear: clear,
      destroy: function () {
        destroyed = true;
        if (pickerMap) { try { pickerMap.remove(); } catch (_e) {} pickerMap = null; }
        pickerMarker = null;
        root.innerHTML = '';
      }
    };
  }

  global.JingzhePlace = {
    create: create,
    toPlace: toPlace,
    candidateFromMapbox: candidateFromMapbox,
    candidateFromNominatim: candidateFromNominatim
  };
})(typeof window !== 'undefined' ? window : globalThis);
