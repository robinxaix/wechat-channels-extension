/**
 * 逻辑层单元测试：用真实接口的请求/响应结构校验 lib.js。
 * 运行：node test/lib.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'src', 'lib.js'), 'utf8');

const sandbox = { crypto, URL, URLSearchParams, JSON, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const L = sandbox.WXCH;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// 取自真实 post_list 响应的片段
const postListResponse = {
  errCode: 0,
  errMsg: 'request successful',
  data: {
    objectList: [
      {
        objectId: 'export/UzFfBgAAxNugBGJsTzLbk8zT4DCa5nUzu9x6Fd9tgqHqTPqokQ',
        commentCount: 0,
        desc: {
          shortTitle: [{ shortTitle: '分红到手 你怎么看这笔钱？' }],
          description: '那条「分红到账」的短信，看着像白捡了一笔钱。\n这笔钱到底走了多远，多数人一段都没看过：',
        },
      },
      {
        objectId: 'export/UzFfBgAAxNWgbDIdLRfbk8zT4DCaDtO41K0Ef0r50N-Dv4jwfw',
        commentCount: 3,
        desc: { shortTitle: [{ shortTitle: '有评论的视频' }], description: '正文' },
      },
    ],
  },
};

// 用户提供的真实评论响应
const commentResponse = {
  errCode: 0,
  errMsg: 'request successful',
  data: {
    commentId: '15023451388207500025',
    clientId: '8f00b3a7-5f23-4267-8514-5afd9a172c98',
    comment: { commentId: '15023451388207500025', commentContent: '分清是beta还是alpha' },
    baseResp: { errcode: 0, errmsg: '' },
  },
};

console.log('lib.js 单元测试');

test('parsePostList 提取 id / 短标题 / 完整描述 / 评论数', () => {
  const list = L.parsePostList(postListResponse);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'export/UzFfBgAAxNugBGJsTzLbk8zT4DCa5nUzu9x6Fd9tgqHqTPqokQ');
  assert.equal(list[0].title, '分红到手 你怎么看这笔钱？');
  assert.equal(list[0].commentCount, 0);
  assert.match(list[0].description, /分红到账/);
  assert.equal(list[1].commentCount, 3);
});

test('评论数为 0 的筛选只保留零评论视频', () => {
  const zero = L.parsePostList(postListResponse).filter((v) => v.commentCount === 0);
  assert.equal(zero.length, 1);
  assert.equal(zero[0].title, '分红到手 你怎么看这笔钱？');
});

test('buildCommentBody 字段与真实请求体一致', () => {
  const body = L.buildCommentBody('export/UzFfXXXX', '分清是beta还是alpha', '');
  assert.deepEqual(Object.keys(body).sort(), [
    '_log_finder_id',
    '_log_finder_uin',
    'clientId',
    'comment',
    'content',
    'exportId',
    'pluginSessionId',
    'rawKeyBuff',
    'replyCommentId',
    'reqScene',
    'rootCommentId',
    'scene',
    'timestamp',
  ]);
  assert.equal(body.exportId, 'export/UzFfXXXX');
  assert.equal(body.content, '分清是beta还是alpha');
  assert.equal(body.scene, 7);
  assert.equal(body.reqScene, 7);
  assert.equal(body.pluginSessionId, null);
  assert.match(body.clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(body.timestamp, /^\d{13}$/);
});

test('buildEndpointUrl 补齐 _rid / _aid / _pageUrl', () => {
  const url = L.buildEndpointUrl(L.COMMENT_CREATE_PATH);
  assert.match(url, /^\/micro\/interaction\/cgi-bin\/mmfinderassistant-bin\/comment\/create_comment\?/);
  const q = new URLSearchParams(url.split('?')[1]);
  assert.match(q.get('_rid'), /^[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.match(q.get('_aid'), /^[0-9a-f-]{36}$/);
  assert.equal(q.get('_pageUrl'), 'https://channels.weixin.qq.com/micro/interaction/comment');
});

test('buildPostListBody 带分页与场景字段', () => {
  const body = L.buildPostListBody({ page: 2, pageSize: 30 });
  assert.equal(body.currentPage, 2);
  assert.equal(body.pageSize, 30);
  assert.equal(body.userpageType, 11);
  assert.match(body.timestamp, /^\d{13}$/);
});

test('评论响应解析：错误码 / 评论 ID / 成功判定', () => {
  assert.equal(L.readErrCode(commentResponse), 0);
  assert.equal(L.readBaseRespCode(commentResponse), 0);
  assert.equal(L.readCommentId(commentResponse), '15023451388207500025');
  assert.equal(L.readErrMsg(commentResponse), 'request successful');
  assert.equal(L.isCommentOk(commentResponse), true);
});

test('失败响应判定为不成功', () => {
  assert.equal(L.isCommentOk({ errCode: 1001, errMsg: '登录态失效' }), false);
  assert.equal(L.isCommentOk({ errCode: 0, data: { baseResp: { errcode: 5 } } }), false);
});

test('识别登录态失效错误码（300330 / 300334）', () => {
  assert.equal(L.isLoginError({ errCode: 300334, errMsg: 'request failed' }), true);
  assert.equal(L.isLoginError({ errCode: 300330, errMsg: 'request failed' }), true);
  assert.equal(L.isLoginError({ errCode: 0, errMsg: 'request successful' }), false);
  assert.equal(L.isLoginError({ errCode: 1001, errMsg: '参数错误' }), false);
  assert.equal(L.isLoginError(undefined), false);
});

console.log('\n全部通过：' + passed + ' 项');
