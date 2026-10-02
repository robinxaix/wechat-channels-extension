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

  // 发布相关（来自 recon-report (3) 确证）：content 域，非 interaction 域。
  var PUBLISH_CREATE_PAGE_URL = 'https://channels.weixin.qq.com/micro/content/post/create';
  var POST_CLIP_VIDEO_PATH = '/micro/content/cgi-bin/mmfinderassistant-bin/post/post_clip_video';
  var POST_CLIP_VIDEO_RESULT_PATH = '/micro/content/cgi-bin/mmfinderassistant-bin/post/post_clip_video_result';
  var POST_CREATE_PATH = '/micro/content/cgi-bin/mmfinderassistant-bin/post/post_create';

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

  /** 规范化接口地址：刷新 _rid，并补齐缺失的 _aid / _pageUrl。opts.pageUrl 可覆盖默认页面。 */
  function buildEndpointUrl(path, opts) {
    opts = opts || {};
    var url = new URL(/^https?:/i.test(path) ? path : ORIGIN + path);
    url.searchParams.set('_rid', newRid());
    if (!url.searchParams.get('_aid')) url.searchParams.set('_aid', uuid());
    if (opts.pageUrl) url.searchParams.set('_pageUrl', opts.pageUrl);
    else if (!url.searchParams.get('_pageUrl')) url.searchParams.set('_pageUrl', COMMENT_PAGE_URL);
    return url.pathname + url.search;
  }

  /** 同源请求：自动带上当前登录 Cookie（浏览器环境）。 */
  async function postJson(path, body, opts) {
    opts = opts || {};
    var res = await fetch(buildEndpointUrl(path, opts), {
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

  /** 校验发布规格：短标题 ≤16 字、描述非空且 ≤1000 字、原创/合集/话题可选。 */
  function validatePublishSpec(spec) {
    var errors = [];
    spec = spec || {};
    var title = String(spec.title == null ? '' : spec.title).trim();
    if (!title) errors.push('短标题不能为空');
    else if ([...title].length > 16) errors.push('短标题超过 16 字（当前 ' + [...title].length + '）');
    var desc = String(spec.description == null ? '' : spec.description);
    if (!desc.trim()) errors.push('描述不能为空');
    else if (desc.length > 1000) errors.push('描述超过 1000 字（当前 ' + desc.length + '）');
    if (spec.original != null && typeof spec.original !== 'boolean') errors.push('original 必须是布尔');
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * 构造 post_create 请求体（兜底直连方案用；主路径是页面驱动：注入 File 让页面自己上传+转码，本扩展只填表+点发表）。
   * derived 来自页面上传/转码结果：{ videoClipTaskId, traceInfo, mediaUrl, location }。
   */
  function buildPublishBody(spec, derived) {
    derived = derived || {};
    var topics = (spec.topics || []).map(function (t) {
      return String(t);
    });
    var topicXml =
      '<finder><version>1</version><valuecount>' +
      topics.length +
      '</valuecount><style><at></at></style>' +
      topics
        .map(function (t, i) {
          return '<value' + i + '><![CDATA[' + t + ']]></value' + i + '>';
        })
        .join('') +
      '</finder>';
    var topic = { finderTopicInfo: topicXml };
    if (spec.collectionId) {
      topic.collectionId = spec.collectionId;
      topic.collectionName = spec.collectionName || '';
    }
    return {
      objectType: 0,
      longitude: 0,
      latitude: 0,
      feedLongitude: 0,
      feedLatitude: 0,
      originalFlag: spec.original ? 1 : 0,
      topics: [],
      isFullPost: 1,
      handleFlag: 2,
      videoClipTaskId: String(derived.videoClipTaskId || ''),
      traceInfo: derived.traceInfo || { traceKey: '', uploadCdnStart: 0, uploadCdnEnd: 0 },
      objectDesc: {
        mpTitle: String(spec.title || ''),
        description: String(spec.description || ''),
        extReading: {},
        mediaType: 4,
        location: derived.location || { latitude: 0, longitude: 0, city: '', poiClassifyId: '' },
        topic: topic,
        event: {},
        mentionedUser: [],
        media: derived.mediaUrl ? [{ url: derived.mediaUrl }] : [],
      },
    };
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
    PUBLISH_CREATE_PAGE_URL: PUBLISH_CREATE_PAGE_URL,
    POST_CLIP_VIDEO_PATH: POST_CLIP_VIDEO_PATH,
    POST_CLIP_VIDEO_RESULT_PATH: POST_CLIP_VIDEO_RESULT_PATH,
    POST_CREATE_PATH: POST_CREATE_PATH,
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
    postJson: postJson,
    validatePublishSpec: validatePublishSpec,
    buildPublishBody: buildPublishBody,
    readErrCode: readErrCode,
    isLoginError: isLoginError,
    readBaseRespCode: readBaseRespCode,
    readCommentId: readCommentId,
    readErrMsg: readErrMsg,
    isCommentOk: isCommentOk,
  };
})();
