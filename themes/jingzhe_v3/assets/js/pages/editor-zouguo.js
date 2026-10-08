/* 走过编辑器 / editor-zouguo.js
 *
 * 与 newlaodao / newsuibi 的区别：那两个是「先拼 markdown 再 PUT 到 GitHub」，
 * 而这里直接调 Worker 的 /api/app/zouguo/publish —— 因为走过记录的
 * front matter 结构复杂（嵌套的 zouguo.place），交
 * 给服务端的 buildZouguoMarkdown 生成更不容易出错，
 * 而且它会校验 place.id / countryCode / 经纬度范围。
 *
 * 服务端对 place 的硬性要求（踩过就知道）：
 *   · place.id        必须匹配 /^[a-z0-9][a-z0-9._:-]{0,199}$/  —— 只能小写
 *   · place.countryCode 必须恰好两位大写字母，如 CN
 *   · longitude ∈ [-180,180]，latitude ∈ [-90,90]
 *   · precision ∈ exact|poi|locality|region|approximate
 *   · occurredAt 必须以 Z 或 ±HH:MM 结尾
 */
(function () {
  'use strict';

  var CONFIG = window.JINGZHE_EDITOR_CONFIG || {};
  var CORE = window.JingzheEditor;
  if (!CORE) return;

  var $ = CORE.byId;
  var secureFetch = CORE.secureFetch;

  var DRAFT_KEY = 'jingzhe_zouguo_draft';
  var LAST_PLACE_KEY = 'jingzhe_zouguo_last_place';

  var pickedPlace = null;
  var pickedFeature = null;
  var imageUrls = [];
  var searchSeq = 0;

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function pad(value) { return String(value).padStart(2, '0'); }

  function setStatus(text, isError) {
    var el = $('placeStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', Boolean(isError));
  }

  /* 发布结果单独显示在按钮旁边，并滚动到可见处。
     手机上这个表单很长，写在顶部的提示滚下来按按钮之后根本看不到 —— 
     用户看到的就是「点了没反应」。这是实打实踩过的坑。 */
  function setSubmitStatus(text, kind) {
    var el = $('submitStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-error', 'is-ok');
    if (kind === 'error') el.classList.add('is-error');
    if (kind === 'ok') el.classList.add('is-ok');
    if (text) {
      try {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (_error) {
        el.scrollIntoView();
      }
    }
  }

  /* datetime-local 的 "2026-10-08T14:30" → 带本机时区的 ISO
     服务端要求结尾是 Z 或 ±HH:MM，否则 validTimestamp 直接拒 */
  function isoWithOffset(localValue) {
    var date = new Date(localValue);
    if (Number.isNaN(date.getTime())) return '';
    var offset = -date.getTimezoneOffset();
    var sign = offset >= 0 ? '+' : '-';
    var abs = Math.abs(offset);
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':00' +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
    );
  }

  function nowLocalValue() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function isDarkMode() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /* ------------------------------------------------------------------ */
  /* Mapbox 地理编码                                                     */
  /* ------------------------------------------------------------------ */

  function mapboxToken() { return CONFIG.mapboxToken || ''; }

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

  async function geocodeForward(keyword, worldwide) {
    var token = mapboxToken();
    if (!token) throw new Error('缺少 Mapbox 令牌，无法搜索地名');
    var scope = worldwide ? '' : '&country=cn';
    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
      encodeURIComponent(keyword) + '.json?language=zh-Hans&limit=6' + scope +
      '&access_token=' + encodeURIComponent(token);
    var data = await fetchJson(url, 3);
    return (data && data.features) || [];
  }

  async function geocodeReverse(longitude, latitude) {
    var token = mapboxToken();
    if (!token) throw new Error('缺少 Mapbox 令牌，无法反查地名');
    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
      longitude + ',' + latitude + '.json?language=zh-Hans&limit=1' +
      '&types=place,locality,neighborhood,region,postcode&access_token=' +
      encodeURIComponent(token);
    var data = await fetchJson(url, 3);
    return ((data && data.features) || [])[0] || null;
  }

  /* 由 place_type 推精度（服务端只接受固定的几个值） */
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

  /* Mapbox feature → 服务端 place 结构 */
  function toPlace(feature) {
    var center = feature.center || feature.geometry && feature.geometry.coordinates || [];
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

    /* id 只能用小写字母数字和 . _ : - */
    var rawId = String(feature.id || '').toLowerCase().replace(/[^a-z0-9._:-]/g, '-');
    var id = 'mapbox:' + (rawId || 'x' + Date.now());

    return {
      id: id,
      name: String(feature.place_name || feature.text || ''),
      longitude: longitude,
      latitude: latitude,
      precision: precisionOf(feature),
      privacy: 'public',
      country: (countryEntry && countryEntry.text) || '',
      countryCode: countryCode,
      region: (regionEntry && regionEntry.text) || '',
      regionCode: (regionEntry && regionEntry.short_code) || '',
      locality: (placeEntry && placeEntry.text) || (localityEntry && localityEntry.text) || '',
      localityCode: '',
      provider: 'mapbox',
      providerId: String(feature.id || '')
    };
  }

  /* ------------------------------------------------------------------ */
  /* 候选地点：把两个数据源统一成同一种形状                               */
  /* Mapbox 的 feature 和 Nominatim 的 item 结构差得很远，与其在渲染处   */
  /* 到处判断来源，不如各自先转成统一的候选对象。                         */
  /* ------------------------------------------------------------------ */

  function candidateFromMapbox(feature) {
    try {
      return {
        name: feature.text || feature.place_name || '',
        fullName: feature.place_name || '',
        place: toPlace(feature)
      };
    } catch (_error) {
      return null;                       // 缺国家代码之类的结果直接丢掉
    }
  }

  /* Nominatim（OpenStreetMap）：国内景区覆盖比 Mapbox 好得多，
     Mapbox 搜不到时作为补充。OSM 的 country_code 是小写，要转大写。 */
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

    return {
      name: item.name || String(item.display_name || '').split(',')[0] || '',
      fullName: item.display_name || '',
      place: {
        id: id,
        name: item.display_name || item.name || '',
        longitude: longitude,
        latitude: latitude,
        precision: precision,
        privacy: 'public',
        country: address.country || '',
        countryCode: countryCode,
        region: address.state || address.province || '',
        regionCode: '',
        locality: locality,
        localityCode: '',
        provider: 'nominatim',
        providerId: item.osm_type ? (item.osm_type + '/' + item.osm_id) : ''
      }
    };
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

  /* 静态地图预览：一张图就够，不用加载 1.85MB 的 mapbox-gl */
  function staticMapUrl(place, width, height) {
    var token = mapboxToken();
    if (!token) return '';
    var style = isDarkMode() ? 'dark-v11' : 'light-v11';
    var pin = '994d61';
    var lon = place.longitude.toFixed(6);
    var lat = place.latitude.toFixed(6);
    return 'https://api.mapbox.com/styles/v1/mapbox/' + style + '/static/' +
      'pin-s+' + pin + '(' + lon + ',' + lat + ')/' + lon + ',' + lat + ',11/' +
      width + 'x' + height + '@2x?access_token=' + encodeURIComponent(token);
  }

  /* ------------------------------------------------------------------ */
  /* 搜索与选择                                                          */
  /* ------------------------------------------------------------------ */

  async function searchPlace() {
    var input = $('placeQuery');
    var keyword = (input && input.value || '').trim();
    if (!keyword) { setStatus('先输入一个地名'); return; }

    var worldwide = Boolean($('searchGlobal') && $('searchGlobal').checked);
    var seq = ++searchSeq;
    var button = $('searchBtn');
    if (button) button.disabled = true;
    setStatus('搜索中…');
    hideResults();

    try {
      /* 两个数据源一起查，合并去重。
         Mapbox 对国内景区覆盖有限，OpenStreetMap 常常有；反过来
         Mapbox 对国外地名、连锁店更全。所以谁也别替代谁。 */
      var settled = await Promise.all([
        geocodeForward(keyword, worldwide)
          .then(function (list) {
            return list.map(candidateFromMapbox).filter(Boolean);
          })
          .catch(function () { return []; }),
        searchNominatim(keyword, worldwide).catch(function () { return []; })
      ]);
      if (seq !== searchSeq) return;                 // 有更新的搜索了，丢弃

      var candidates = settled[0].concat(settled[1]);
      // 按「经度,纬度」粗粒度去重（两个源常有同一条）
      var seen = {};
      candidates = candidates.filter(function (item) {
        var key = item.place.longitude.toFixed(3) + ',' + item.place.latitude.toFixed(3);
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });

      if (!candidates.length) {
        setStatus('两个数据源都没找到。换个写法，勾「搜索全球」，或者点「在地图上选点」直接标位置。');
        return;
      }
      setStatus('找到 ' + candidates.length + ' 个，点一个确认');
      renderResults(candidates);
    } catch (error) {
      if (seq !== searchSeq) return;
      setStatus('搜索失败：' + (error.message || error) + '（可重试）', true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function hideResults() {
    var list = $('placeResults');
    if (!list) return;
    list.hidden = true;
    list.innerHTML = '';
  }

  function renderResults(candidates) {
    var list = $('placeResults');
    if (!list) return;
    list.innerHTML = '';
    candidates.forEach(function (candidate) {
      var li = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'zg-result';

      var name = document.createElement('span');
      name.className = 'zg-result-name';
      name.textContent = candidate.name;

      var addr = document.createElement('span');
      addr.className = 'zg-result-addr';
      addr.textContent = candidate.fullName;

      button.appendChild(name);
      button.appendChild(addr);
      button.addEventListener('click', function () { selectCandidate(candidate); });
      li.appendChild(button);
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function selectCandidate(candidate) {
    if (!candidate || !candidate.place) return;
    var place = candidate.place;
    pickedFeature = null;
    pickedPlace = place;
    hideResults();
    setStatus('');
    renderPicked();

    /* 记住上次的位置，下次搜索可以偏置（暂未用于偏置，仅作记录） */
    try {
      localStorage.setItem(LAST_PLACE_KEY, JSON.stringify(place));
    } catch (_error) { /* localStorage 不可用就算了 */ }

    /* 没填标题时自动带上地点名 */
    var titleInput = $('title');
    if (titleInput && !titleInput.value.trim()) {
      var shortName = (candidate.name || place.name.split(',')[0] || '').trim();
      if (shortName) titleInput.value = shortName;
    }
  }

  function renderPicked() {
    var step = $('pickedStep');
    var img = $('pickedMap');
    if (!step || !pickedPlace) return;

    if (img) {
      img.src = staticMapUrl(pickedPlace, 640, 320);
      img.alt = pickedPlace.name + ' 的位置预览';
    }
    var nameEl = $('pickedName');
    if (nameEl) nameEl.textContent = pickedPlace.name;
    var metaEl = $('pickedMeta');
    if (metaEl) {
      metaEl.textContent = pickedPlace.latitude.toFixed(5) + ', ' +
        pickedPlace.longitude.toFixed(5) + ' · ' + pickedPlace.precision;
    }
    step.hidden = false;
    scheduleDraftSave();
  }

  function clearPlace() {
    pickedPlace = null;
    pickedFeature = null;
    var step = $('pickedStep');
    if (step) step.hidden = true;
    setStatus('已清除，重新搜索或点「用当前位置」');
    scheduleDraftSave();
  }

  /* ------------------------------------------------------------------ */
  /* 地图选点：搜不到的地方（很多国内景区 Mapbox 里没有）直接拖点          */
  /*                                                                     */
  /* mapbox-gl 有 1.85MB，所以按需懒加载 —— 不点这个按钮就不下载。        */
  /* 库文件走国内镜像 npmmirror（官方源在国内 0/4 通不过）。              */
  /*                                                                     */
  /* 这里刻意用 outdoors-v12 而不是走过页那套极简样式：选点需要能看清     */
  /* 地形、道路和 POI，越简的地图越找不到地方。                           */
  /* ------------------------------------------------------------------ */

  var GL_JS = 'https://registry.npmmirror.com/mapbox-gl/3.26.0/files/dist/mapbox-gl.js';
  var GL_CSS = 'https://registry.npmmirror.com/mapbox-gl/3.26.0/files/dist/mapbox-gl.css';

  /* 选点地图用站点自己的样式，不再写死 outdoors-v12。
     原因有二：
       1. 观感要和走过页一致（之前编辑器显示的是旧样式，用户一眼就看出来了）
       2. 自建样式关掉了 POI/路名/3D，比 outdoors 轻得多 —— 手机上更流畅 */
  function pickerStyle() {
    return isDarkMode()
      ? (CONFIG.mapboxDarkStyle || 'mapbox://styles/mapbox/dark-v11')
      : (CONFIG.mapboxLightStyle || 'mapbox://styles/mapbox/light-v11');
  }

  var pickerMap = null;
  var pickerMarker = null;
  var pickerLngLat = null;
  var glPromise = null;

  function loadScriptOnce(url) {
    if (glPromise) return glPromise;
    glPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('地图库加载失败，检查一下网络')); };
      document.head.appendChild(script);
    });
    return glPromise;
  }

  function loadCssOnce(href) {
    if (document.querySelector('link[data-zg-gl]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-zg-gl', '1');
    document.head.appendChild(link);
  }

  function setPickerPoint(lngLat) {
    pickerLngLat = lngLat;
    if (pickerMarker) pickerMarker.setLngLat(lngLat);
  }

  async function ensurePickerMap() {
    if (pickerMap) return pickerMap;
    var token = mapboxToken();
    if (!token) throw new Error('缺少 Mapbox 令牌');

    setStatus('正在加载地图库…');
    loadCssOnce(GL_CSS);
    await loadScriptOnce(GL_JS);
    if (typeof mapboxgl === 'undefined') throw new Error('地图库没加载出来');

    mapboxgl.accessToken = token;
    pickerMap = new mapboxgl.Map({
      container: 'pickerMap',
      style: pickerStyle(),
      center: pickerLngLat ? [pickerLngLat.lng, pickerLngLat.lat] : [112.8, 30.2],
      zoom: pickerLngLat ? 12 : 3.5,
      attributionControl: false
    });

    pickerMarker = new mapboxgl.Marker({ draggable: true, color: '#994d61' })
      .setLngLat([pickerLngLat ? pickerLngLat.lng : 112.8,
                  pickerLngLat ? pickerLngLat.lat : 30.2])
      .addTo(pickerMap);
    pickerMarker.on('dragend', function () {
      var p = pickerMarker.getLngLat();
      setPickerPoint({ lng: p.lng, lat: p.lat });
    });

    /* 点地图任意处也能放图钉 —— 手机上拖动不如点一下方便 */
    pickerMap.on('click', function (event) {
      setPickerPoint({ lng: event.lngLat.lng, lat: event.lngLat.lat });
    });

    /* 定位到当前位置作为起点 */
    if (!pickerLngLat && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (position) {
        var here = { lng: position.coords.longitude, lat: position.coords.latitude };
        setPickerPoint(here);
        pickerMap.flyTo({ center: [here.lng, here.lat], zoom: 12 });
      }, function () { /* 拒绝定位就用默认视野 */ },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }

    return pickerMap;
  }

  async function toggleMapPicker(force) {
    var wrap = $('pickerWrap');
    if (!wrap) return;
    var show = typeof force === 'boolean' ? force : wrap.hidden;
    if (!show) { wrap.hidden = true; return; }

    wrap.hidden = false;
    var button = $('pickerBtn');
    if (button) button.disabled = true;
    try {
      await ensurePickerMap();
      setStatus('在地图上拖图钉或点一下，选好点「用这个位置」');
      /* 容器刚显示出来时尺寸是 0，必须 resize 否则地图是灰的 */
      window.setTimeout(function () { if (pickerMap) pickerMap.resize(); }, 60);
    } catch (error) {
      setStatus('地图打不开：' + (error.message || error), true);
      wrap.hidden = true;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function confirmPicker() {
    if (!pickerLngLat) {
      setStatus('先在图上选一个位置', true);
      return;
    }
    var button = $('pickerConfirm');
    if (button) button.disabled = true;
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
      if (button) button.disabled = false;
    }
  }

  async function useCurrentLocation() {
    if (!navigator.geolocation) {
      setStatus('这个浏览器不支持定位', true);
      return;
    }
    var button = $('locateBtn');
    if (button) button.disabled = true;
    setStatus('正在获取位置…（手机上会弹出授权）');

    navigator.geolocation.getCurrentPosition(async function (position) {
      var latitude = position.coords.latitude;
      var longitude = position.coords.longitude;
      setStatus('已定位，正在反查地名…');
      try {
        var feature = await geocodeReverse(longitude, latitude);
        if (feature) {
          var candidate = candidateFromMapbox(feature);
          if (candidate) {
            selectCandidate(candidate);
            setStatus('已按当前位置填入，确认一下地名对不对');
          } else {
            setStatus('反查到的地点缺少国家信息，请手动搜索', true);
          }
        } else {
          setStatus('反查不到地名，请手动搜索，或点「在地图上选点」', true);
        }
      } catch (error) {
        setStatus('反查失败：' + (error.message || error), true);
      } finally {
        if (button) button.disabled = false;
      }
    }, function () {
      setStatus('定位被拒绝或失败，请手动搜索地名', true);
      if (button) button.disabled = false;
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  /* ------------------------------------------------------------------ */
  /* 图片                                                                */
  /* ------------------------------------------------------------------ */

  function renderImages() {
    var box = $('imageList');
    if (!box) return;
    box.innerHTML = '';
    imageUrls.forEach(function (url, index) {
      var wrap = document.createElement('div');
      wrap.className = 'zg-image';

      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'zg-image-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', '移除这张图片');
      remove.addEventListener('click', function () {
        imageUrls.splice(index, 1);
        renderImages();
        scheduleDraftSave();
      });

      wrap.appendChild(img);
      wrap.appendChild(remove);
      box.appendChild(wrap);
    });
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    var maximum = 12;
    setStatus('正在上传 ' + files.length + ' 张图片…');
    for (var i = 0; i < files.length; i += 1) {
      if (imageUrls.length >= maximum) {
        setStatus('最多 ' + maximum + ' 张图片', true);
        break;
      }
      try {
        var uploaded = await CORE.uploadImage(files[i], CONFIG, 'zouguo');
        imageUrls.push(uploaded.url);
        renderImages();
      } catch (error) {
        setStatus('有图片上传失败：' + (error.message || error), true);
      }
    }
    setStatus('');
    scheduleDraftSave();
  }

  /* ------------------------------------------------------------------ */
  /* 草稿                                                                */
  /* ------------------------------------------------------------------ */

  var draftTimer = null;
  function scheduleDraftSave() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      CORE.saveDraft(DRAFT_KEY, {
        query: ($('placeQuery') || {}).value || '',
        title: ($('title') || {}).value || '',
        content: ($('content') || {}).value || '',
        occurredAt: ($('occurredAt') || {}).value || '',
        place: pickedPlace,
        images: imageUrls
      });
    }, 800);
  }

  function saveLocalDraft() {
    scheduleDraftSave();
    setStatus('已暂存在这台设备上（未提交）');
  }

  function restoreDraft() {
    var draft = CORE.loadDraft(DRAFT_KEY);
    if (!draft) return;
    if (draft.query && $('placeQuery')) $('placeQuery').value = draft.query;
    if (draft.title && $('title')) $('title').value = draft.title;
    if (draft.content && $('content')) $('content').value = draft.content;
    if (draft.occurredAt && $('occurredAt')) $('occurredAt').value = draft.occurredAt;
    if (Array.isArray(draft.images)) { imageUrls = draft.images.slice(); renderImages(); }
    if (draft.place && draft.place.id) {
      pickedPlace = draft.place;
      renderPicked();
      setStatus('恢复了上次没发完的草稿');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 发布                                                                */
  /* ------------------------------------------------------------------ */

  async function publishZouguo() {
    if (!pickedPlace) {
      setSubmitStatus('还没选地点 —— 先在上面搜一个，或点「在地图上选点」', 'error');
      setStatus('先选一个地点', true);
      var step = $('pickedStep');
      var query = $('placeQuery');
      (query || step || { scrollIntoView: function () {} }).scrollIntoView({ block: 'center' });
      return;
    }

    var occurredLocal = ($('occurredAt') || {}).value || '';
    var occurredAt = isoWithOffset(occurredLocal || nowLocalValue());
    if (!occurredAt) { setSubmitStatus('时间格式不对', 'error'); return; }

    var title = (($('title') || {}).value || '').trim();
    var content = (($('content') || {}).value || '').trim();

    var requestId = 'web-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);

    var body = {
      occurredAt: occurredAt,
      publishedAt: new Date().toISOString(),
      content: content || title || pickedPlace.name,
      place: pickedPlace,
      images: imageUrls,
      requestId: requestId
    };
    if (title) body.title = title;

    var button = $('submitBtn');
    if (button) { button.disabled = true; button.textContent = '记录中…'; }
    setSubmitStatus('正在保存…');

    try {
      var response = await secureFetch(CONFIG.workerUrl + '/api/app/zouguo/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));

      CORE.removeDraft(DRAFT_KEY);
      setSubmitStatus('✓ 已记录，正在跳转到走过地图…', 'ok');
      setStatus('✓ 已记录：' + (payload.path || ''));
      imageUrls = [];
      renderImages();
      setTimeout(function () { window.location.href = '/zouguo/'; }, 1200);
    } catch (error) {
      var message = error && error.message === '401' ? '口令错误或已失效，请重新验证' : (error.message || error);
      setSubmitStatus('保存失败：' + message, 'error');
      setStatus('保存失败：' + message, true);
      if (button) { button.disabled = false; button.textContent = '记下走过'; }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 鉴权与启动                                                          */
  /* ------------------------------------------------------------------ */

  async function verifyToken() {
    var input = $('adminTokenInput');
    var token = (input && input.value || '').trim();
    if (!token) return;
    CORE.setAdminToken(token);
    try {
      await secureFetch(CONFIG.workerUrl + '/api/github', {
        headers: { 'x-target-url': CORE.repositoryUrl(CONFIG) }
      });
      $('loginOverlay').style.display = 'none';
      $('adminPanel').style.display = 'block';
      initPanel();
    } catch (_error) {
      CORE.clearAdminToken();
      if (input) input.value = '';
      input && input.setAttribute('placeholder', '口令不对，重试');
    }
  }

  var panelReady = false;

  function initPanel() {
    if (panelReady) return;
    panelReady = true;

    if ($('occurredAt') && !$('occurredAt').value) $('occurredAt').value = nowLocalValue();
    restoreDraft();

    var form = $('zgForm');
    if (form) {
      form.addEventListener('input', scheduleDraftSave);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        publishZouguo();
      });
    }

    var query = $('placeQuery');
    if (query) {
      query.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); searchPlace(); }
      });
    }

    var fileInput = $('imageInput');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        handleFiles(fileInput.files);
        fileInput.value = '';
      });
    }
  }

  function initApp() {
    var overlay = $('loginOverlay');
    var panel = $('adminPanel');
    var token = CORE.getAdminToken();

    if (!token) {
      if (overlay) overlay.style.display = 'flex';
      return;
    }

    /* 存量口令必须先验证再展开面板。
       原来只要 localStorage 里有东西就无条件显示面板 —— 于是口令一改，
       用户看到的是能用的界面、一发就 401「口令错误或已失效」，
       而且因为看不到登录框，根本没地方重新输入，成了死循环。
       现在验证不过就清掉并退回登录框。 */
    secureFetch(CONFIG.workerUrl + '/api/github', {
      headers: { 'x-target-url': CORE.repositoryUrl(CONFIG) }
    }).then(function () {
      if (overlay) overlay.style.display = 'none';
      if (panel) panel.style.display = 'block';
      initPanel();
    }).catch(function () {
      CORE.clearAdminToken();
      if (panel) panel.style.display = 'none';
      if (overlay) overlay.style.display = 'flex';
      var input = $('adminTokenInput');
      if (input) {
        input.value = '';
        input.setAttribute('placeholder', '口令已失效，请重新输入');
      }
    });
  }

  /* 面板里的「换个口令」：清掉本地口令并回到登录框 */
  function changeToken() {
    CORE.clearAdminToken();
    var panel = $('adminPanel');
    var overlay = $('loginOverlay');
    if (panel) panel.style.display = 'none';
    if (overlay) overlay.style.display = 'flex';
    var input = $('adminTokenInput');
    if (input) { input.value = ''; input.focus(); }
  }

  window.verifyToken = verifyToken;
  window.searchPlace = searchPlace;
  window.useCurrentLocation = useCurrentLocation;
  window.clearPlace = clearPlace;
  window.publishZouguo = publishZouguo;
  window.saveLocalDraft = saveLocalDraft;
  window.toggleMapPicker = toggleMapPicker;
  window.confirmPicker = confirmPicker;
  window.changeToken = changeToken;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
