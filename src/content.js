/**
 * 内容脚本：在视频号助手页面注入悬浮面板。
 *
 * 评论正文由外部 AI 生成，本扩展只负责三件事：
 *   1) 拉取已发布视频，筛出评论数为 0 的（含完整描述）；
 *   2) 导出列表 JSON，供你粘贴给外部 AI 生成评论；
 *   3) 把你粘贴回来的评论，通过 create_comment 提交。
 *
 * 请求由内容脚本直接发起：与页面同源，自动携带当前登录 Cookie。
 * 不读取、不导出、不上传任何凭证。
 */
(function () {
  'use strict';

  if (globalThis.__WXCH_PANEL__) return;
  globalThis.__WXCH_PANEL__ = true;

  var L = globalThis.WXCH;
  if (!L) return;

  var DRAFT_KEY = 'wxch:drafts';

  var videos = [];
  var dryRun = true;
  var drafts = loadDrafts();

  function loadDrafts() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveDraft(id, text) {
    drafts[id] = text;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
    } catch (e) {
      /* 忽略配额错误 */
    }
  }

  /** 同源请求：自动带上当前登录 Cookie。 */
  async function postJson(path, body) {
    var res = await fetch(L.buildEndpointUrl(path), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
      },
      body: JSON.stringify(body),
    });
    var text = await res.text();
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = undefined;
    }
    return { status: res.status, text: text, json: json };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function copyText(text) {
    var value = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).catch(function () {
        fallbackCopy(value);
      });
    } else {
      fallbackCopy(value);
    }
  }

  function fallbackCopy(value) {
    var ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* 忽略 */
    }
    document.body.removeChild(ta);
  }

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}',
    '.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:10px 14px;border:none;border-radius:20px;',
    'background:linear-gradient(135deg,#07c160,#0aa050);color:#fff;font-size:13px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.2)}',
    '.panel{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:400px;max-height:82vh;display:flex;flex-direction:column;',
    'background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;color:#1f2329;font-size:13px}',
    '.bar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0aa050;color:#fff}',
    '.bar strong{font-size:13px;font-weight:600}',
    '.bar .grow{flex:1}',
    '.bar button{background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}',
    '.body{padding:10px 12px;overflow:auto}',
    '.row{display:flex;gap:8px;margin-bottom:8px}',
    'button.act{flex:1;padding:8px;border:1px solid #dcdfe6;background:#fff;border-radius:8px;font-size:12px;cursor:pointer;color:#1f2329}',
    'button.act.primary{background:#0aa050;border-color:#0aa050;color:#fff}',
    'button.act:hover{filter:brightness(.97)}',
    '.dry{display:flex;align-items:center;gap:6px;margin:6px 0 8px;color:#646a73;font-size:12px}',
    '.status{font-size:12px;color:#646a73;margin-bottom:8px;white-space:pre-wrap;word-break:break-all}',
    '.item{border:1px solid #eceef1;border-radius:10px;padding:10px;margin-bottom:10px}',
    '.item .ttl{font-weight:600;margin-bottom:4px}',
    '.item .meta{font-size:11px;color:#8a9099;margin-bottom:6px;word-break:break-all}',
    '.item .desc{font-size:12px;color:#4a5058;line-height:1.5;max-height:60px;overflow:hidden;white-space:pre-wrap;cursor:pointer}',
    '.item .desc.open{max-height:none}',
    '.item .hint{font-size:11px;color:#a0a6ad;margin:2px 0 6px}',
    '.item textarea{width:100%;min-height:56px;border:1px solid #dcdfe6;border-radius:8px;padding:8px;font-size:12px;resize:vertical;color:#1f2329}',
    '.item .acts{display:flex;gap:6px;margin-top:6px}',
    '.item .acts button{padding:6px 8px;border:1px solid #dcdfe6;background:#fff;border-radius:6px;font-size:11px;cursor:pointer;color:#1f2329}',
    '.item .acts button.primary{background:#0aa050;border-color:#0aa050;color:#fff}',
    '.item .res{margin-top:6px;font-size:11px;white-space:pre-wrap;word-break:break-all}',
    '.res.ok{color:#0aa050}.res.err{color:#e54545}.res.warn{color:#e6a23c}.res.info{color:#646a73}',
    '.empty{color:#8a9099;text-align:center;padding:20px 0}',
    '.tabs{display:flex;gap:4px;padding:8px 12px 0}',
    '.tab{padding:6px 12px;border:none;background:#f2f3f5;border-radius:8px 8px 0 0;font-size:12px;cursor:pointer;color:#4a5058}',
    '.tab.on{background:#0aa050;color:#fff}',
    '.hint.p{font-size:11px;color:#e6a23c;line-height:1.5;margin-bottom:8px}',
    '.prow{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;font-size:12px;color:#4a5058}',
    '.prow input,.prow textarea{border:1px solid #dcdfe6;border-radius:8px;padding:8px;font-size:12px;color:#1f2329;width:100%}',
    '.prow textarea{min-height:54px;resize:vertical}',
  ].join('');

  var host = document.createElement('div');
  host.id = 'wxch-root';
  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  var launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.textContent = '视频号助手';
  launcher.onclick = function () {
    panel.style.display = 'flex';
    launcher.style.display = 'none';
  };
  root.appendChild(launcher);

  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.display = 'none';
  panel.innerHTML = [
    '<div class="bar"><strong>视频号助手</strong><span class="grow"></span>',
    '<button data-act="close">收起</button></div>',
    '<div class="tabs">',
    '<button class="tab on" data-tab="comment">评论助手</button>',
    '<button class="tab" data-tab="publish">发布助手</button>',
    '</div>',
    '<div class="body" data-view="comment">',
    '<div class="row">',
    '<button class="act primary" data-act="fetch">拉取 0 评论视频</button>',
    '<button class="act" data-act="export">复制列表 JSON</button>',
    '</div>',
    '<label class="dry"><input type="checkbox" data-act="dry" checked> 干跑（只预览请求体，不提交）</label>',
    '<div class="status" data-el="status">点击「拉取 0 评论视频」开始。评论正文由外部 AI 生成后粘贴到下方。</div>',
    '<div class="list" data-el="list"></div>',
    '</div>',
    '<div class="body" data-view="publish" style="display:none">',
    '<div class="hint p">⚠️ 仅对你本人账号、且仅对自有内容使用。发表前需二次确认；默认干跑不真正发表。</div>',
    '<label class="dry"><input type="checkbox" data-act="pdry" checked> 干跑（只注入视频+填表，不真正发表）</label>',
    '<div class="prow"><span>视频文件</span><input type="file" data-el="videofile" accept="video/mp4,video/*"></div>',
    '<div class="prow"><span>短标题（≤16 字）</span><input type="text" data-el="ptitle" maxlength="16" placeholder="填写短标题有机会获得更多流量"></div>',
    '<div class="prow"><span>描述</span><textarea data-el="pdesc" placeholder="视频描述正文"></textarea></div>',
    '<label class="dry"><input type="checkbox" data-act="poriginal"> 声明原创</label>',
    '<div class="row"><button class="act primary" data-act="pgo">注入视频并填表（干跑预览）</button></div>',
    '<div class="row"><button class="act" data-act="ppublish">确认发表</button></div>',
    '<div class="status res info" data-el="pstatus">在发布页打开发布助手，选视频、填标题描述，先「干跑预览」确认无误，再「确认发表」。</div>',
    '</div>',
  ].join('');
  root.appendChild(panel);

  var statusEl = panel.querySelector('[data-el=status]');
  var listEl = panel.querySelector('[data-el=list]');

  panel.querySelector('[data-act=close]').onclick = function () {
    panel.style.display = 'none';
    launcher.style.display = 'block';
  };
  panel.querySelector('[data-act=fetch]').onclick = fetchVideos;
  panel.querySelector('[data-act=export]').onclick = exportJson;
  panel.querySelector('[data-act=dry]').onchange = function (e) {
    dryRun = e.target.checked;
  };

  // ---- 发布助手 Tab ----
  panel.querySelectorAll('[data-tab]').forEach(function (tab) {
    tab.onclick = function () {
      panel.querySelectorAll('[data-tab]').forEach(function (t) {
        t.classList.remove('on');
      });
      tab.classList.add('on');
      var name = tab.getAttribute('data-tab');
      panel.querySelectorAll('[data-view]').forEach(function (v) {
        v.style.display = v.getAttribute('data-view') === name ? 'block' : 'none';
      });
    };
  });

  var publishStatusEl = panel.querySelector('[data-el=pstatus]');
  var vfileEl = panel.querySelector('[data-el=videofile]');
  var ptitleEl = panel.querySelector('[data-el=ptitle]');
  var pdescEl = panel.querySelector('[data-el=pdesc]');
  var pdryEl = panel.querySelector('[data-act=pdry]');
  var poriginalEl = panel.querySelector('[data-act=poriginal]');

  function setPStatus(level, text) {
    publishStatusEl.className = 'status res ' + (level || 'info');
    publishStatusEl.textContent = text;
  }

  function readPublishSpec() {
    return {
      title: (ptitleEl.value || '').trim(),
      description: pdescEl.value || '',
      original: !!poriginalEl.checked,
    };
  }

  var P = globalThis.WXCH_PUBLISH;
  if (!P) {
    setPStatus('warn', '发布模块未加载（WXCH_PUBLISH 缺失）。请确认 manifest 已包含 publish/selectors.js 与 publish/flow.js。');
  } else {
    panel.querySelector('[data-act=pgo]').onclick = async function () {
      var spec = readPublishSpec();
      var file = vfileEl.files && vfileEl.files[0] ? vfileEl.files[0] : null;
      await P.publishFlow(spec, { file: file, real: false, onStatus: setPStatus });
    };
    panel.querySelector('[data-act=ppublish]').onclick = async function () {
      if (pdryEl.checked) {
        setPStatus('warn', '当前为干跑模式，「确认发表」不会真正发表。先取消「干跑」勾选，再点确认发表。');
        return;
      }
      var spec = readPublishSpec();
      var file = vfileEl.files && vfileEl.files[0] ? vfileEl.files[0] : null;
      if (!window.confirm('确认要把该视频发表到你的视频号？此操作不可撤销。\n标题：' + spec.title)) return;
      await P.publishFlow(spec, { file: file, real: true, onStatus: setPStatus });
    };
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setRes(el, kind, text) {
    el.className = 'res ' + kind;
    el.textContent = text;
  }

  async function fetchVideos() {
    setStatus('拉取中…');
    try {
      var r = await postJson(L.POST_LIST_PATH, L.buildPostListBody({ page: 1, pageSize: 50 }));
      if (!r.json) {
        setStatus('失败：接口返回不是 JSON（HTTP ' + r.status + '，可能未登录或页面已改版）。');
        return;
      }
      var code = L.readErrCode(r.json);
      if (code !== undefined && code !== 0) {
        if (L.isLoginError(r.json)) {
          setStatus('失败：登录态已失效（errCode=' + code + '）。请在浏览器重新登录视频号助手，然后刷新本页。');
        } else {
          setStatus('失败：errCode=' + code + ' ' + L.readErrMsg(r.json));
        }
        return;
      }
      var all = L.parsePostList(r.json);
      videos = all.filter(function (v) {
        return v.commentCount === 0;
      });
      setStatus('拉取 ' + all.length + ' 条，其中评论数为 0 的 ' + videos.length + ' 条。');
      renderList();
    } catch (e) {
      setStatus('请求异常：' + (e && e.message ? e.message : e));
    }
  }

  function exportJson() {
    if (videos.length === 0) {
      setStatus('列表为空，先拉取一次。');
      return;
    }
    var payload = videos.map(function (v) {
      return { id: v.id, title: v.title, description: v.description, commentCount: v.commentCount };
    });
    copyText(JSON.stringify(payload, null, 2));
    setStatus('已复制 ' + payload.length + ' 条视频的 JSON（含完整描述），可粘贴给外部 AI 生成评论。');
  }

  function renderList() {
    listEl.innerHTML = '';
    if (videos.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '没有评论数为 0 的视频。';
      listEl.appendChild(empty);
      return;
    }
    videos.forEach(function (v, i) {
      listEl.appendChild(renderItem(v, i + 1));
    });
  }

  function renderItem(v, index) {
    var item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = [
      '<div class="ttl">' + index + '. ' + esc(v.title || '(无标题)') + '</div>',
      '<div class="meta">评论数 0 · ' + esc(v.id) + '</div>',
      '<div class="hint">点描述可展开/收起</div>',
      '<div class="desc">' + esc(v.description || '(无描述)') + '</div>',
      '<textarea placeholder="粘贴外部 AI 生成的评论…"></textarea>',
      '<div class="acts">',
      '<button data-a="copyDesc">复制描述</button>',
      '<button data-a="copyId">复制 ID</button>',
      '<button class="primary" data-a="submit">提交评论</button>',
      '</div>',
      '<div class="res"></div>',
    ].join('');

    var desc = item.querySelector('.desc');
    desc.onclick = function () {
      desc.classList.toggle('open');
    };

    var ta = item.querySelector('textarea');
    ta.value = drafts[v.id] || '';
    ta.addEventListener('input', function () {
      saveDraft(v.id, ta.value);
    });

    var resEl = item.querySelector('.res');
    item.querySelector('[data-a=copyDesc]').onclick = function () {
      copyText(v.description || '');
      setRes(resEl, 'info', '已复制描述。');
    };
    item.querySelector('[data-a=copyId]').onclick = function () {
      copyText(v.id);
      setRes(resEl, 'info', '已复制 ID。');
    };
    item.querySelector('[data-a=submit]').onclick = function () {
      submit(v, ta, resEl);
    };

    return item;
  }

  async function submit(v, ta, resEl) {
    var content = (ta.value || '').trim();
    if (!content) {
      setRes(resEl, 'warn', '请先填写评论正文。');
      return;
    }
    var body = L.buildCommentBody(v.id, content, '');

    if (dryRun) {
      setRes(resEl, 'info', '干跑预览（未提交）：\n' + JSON.stringify(body, null, 2));
      return;
    }

    setRes(resEl, 'info', '提交中…');
    try {
      var r = await postJson(L.COMMENT_CREATE_PATH, body);
      var ok = r.status < 400 && L.isCommentOk(r.json);
      if (ok) {
        var cid = L.readCommentId(r.json);
        setRes(resEl, 'ok', '✓ 已提交' + (cid ? '（评论 ID ' + cid + '）' : ''));
      } else if (L.isLoginError(r.json)) {
        setRes(resEl, 'err', '✗ 失败：登录态已失效（errCode=' + L.readErrCode(r.json) + '）。请重新登录视频号助手后刷新本页。');
      } else {
        setRes(resEl, 'err', '✗ 失败：' + (L.readErrMsg(r.json) || 'HTTP ' + r.status + ' ' + r.text.slice(0, 120)));
      }
    } catch (e) {
      setRes(resEl, 'err', '✗ 请求异常：' + (e && e.message ? e.message : e));
    }
  }

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
