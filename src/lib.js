/**
 * 纯逻辑层：接口地址、请求体构造、响应解析。
 *
 * 不依赖 DOM，既供 content.js 在页面里调用，也能在 Node 里直接做单元测试。
 * 所有函数都挂在 globalThis.WXCH 上（内容脚本是普通脚本，没有模块导出）。
 */
(function () {
  'use strict';

  var API_PREFIX = '/micro/interaction/cgi-bin/mmfinderassistant-bin';
  var POST_LIST_PATH = API_PREFIX + '/post/post_list';
  var COMMENT_CREATE_PATH = API_PREFIX + '/comment/create_comment';
  var COMMENT_PAGE_URL = 'https://channels.weixin.qq.com/micro/interaction/comment';
  var ORIGIN = 'https://channels.weixin.qq.com';

  var TITLE_PATHS = ['desc.shortTitle.0.shortTitle', 'desc.title', 'title', 'objectDesc.title'];
  var DESCRIPTION_PATHS = ['desc.description', 'objectDesc.description', 'description'];
  var ID_PATHS = ['objectId', 'object_id', 'exportId', 'finderObjectId', 'postId', 'post_id', 'id'];
  var COMMENT_PATHS = [
    'commentCount',
    'comment_count',
    'commentNum',
    'comment_num',
    'commentCountV2',
    'objectCommentCount',
    'desc.commentCount',
  ];

  function getByPath(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, obj);
  }

  function pickField(obj, paths) {
    for (var i = 0; i < paths.length; i++) {
      var v = getByPath(obj, paths[i]);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /** 按字段名正则递归查找，作为字段名不确定时的兜底。 */
  function deepFind(node, re, kind, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 6) return undefined;
    for (var k in node) {
      if (!re.test(k)) continue;
      var v = node[k];
      if (kind === 'number' && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) return v;
      if (kind === 'string' && typeof v === 'string' && v.trim()) return v;
      if (kind === 'any' && (typeof v === 'number' || typeof v === 'string')) return v;
    }
    for (var k2 in node) {
      var r = deepFind(node[k2], re, kind, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  /** 从任意 JSON 结构中挑出最像「视频数组」的数组。 */
  function pickFirstArray(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (Array.isArray(node)) {
      var isObjArray =
        node.length > 0 &&
        node.every(function (x) {
          return x && typeof x === 'object' && !Array.isArray(x);
        });
      return isObjArray ? node : null;
    }
    var keys = ['list', 'objectList', 'postList', 'object_list', 'items', 'feeds'];
    for (var i = 0; i < keys.length; i++) {
      var v = node[keys[i]];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    }
    var best = null;
    for (var k in node) {
      var r = pickFirstArray(node[k], depth + 1);
      if (r && (!best || r.length > best.length)) best = r;
    }
    return best;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 把 post_list 响应解析为统一的视频条目。 */
  function parsePostList(json) {
    var arr = pickFirstArray(json);
    if (!arr) return [];
    var items = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      var id = String(pickField(it, ID_PATHS) || deepFind(it, /object_?id|post_?id|feed_?id/i) || '');
      if (!id) continue;

      var description = normalizeText(pickField(it, DESCRIPTION_PATHS) || deepFind(it, /description/i, 'string') || '');
      var shortTitle = normalizeText(pickField(it, TITLE_PATHS) || '');
      var title = (shortTitle || description.split('\n')[0] || '').slice(0, 60);

      var cc = pickField(it, COMMENT_PATHS) || deepFind(it, /comment.*(count|num)|(count|num).*comment/i, 'number');
      var n = Number(cc);
      items.push({
        id: id,
        title: title,
        description: description.slice(0, 1000),
        commentCount: isFinite(n) ? n : null,
      });
    }
    return items;
  }

  /** 生成形如 6abf7ac1-4ef9dbda 的 _rid。 */
  function newRid() {
    var b = new Uint8Array(8);
    crypto.getRandomValues(b);
    var hex = '';
    for (var i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
    return hex.slice(0, 8) + '-' + hex.slice(8, 16);
  }

  function uuid() {
    return crypto.randomUUID();
  }

  /** 规范化接口地址：刷新 _rid，并补齐缺失的 _aid / _pageUrl。 */
  function buildEndpointUrl(path) {
    var url = new URL(/^https?:/i.test(path) ? path : ORIGIN + path);
    url.searchParams.set('_rid', newRid());
    if (!url.searchParams.get('_aid')) url.searchParams.set('_aid', uuid());
    if (!url.searchParams.get('_pageUrl')) url.searchParams.set('_pageUrl', COMMENT_PAGE_URL);
    return url.pathname + url.search;
  }

  function buildPostListBody(opts) {
    opts = opts || {};
    var body = {
      currentPage: opts.page || 1,
      pageSize: Math.max(1, Math.min(50, opts.pageSize || 20)),
      reqScene: 7,
      scene: 7,
      userpageType: 11,
      timestamp: String(Date.now()),
    };
    if (opts.finderId) body._log_finder_id = opts.finderId;
    return body;
  }

  /** 构造 create_comment 请求体；字段结构与网页端真实请求一致。 */
  function buildCommentBody(exportId, content, finderId) {
    return {
      replyCommentId: '',
      content: content,
      clientId: uuid(),
      rootCommentId: '',
      comment: {},
      exportId: exportId,
      timestamp: String(Date.now()),
      _log_finder_uin: '',
      _log_finder_id: finderId || '',
      rawKeyBuff: '',
      pluginSessionId: null,
      scene: 7,
      reqScene: 7,
    };
  }

  function readErrCode(json) {
    if (!json || typeof json !== 'object') return undefined;
    var raw = json.errCode != null ? json.errCode : json.ret != null ? json.ret : json.code;
    if (raw === undefined || raw === null) return undefined;
    var n = Number(raw);
    return isFinite(n) ? n : undefined;
  }

  /** 登录态相关错误码：300330 无有效会话，300334 会话已失效。 */
  var LOGIN_ERROR_CODES = [300330, 300334];

  function isLoginError(json) {
    var code = readErrCode(json);
    return code !== undefined && LOGIN_ERROR_CODES.indexOf(code) >= 0;
  }

  function readBaseRespCode(json) {
    var base = pickField(json, ['data.baseResp.errcode', 'baseResp.errcode']);
    if (base === undefined || base === null) return undefined;
    var n = Number(base);
    return isFinite(n) ? n : undefined;
  }

  function readCommentId(json) {
    var id = pickField(json, ['data.commentId', 'data.comment.commentId', 'commentId']);
    if (id === undefined || id === null || id === '') return undefined;
    return String(id);
  }

  function readErrMsg(json) {
    if (!json || typeof json !== 'object') return '';
    var direct = json.errMsg != null ? json.errMsg : json.msg != null ? json.msg : json.errmsg;
    if (direct !== undefined && direct !== '') return String(direct);
    var base = pickField(json, ['data.baseResp.errmsg', 'baseResp.errmsg']);
    return base === undefined || base === null ? '' : String(base);
  }

  /** 成功判定：顶层与 baseResp 错误码都为 0（缺省视为通过）。 */
  function isCommentOk(json) {
    var code = readErrCode(json);
    var baseCode = readBaseRespCode(json);
    return (code === undefined || code === 0) && (baseCode === undefined || baseCode === 0);
  }

  globalThis.WXCH = {
    POST_LIST_PATH: POST_LIST_PATH,
    COMMENT_CREATE_PATH: COMMENT_CREATE_PATH,
    COMMENT_PAGE_URL: COMMENT_PAGE_URL,
    getByPath: getByPath,
    pickField: pickField,
    deepFind: deepFind,
    pickFirstArray: pickFirstArray,
    parsePostList: parsePostList,
    newRid: newRid,
    uuid: uuid,
    buildEndpointUrl: buildEndpointUrl,
    buildPostListBody: buildPostListBody,
    buildCommentBody: buildCommentBody,
    readErrCode: readErrCode,
    isLoginError: isLoginError,
    readBaseRespCode: readBaseRespCode,
    readCommentId: readCommentId,
    readErrMsg: readErrMsg,
    isCommentOk: isCommentOk,
  };
})();
