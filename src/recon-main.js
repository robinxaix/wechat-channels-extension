/**
 * 侦察模式 · 主世界（MAIN world）网络抓包。
 *
 * 为什么在 MAIN world：发布页自己的上传/发表请求由页面 JS 发起，
 * 扩展默认内容脚本跑在隔离世界，patch 不到页面的 window.fetch / XMLHttpRequest。
 * 这里注入到主世界完成拦截，再 postMessage 回隔离世界的 recon.js 汇总。
 *
 * 仅当收到 `{__WXCH_RECON_CMD__:'start'}` 才开始记录。
 * 捕获规则（见 shouldCapture）：写操作（POST/PUT/PATCH/DELETE）全收；GET 仅当 URL 明确涉及
 * 上传/发表（upload/publish/post/create/draft/cos/myqcloud/finder）。并排除 WeChat 埋点信标
 *（路径含 /helper/、mmdata、merlin、beacon、report_），避免把 100+ 条埋点噪声塞进报告。
 */
(function () {
  'use strict';

  if (window.__WXCH_RECON_MAIN__) return;
  window.__WXCH_RECON_MAIN__ = true;

  // 注入即默认开启抓包：发布页本就是目标场景，且滤镜已剔除埋点噪声，
  // 默认开可避免「用户忘了点开始抓包 / 注入就绪前就上传」导致的 0 条问题。
  var ENABLED = true;
  // 仅记录「写操作（POST/PUT/PATCH/DELETE）」或「明确与上传/发表相关」的请求。
  // 宽泛令牌（object/media/image/cover/video）已移除，避免匹配到埋点信标。
  var INTEREST = /upload|publish|post[/_-]|create|draft|\bcos\b|myqcloud|finder/i;
  // 排除 WeChat 埋点信标：路径含 helper / mmdata / merlin / beacon / report_ 的 GET 噪声。
  // 注意 mmfinderassistant-bin 既承载真实发表 cgi 也承载 helper 埋点，靠 /helper/ 子路径区分。
  var EXCLUDE = /(\/helper\/|mmdata|merlin|beacon|report_|cgi-bin.*\bhelper\b)/i;

  function shouldCapture(method, url) {
    if (!ENABLED) return false;
    if (EXCLUDE.test(url || '')) return false;
    if (/^(POST|PUT|PATCH|DELETE)$/i.test(method || '')) return true; // 写操作全收
    return INTEREST.test(url || ''); // GET 仅当 URL 明确相关
  }

  function post(entry) {
    try {
      // 发到顶层窗口，确保来自 iframe 的请求也能被顶层侦察面板汇总
      (window.top || window).postMessage({ __WXCH_RECON_NET__: true, entry: entry }, '*');
    } catch (e) {
      /* 忽略 */
    }
  }

  function truncate(v, n) {
    n = n || 4000;
    if (v == null) return v;
    // 二进制/流式请求体（Blob / FormData / ArrayBuffer / ReadableStream）：不塞字节，只记类型与大小。
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      var name = (v.constructor && v.constructor.name) || 'Object';
      var size = v.size != null ? v.size : (v.byteLength != null ? v.byteLength : undefined);
      return '[binary:' + name + (size != null ? ' bytes=' + size : '') + ']';
    }
    var s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s == null) return s;
    return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
  }

  function redactHeaders(h) {
    if (!h) return undefined;
    var out = {};
    var keep = ['content-type', 'accept', 'x-request-id', 'referer', 'origin'];
    keep.forEach(function (k) {
      var v = h[k] || h[k.toLowerCase()];
      if (v) out[k] = String(v).slice(0, 200);
    });
    return out;
  }

  // ---- fetch 拦截 ----
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = input && input.url ? input.url : String(input);
      var method = (init && init.method) || (input && input.method) || 'GET';
      var body = init && init.body;
      var t0 = Date.now();
      return origFetch(input, init).then(
        function (resp) {
          if (shouldCapture(method, url)) {
            var clone = resp.clone();
            clone
              .text()
              .then(function (text) {
                post({
                  kind: 'fetch',
                  url: url,
                  method: method,
                  requestHeaders: redactHeaders(init && init.headers),
                  requestBody: truncate(body),
                  status: resp.status,
                  responseText: truncate(text),
                  tookMs: Date.now() - t0,
                  at: new Date().toISOString(),
                });
              })
              .catch(function () {});
          }
          return resp;
        },
        function (err) {
          if (shouldCapture(method, url)) {
            post({
              kind: 'fetch',
              url: url,
              method: method,
              requestBody: truncate(body),
              error: String(err && err.message ? err.message : err),
              tookMs: Date.now() - t0,
              at: new Date().toISOString(),
            });
          }
          throw err;
        },
      );
    };
  }

  // ---- XHR 拦截 ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wxch_method = method;
    this.__wxch_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    var url = this.__wxch_url;
    var method = this.__wxch_method;
    this.addEventListener('loadend', function () {
      if (shouldCapture(method, url || '')) {
        var respText = '';
        try {
          respText = self.responseText;
        } catch (e) {}
        post({
          kind: 'xhr',
          url: url,
          method: method,
          requestBody: truncate(body),
          status: self.status,
          responseText: truncate(respText),
          at: new Date().toISOString(),
        });
      }
    });
    return origSend.apply(this, arguments);
  };

  // ---- 命令通道 ----
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.__WXCH_RECON_CMD__ === 'start') ENABLED = true;
    else if (e.data.__WXCH_RECON_CMD__ === 'stop') ENABLED = false;
    else if (e.data.__WXCH_RECON_CMD__ === 'status') {
      window.postMessage({ __WXCH_RECON_STATUS__: true, enabled: ENABLED }, '*');
    }
  });

  // ---- 注入就绪自检：通知隔离世界面板主世界抓包已就绪（且默认已开启）----
  try {
    (window.top || window).postMessage({ __WXCH_RECON_READY__: true, enabled: ENABLED }, '*');
  } catch (e) {
    /* 忽略 */
  }
})();
