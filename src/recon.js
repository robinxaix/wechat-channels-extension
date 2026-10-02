/**
 * 侦察模式 · 隔离世界（ISOLATED world）UI 与 DOM 扫描。
 *
 * 只在发布页（platform/post/create）注入悬浮面板，提供：
 *   1) 采集 DOM：扫描上传 input / 标题框 / 描述编辑器 / 定时选择器 / 原创·标注控件 / 发表按钮，产出选择器地图。
 *   2) 开始/停止抓包：向主世界 recon-main.js 发命令，记录页面自己的上传/发表网络请求。
 *   3) 导出报告：把 DOM 地图 + 网络日志合成 recon-report.json，下载并复制到剪贴板。
 *
 * 默认不记录网络（需手动「开始抓包」），且只在发布页展示面板，不影响现有评论功能。
 */
(function () {
  'use strict';

  if (globalThis.__WXCH_RECON__) return;
  globalThis.__WXCH_RECON__ = true;

  var SHOW_PANEL = /channels\.weixin\.qq\.com/.test(location.href);
  var netLog = [];
  var domMap = null;
  var capturing = false;

  // 主世界脚本（recon-main.js）注入：通过 web_accessible_resources 以 <script src> 注入到页面，
  // 规避 manifest 的 world 字段在旧版 Chrome 的兼容问题。失败仅影响网络抓包，DOM 扫描仍可用。
  function injectMainWorld() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return;
      var s = document.createElement('script');
      s.src = chrome.runtime.getURL('src/recon-main.js');
      s.onerror = function () {
        if (statusEl) setStatus('主世界脚本注入失败：网络抓包不可用（DOM 扫描仍可用）。');
      };
      s.onload = function () {
        s.remove();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      /* 忽略：网络抓包降级 */
    }
  }
  injectMainWorld();

  // 主世界回传的网络条目
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.__WXCH_RECON_NET__) {
      netLog.push(e.data.entry);
      if (statusEl) setStatus('已捕获网络请求 ' + netLog.length + ' 条。');
    }
  });

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).visibility !== 'hidden') {
      // offsetParent null 可能是 fixed 或 display:none；用更宽松判断
    }
    var s = getComputedStyle(el);
    return !(s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0');
  }

  function bestSelector(el) {
    if (!el) return null;
    if (el.id) return '#' + el.id;
    if (el.name) return (el.tagName || '').toLowerCase() + '[name="' + el.name + '"]';
    if (el.getAttribute && el.getAttribute('data-qa')) return (el.tagName || '').toLowerCase() + '[data-qa="' + el.getAttribute('data-qa') + '"]';
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) return (el.tagName || '').toLowerCase() + '.' + cls;
    }
    return (el.tagName || '').toLowerCase();
  }

  function nearbyText(el) {
    if (!el) return '';
    var sibs = el.parentElement ? el.parentElement.children : [];
    var out = '';
    for (var i = 0; i < sibs.length; i++) {
      if (sibs[i] !== el) out += (sibs[i].innerText || sibs[i].textContent || '') + ' ';
    }
    var prev = el.previousElementSibling;
    if (prev) out += prev.innerText || prev.textContent || '';
    return (out + ' ' + ((el.parentElement && el.parentElement.innerText) || '')).slice(0, 200);
  }

  function nearestLabel(el) {
    if (!el) return '';
    var l = el.closest('label');
    if (l) return (l.innerText || l.textContent || '').trim().slice(0, 40);
    var id = el.id;
    if (id) {
      var lab = document.querySelector('label[for="' + id + '"]');
      if (lab) return (lab.innerText || lab.textContent || '').trim().slice(0, 40);
    }
    return (nearbyText(el) || '').slice(0, 40);
  }

  function scanDom() {
    var map = {
      at: new Date().toISOString(),
      url: location.href,
      iframes: [],
      fileInputs: [],
      titleCandidates: [],
      descCandidates: [],
      scheduleCandidates: [],
      declareCandidates: [],
      publishButtons: [],
      allInputs: [],
    };

    function classify(el, frame) {
      var tag = (el.tagName || '').toLowerCase();
      var ph = (el.getAttribute && el.getAttribute('placeholder')) || '';
      var nb = nearbyText(el);
      var ctxLow = (ph + ' ' + nb).toLowerCase();

      // 文件输入（含隐藏）
      if (tag === 'input' && (el.type === 'file' || (el.getAttribute && el.getAttribute('type') === 'file'))) {
        map.fileInputs.push({
          selector: bestSelector(el), id: el.id, name: el.name,
          accept: el.accept, multiple: el.multiple, visible: isVisible(el),
          parent: bestSelector(el.parentElement), frame: frame,
        });
      }

      // 文本输入 / textarea（标题 / 描述 / 定时候选）
      if (tag === 'textarea' || (tag === 'input' && (!el.type || el.type === 'text' || el.type === 'search'))) {
        var info = {
          selector: bestSelector(el), id: el.id, name: el.name,
          placeholder: (el.placeholder || '').slice(0, 60), visible: isVisible(el), frame: frame,
        };
        map.allInputs.push(info);
        if (/标题|title/.test(ctxLow)) map.titleCandidates.push(info);
        if (/描述|简介|desc|description/.test(ctxLow)) map.descCandidates.push(info);
        if (/定时|时间|date|schedule/.test(ctxLow)) map.scheduleCandidates.push(info);
      }

      // contenteditable（描述常为富文本）
      var ce = el.getAttribute && el.getAttribute('contenteditable');
      if (ce != null && ce !== 'false') {
        var ci = { selector: bestSelector(el), tag: tag, text: (el.innerText || '').slice(0, 40), visible: isVisible(el), frame: frame };
        map.descCandidates.push(ci);
        if (/标题|title/.test(nb.toLowerCase())) map.titleCandidates.push(ci);
      }

      // 勾选 / 开关（原创声明、标注）
      var role = (el.getAttribute && el.getAttribute('role')) || '';
      if ((tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) || role === 'switch' || role === 'checkbox') {
        map.declareCandidates.push({
          selector: bestSelector(el), id: el.id, name: el.name,
          label: nearestLabel(el), checked: el.checked, visible: isVisible(el), frame: frame,
        });
      }

      // 按钮（发表 / 发布 / 提交）
      var txt = (el.innerText || el.textContent || '').trim().slice(0, 30);
      if (/发表|发布|提交|确定|save|publish/i.test(txt)) {
        map.publishButtons.push({ selector: bestSelector(el), text: txt, disabled: el.disabled, visible: isVisible(el), frame: frame, tag: tag });
      }
    }

    // 递归穿透 Shadow DOM 与同源 iframe（视频号发布页的表单常在其中）
    function walk(doc) {
      if (!doc || !doc.querySelectorAll) return;
      var frame = doc.URL || location.href;
      var els = doc.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        classify(el, frame);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
      var ifs = doc.querySelectorAll('iframe');
      for (var j = 0; j < ifs.length; j++) {
        var fr = ifs[j];
        var src = fr.src || fr.getAttribute('src') || '';
        try {
          if (fr.contentDocument) {
            walk(fr.contentDocument);
            map.iframes.push({ src: src.slice(0, 160), scanned: true });
          } else {
            map.iframes.push({ src: src.slice(0, 160), scanned: false });
          }
        } catch (e) {
          map.iframes.push({ src: src.slice(0, 160), crossOrigin: true });
        }
      }
    }
    walk(document);
    return map;
  }

  function buildReport() {
    return {
      meta: {
        collectedAt: new Date().toISOString(),
        pageUrl: location.href,
        note: '由视频号评论助手「侦察模式」采集。UI 改版后请重采。',
        selectorCount: domMap
          ? domMap.fileInputs.length +
            domMap.titleCandidates.length +
            domMap.descCandidates.length +
            domMap.scheduleCandidates.length +
            domMap.declareCandidates.length +
            domMap.publishButtons.length
          : 0,
        netCount: netLog.length,
      },
      dom: domMap,
      network: netLog,
    };
  }

  function downloadReport() {
    var report = buildReport();
    var text = JSON.stringify(report, null, 2);
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'recon-report.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      setStatus('下载失败：' + (e && e.message ? e.message : e));
    }
    // 同时复制到剪贴板，便于直接粘贴回来
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
    if (jsonEl) jsonEl.value = text; // 兜底：文本框手动复制
    return report;
  }

  // ---------- UI ----------
  var statusEl = null;
  var jsonEl = null;

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }

  function sendCmd(cmd) {
    window.postMessage({ __WXCH_RECON_CMD__: cmd }, '*');
  }

  if (!SHOW_PANEL || window !== window.top) return; // 仅顶层框架显示面板；子框架只注入主世界抓包

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
    '.launch{position:fixed;left:20px;bottom:20px;z-index:2147483647;padding:8px 12px;border:none;border-radius:18px;',
    'background:#1769ff;color:#fff;font-size:12px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.2)}',
    '.panel{position:fixed;left:20px;bottom:20px;z-index:2147483647;width:360px;max-height:80vh;display:flex;flex-direction:column;',
    'background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;color:#1f2329;font-size:12px}',
    '.bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1769ff;color:#fff}',
    '.bar strong{font-size:12px;font-weight:600}.bar .grow{flex:1}',
    '.bar button{background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer}',
    '.body{padding:10px;overflow:auto}',
    'button.act{width:100%;padding:8px;margin-bottom:6px;border:1px solid #dcdfe6;background:#fff;border-radius:8px;font-size:12px;cursor:pointer;color:#1f2329}',
    'button.act.primary{background:#1769ff;border-color:#1769ff;color:#fff}',
    'button.act.warn{background:#e6a23c;border-color:#e6a23c;color:#fff}',
    'button.act:hover{filter:brightness(.97)}',
    '.status{font-size:11px;color:#646a73;margin-bottom:8px;white-space:pre-wrap;word-break:break-all}',
    '.hint{font-size:11px;color:#8a9099;line-height:1.5;margin-bottom:8px}',
    '.json{width:100%;height:160px;border:1px solid #dcdfe6;border-radius:8px;padding:8px;font-size:10px;',
    'font-family:ui-monospace,Menlo,Consolas,monospace;resize:vertical;color:#1f2329;margin-bottom:6px;white-space:pre;background:#f7f8fa}',
  ].join('');

  var host = document.createElement('div');
  host.id = 'wxch-recon-root';
  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  var launcher = document.createElement('button');
  launcher.className = 'launch';
  launcher.textContent = '侦察';
  launcher.onclick = function () {
    panel.style.display = 'flex';
    launcher.style.display = 'none';
  };
  root.appendChild(launcher);

  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.display = 'none';
  panel.innerHTML = [
    '<div class="bar"><strong>发布页侦察模式</strong><span class="grow"></span><button data-act="close">收起</button></div>',
    '<div class="body">',
    '<div class="hint">① 先「采集 DOM」拿选择器地图。② 点「开始抓包」，然后在页面里做一次真实上传/填标题/点发表（用于捕获接口）。③ 「导出报告」下载 recon-report.json（已同时复制剪贴板）。</div>',
    '<button class="act primary" data-act="dom">采集 DOM</button>',
    '<button class="act" data-act="start">开始抓包</button>',
    '<button class="act warn" data-act="stop">停止抓包</button>',
    '<button class="act primary" data-act="export">导出报告</button>',
    '<button class="act" data-act="copy">复制文本框 JSON</button>',
    '<textarea class="json" data-el="json" readonly placeholder="点「导出报告」后，报告 JSON 显示在此，可手动全选复制（下载/剪贴板被拦时的兜底）"></textarea>',
    '<div class="status" data-el="status">就绪。打开发布页后点「采集 DOM」。</div>',
    '</div>',
  ].join('');
  root.appendChild(panel);

  statusEl = panel.querySelector('[data-el=status]');
  panel.querySelector('[data-act=close]').onclick = function () {
    panel.style.display = 'none';
    launcher.style.display = 'block';
  };
  panel.querySelector('[data-act=dom]').onclick = function () {
    domMap = scanDom();
    setStatus(
      'DOM 采集完成：file=' +
        domMap.fileInputs.length +
        ' title=' +
        domMap.titleCandidates.length +
        ' desc=' +
        domMap.descCandidates.length +
        ' declare=' +
        domMap.declareCandidates.length +
        ' publish=' +
        domMap.publishButtons.length,
    );
  };
  panel.querySelector('[data-act=start]').onclick = function () {
    capturing = true;
    sendCmd('start');
    setStatus('抓包中…（去页面做一次真实上传/发表）已捕获 ' + netLog.length + ' 条。');
  };
  panel.querySelector('[data-act=stop]').onclick = function () {
    capturing = false;
    sendCmd('stop');
    setStatus('已停止抓包。共捕获 ' + netLog.length + ' 条网络请求。');
  };
  panel.querySelector('[data-act=export]').onclick = function () {
    var r = downloadReport();
    setStatus('已导出 recon-report.json（含 DOM ' + (r.dom ? '已采集' : '未采集') + '，网络 ' + r.network.length + ' 条）。底部文本框也已填充，可手动复制。');
  };
  panel.querySelector('[data-act=copy]').onclick = function () {
    if (!jsonEl || !jsonEl.value) {
      setStatus('请先点「导出报告」生成内容。');
      return;
    }
    jsonEl.select();
    try {
      document.execCommand('copy');
      setStatus('已复制文本框 JSON（execCommand 兜底）。');
    } catch (e) {
      setStatus('自动复制失败，请手动全选文本框内容复制。');
    }
  };

  function mount() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    document.body.appendChild(host);
    launcher.style.display = 'block';
  }
  mount();
})();
