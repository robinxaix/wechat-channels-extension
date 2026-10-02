/**
 * 发布页选择器定位（DOM 相关，运行在内容脚本上下文）。
 *
 * 关键约束（来自 recon-report (2)/(3)）：发布页的「短标题」「原创声明」「定时」等控件
 * 选择器并不唯一（同页多个同名 input / 多个 ant-checkbox-input），必须按「可见文案 / placeholder」
 * 定位，不能只靠 tag+class。表单大概率是普通 DOM，但本模块对 open Shadow DOM 也做了穿透兜底。
 */
(function () {
  'use strict';

  /** 跨 Shadow DOM 查询，返回所有匹配元素。 */
  function deepQueryAll(selector, node) {
    node = node || document;
    var results = [];
    if (!node.querySelectorAll) return results;
    var direct = node.querySelectorAll(selector);
    for (var i = 0; i < direct.length; i++) results.push(direct[i]);
    var all = node.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) {
        var nested = deepQueryAll(selector, all[j].shadowRoot);
        for (var k = 0; k < nested.length; k++) results.push(nested[k]);
      }
    }
    return results;
  }

  function q(selector) {
    var r = deepQueryAll(selector);
    return r.length ? r[0] : null;
  }

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 在候选元素里，按可见文案（子串）筛选；优先完全包含，其次前缀。 */
  function byText(elements, text) {
    text = String(text || '').trim();
    if (!text) return [];
    var hits = [];
    for (var i = 0; i < elements.length; i++) {
      var t = textOf(elements[i]);
      if (t && t.indexOf(text) >= 0) hits.push(elements[i]);
    }
    return hits;
  }

  /** 取一个表单控件的关联文案：父级 label / 相邻文本 / 父容器文本。 */
  function labelOf(el) {
    if (!el) return '';
    var l = el.closest ? el.closest('label') : null;
    if (l) return textOf(l);
    var parent = el.parentElement;
    if (parent) {
      // 去掉自身文本后的父容器文本，常是 radio/checkbox 的标题
      var selfText = textOf(el);
      var pText = textOf(parent);
      if (pText && pText !== selfText) return pText.replace(selfText, '').trim();
    }
    return '';
  }

  function findInputByPlaceholder(substr) {
    var inputs = deepQueryAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var ph = inputs[i].getAttribute('placeholder') || '';
      if (ph.indexOf(substr) >= 0) return inputs[i];
    }
    return null;
  }

  function findRadioByLabel(text) {
    var radios = deepQueryAll('input[type=radio]');
    var hits = byText(radios.map(labelOf), text);
    if (hits.length) return radios.filter(function (r) { return byText([labelOf(r)], text).length; })[0];
    // 兜底：直接按 labelOf 匹配
    for (var i = 0; i < radios.length; i++) {
      if (labelOf(radios[i]).indexOf(text) >= 0) return radios[i];
    }
    return null;
  }

  function findCheckboxByLabel(text) {
    var boxes = deepQueryAll('input[type=checkbox]');
    for (var i = 0; i < boxes.length; i++) {
      if (labelOf(boxes[i]).indexOf(text) >= 0) return boxes[i];
    }
    return null;
  }

  /** 找可点击按钮（button / div.btn / a），按文案；excludeLong 避免命中大容器。 */
  function findButtonByText(text, excludeLong) {
    var cands = deepQueryAll('button, a, [role=button], .weui-desktop-btn_wrp, .btn-wrapper');
    var hits = byText(cands, text);
    if (!hits.length) return null;
    if (excludeLong) {
      for (var i = 0; i < hits.length; i++) {
        if (textOf(hits[i]).length <= 12) return hits[i];
      }
    }
    return hits[0];
  }

  function getFileInput() {
    // 视频上传在 span.ant-upload 内的 input[type=file]；封面为另一个，v1 只处理视频。
    var inUpload = deepQueryAll('span.ant-upload input[type=file]');
    if (inUpload.length) return inUpload[0];
    var any = deepQueryAll('input[type=file]');
    return any.length ? any[0] : null;
  }

  function getShortTitleInput() {
    return findInputByPlaceholder('填写短标题');
  }

  function getDescEditor() {
    return q('div.input-editor');
  }

  function getScheduleRadio(on) {
    // on=true 取「定时」，false 取「不定时」
    return findRadioByLabel(on ? '定时' : '不定时');
  }

  function getOriginalCheckbox() {
    return findCheckboxByLabel('声明后，作品将展示原创标记');
  }

  function getPublishButton() {
    var btns = deepQueryAll('button.weui-desktop-btn_primary');
    var hits = byText(btns, '发表');
    if (hits.length) return hits[0];
    return findButtonByText('发表', true);
  }

  /**
   * 发表确认弹层里的按钮：原创开启 → 「直接发表声明原创」；否则优先「直接发表」，再兜底「确定」。
   * 返回需要点击的按钮元素（未找到返回 null）。
   */
  function getConfirmButton(originalFlag) {
    if (originalFlag) {
      var b = findButtonByText('直接发表声明原创', true);
      if (b) return b;
    }
    var direct = findButtonByText('直接发表', true);
    if (direct) return direct;
    return findButtonByText('确定', true);
  }

  globalThis.WXCH_SEL = {
    deepQueryAll: deepQueryAll,
    q: q,
    byText: byText,
    labelOf: labelOf,
    findInputByPlaceholder: findInputByPlaceholder,
    findRadioByLabel: findRadioByLabel,
    findCheckboxByLabel: findCheckboxByLabel,
    findButtonByText: findButtonByText,
    getFileInput: getFileInput,
    getShortTitleInput: getShortTitleInput,
    getDescEditor: getDescEditor,
    getScheduleRadio: getScheduleRadio,
    getOriginalCheckbox: getOriginalCheckbox,
    getPublishButton: getPublishButton,
    getConfirmButton: getConfirmButton,
  };
})();
