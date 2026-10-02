/**
 * 侦察模式 · 主世界（MAIN world）网络抓包。
 *
 * 为什么在 MAIN world：发布页自己的上传/发表请求由页面 JS 发起，
 * 扩展默认内容脚本跑在隔离世界，patch 不到页面的 window.fetch / XMLHttpRequest。
 * 这里注入到主世界完成拦截，再 postMessage 回隔离世界的 recon.js 汇总。
 *
 * 仅当收到 `{__WXCH_RECON_CMD__:'start'}` 才开始记录；
 * 匹配 url 含 upload/publish/post/create/draft/cos/myqcloud/finder/media/video/cover/image 的请求。
 */
(function () {
  'use strict';

  if (window.__WXCH_RECON_MAIN__) return;
  window.__WXCH_RECON_MAIN__ = true;

  var ENABLED = false;
  var INTEREST =
    /upload|publish|post[/_-]|create|draft|cos|myqcloud|finder|object|media|video|cover|image|material/i;

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
          if (ENABLED && INTEREST.test(url)) {
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
          if (ENABLED && INTEREST.test(url)) {
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
      if (ENABLED && INTEREST.test(url || '')) {
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
})();
