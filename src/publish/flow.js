/**
 * 发布编排（DOM 相关，运行在内容脚本上下文）。
 *
 * 主路径 = 页面驱动：把本地视频 File 注入隐藏 file input，让页面自带的上传/转码流程跑完，
 * 本扩展只负责「填表 + 点发表 + 处理原创声明弹层 + 读结果」。兜底直连 post_create 的方案见 lib.buildPublishBody。
 *
 * 合规闸：real=false（干跑）只注入+填表不发表；real=true 才走完整发表，且调用方必须先经 window.confirm 二次确认。
 */
(function () {
  'use strict';

  var L = globalThis.WXCH;
  var S = globalThis.WXCH_SEL;

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** 轮询直到 predicate() 返回真值，或超时 reject。 */
  function waitFor(predicate, timeoutMs, intervalMs) {
    timeoutMs = timeoutMs || 180000;
    intervalMs = intervalMs || 500;
    var start = Date.now();
    return new Promise(function (resolve, reject) {
      function tick() {
        var v;
        try {
          v = predicate();
        } catch (e) {
          v = false;
        }
        if (v) return resolve(v);
        if (Date.now() - start > timeoutMs) return reject(new Error('等待超时（' + timeoutMs / 1000 + 's）'));
        setTimeout(tick, intervalMs);
      }
      tick();
    });
  }

  /** 给受控 input/textarea 设值并触发 input 事件（React/Vue 可感知）。 */
  function setNativeValue(el, value) {
    var proto =
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  function setContentEditable(el, text) {
    el.focus();
    el.innerText = '';
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.innerText = text;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  /** 把本地 File 注入隐藏 file input，触发页面的上传逻辑。 */
  function injectFile(fileInput, file) {
    var dt = new window.DataTransfer();
    dt.items.add(file);
    try {
      Object.defineProperty(fileInput, 'files', {
        value: dt.files,
        configurable: true,
      });
    } catch (e) {
      try {
        fileInput.files = dt.files; // 部分 Chromium 版本直接赋值可用
      } catch (e2) {
        throw new Error('无法为 file input 设置 files：' + (e2 && e2.message ? e2.message : e2));
      }
    }
    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  }

  /** 按 label 设置 checkbox/switch；state 为目标勾选态，仅在当前态不符时点击一次。 */
  function setCheckboxByLabel(text, state) {
    var box = S.findCheckboxByLabel(text);
    if (!box) return false;
    var wrap = box.closest('.ant-checkbox') || box.closest('label') || box;
    var current = !!box.checked;
    if (current !== !!state) {
      wrap.click();
    }
    return true;
  }

  /** 填表：短标题 / 描述 / 原创声明。返回 {ok, missing[]}。 */
  function fillForm(spec, onStatus) {
    var missing = [];
    var titleEl = S.getShortTitleInput();
    if (titleEl) setNativeValue(titleEl, String(spec.title || ''));
    else missing.push('短标题输入框');

    var descEl = S.getDescEditor();
    if (descEl) setContentEditable(descEl, String(spec.description || ''));
    else missing.push('描述编辑器');

    if (spec.original != null) {
      var ok = setCheckboxByLabel('声明后，作品将展示原创标记', !!spec.original);
      if (!ok) missing.push('原创声明勾选框');
    }
    return { ok: missing.length === 0, missing: missing };
  }

  /** 点击发表，并处理可能出现的「原创声明」确认弹层。返回 Promise。 */
  function clickPublishAndConfirm(spec) {
    var btn = S.getPublishButton();
    if (!btn) return Promise.reject(new Error('未找到发表按钮'));
    btn.click();
    // 等待确认弹层（原创声明），最多 8s；出现则点击对应确认按钮
    return waitFor(
      function () {
        return S.getConfirmButton(!!spec.original);
      },
      8000,
      300,
    )
      .then(function (confirmBtn) {
        confirmBtn.click();
        return 'confirmed';
      })
      .catch(function () {
        return 'no-modal';
      });
  }

  /** 干跑后回读页面真实值，确认填表确实生效（供干跑预览展示）。 */
  function readBack() {
    var t = S.getShortTitleInput();
    var d = S.getDescEditor();
    var o = S.getOriginalCheckbox();
    return {
      title: t ? t.value || '' : '(未定位)',
      desc: d ? (d.innerText || '').slice(0, 40) : '(未定位)',
      original: o ? !!o.checked : false,
    };
  }

  /** 注入封面上传 input（视频上传完成后才有封面控件，故在上传后调用）。 */
  async function injectCover(coverFile, onStatus) {
    var ci = S.getCoverInput();
    if (!ci) {
      onStatus('warn', '未找到封面上传 input（可能封面控件在视频上传后才出现，或选择器待校准）。已跳过封面，可稍后手动选。');
      return false;
    }
    try {
      injectFile(ci, coverFile);
      onStatus('info', '已注入封面文件「' + coverFile.name + '」，等待封面上传…');
      return true;
    } catch (e) {
      onStatus('warn', '封面注入失败：' + (e && e.message ? e.message : e) + '（已跳过封面）');
      return false;
    }
  }

  /** 选合集（最佳实现：点开合集控件→在搜索框输入名称→点第一个匹配项）。 */
  async function setCollection(name, onStatus) {
    if (!name) return;
    var trig = S.getCollectionTrigger();
    if (!trig) {
      onStatus('warn', '未找到合集触发控件（选择器待校准），合集请手动选。');
      return;
    }
    trig.click();
    await sleep(500);
    var si = S.getCollectionSearchInput();
    if (!si) {
      onStatus('warn', '合集已展开但未找到搜索框，合集请手动选。');
      return;
    }
    setNativeValue(si, name);
    await sleep(700);
    var opts = S.deepQueryAll('.ant-select-item-option, .weui-desktop-form__option, li, [role=option]');
    var hit = null;
    for (var i = 0; i < opts.length; i++) {
      if (textOf(opts[i]).indexOf(name) >= 0) {
        hit = opts[i];
        break;
      }
    }
    if (hit) {
      hit.click();
      onStatus('info', '已选择合集：「' + name + '」。');
    } else {
      onStatus('warn', '未在下拉中找到合集「' + name + '」，合集请手动选。');
    }
  }

  /** 选定时发表（最佳实现：点「定时」radio→尝试填入时间）。 */
  async function setSchedule(timeStr, onStatus) {
    var radio = S.getScheduleRadio(true);
    if (!radio) {
      onStatus('warn', '未找到「定时」radio（选择器待校准），定时请手动选。');
      return;
    }
    var wrap = radio.closest('.ant-radio-wrapper') || radio.closest('label') || radio;
    wrap.click();
    await sleep(500);
    onStatus('info', '已选「定时」，时间请在弹出的选择器里选' + (timeStr ? '（尝试自动填入）' : '') + '。');
    if (!timeStr) return;
    var inputs = S.deepQueryAll('input[type=datetime-local], input[type=date], input[type=time]');
    var ti = inputs.length ? inputs[0] : null;
    if (!ti) {
      var pop = S.deepQueryAll('.ant-picker-input input, .weui-desktop-form__datepicker input');
      ti = pop.length ? pop[0] : null;
    }
    if (ti) {
      try {
        setNativeValue(ti, timeStr);
        onStatus('info', '已尝试填入定时时间：' + timeStr + '（若页面是自定义选择器，可能仍需手动确认）。');
      } catch (e) {
        onStatus('warn', '定时时间填入失败，请手动选。');
      }
    } else {
      onStatus('warn', '未找到时间输入控件，请手动在时间选择器里选。');
    }
  }

  /** 读取发表结果：URL 跳转到 post/list 视为成功；否则看页面是否有成功/失败提示文案。 */
  function detectResult() {
    if (/post\/list/.test(location.href)) return { ok: true, how: 'navigated-to-list' };
    var nodes = S.deepQueryAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
      if (t && /发表成功|已发表|发布成功|发布成功/.test(t) && t.length < 60) {
        return { ok: true, how: 'toast:' + t };
      }
      if (/你还不能发表|无权限发表|发表失败|不能发表/.test(t) && t.length < 80) {
        return { ok: false, how: 'error:' + t };
      }
    }
    return null;
  }

  /**
   * 主流程。
   * opts: { file: File|null, real: boolean, onStatus: fn(level,text) }
   * 返回 Promise<{ok, dryRun, how?, missing?}>。
   */
  async function publishFlow(spec, opts) {
    opts = opts || {};
    var onStatus = opts.onStatus || function () {};
    var real = !!opts.real;

    if (!/post\/create/.test(location.href) && !/micro\/content\/post\/create/.test(location.href)) {
      onStatus('warn', '当前不在发布页（post/create）。请打开发布页后再操作。');
      return { ok: false, how: 'wrong-page' };
    }

    var v = L.validatePublishSpec(spec);
    if (!v.ok) {
      onStatus('warn', '规格校验未通过：' + v.errors.join('；'));
      return { ok: false, how: 'invalid-spec', errors: v.errors };
    }

    // 1) 注入视频文件（若有）
    if (opts.file) {
      var fileInput = S.getFileInput();
      if (!fileInput) {
        onStatus('warn', '未找到视频上传 input（span.ant-upload input[type=file]）。');
        return { ok: false, how: 'no-file-input' };
      }
      try {
        injectFile(fileInput, opts.file);
        onStatus('info', '已注入视频文件「' + opts.file.name + '」，等待页面上传+转码…');
      } catch (e) {
        onStatus('warn', '注入失败：' + (e && e.message ? e.message : e));
        return { ok: false, how: 'inject-failed' };
      }
      // 2) 等待上传+转码完成（发表按钮解除 disabled）
      try {
        await waitFor(function () {
          var b = S.getPublishButton();
          return b && b.disabled === false;
        }, 180000, 1000);
        onStatus('info', '上传+转码完成，发表按钮已可用。');
      } catch (e) {
        onStatus('warn', '等待发表按钮启用超时：视频可能上传失败或页面结构有变。');
        return { ok: false, how: 'upload-timeout' };
      }
      // 2.5) 视频上传完成后，封面控件才出现 → 注入封面（可选）
      if (opts.coverFile) {
        await injectCover(opts.coverFile, onStatus);
      }
    } else {
      onStatus('info', '未提供视频文件，假定页面已有视频，直接填表。');
    }

    // 3) 填表（短标题 / 描述 / 原创）
    var filled = fillForm(spec, onStatus);
    if (!filled.ok) {
      onStatus('warn', '部分字段未填：' + filled.missing.join('、') + '（仍会继续）。');
    } else {
      onStatus('info', '已填充短标题与描述' + (spec.original ? '、已勾选原创声明' : '') + '。');
    }

    // 3.5) 合集 / 定时（可选，最佳实现）
    if (spec.collection) await setCollection(spec.collection, onStatus);
    if (spec.schedule) await setSchedule(spec.scheduleTime, onStatus);

    // 4) 干跑：到此为止，不点发表，但回读页面真实值 + 展示兜底 post_create 请求体
    if (!real) {
      var rb = readBack();
      var preview = L.buildPublishBody(spec, {});
      onStatus(
        'ok',
        '【干跑】已注入视频+填表，未真正发表。\n' +
          '页面回读 → 短标题：「' + rb.title + '」 | 描述：「' + rb.desc + (rb.desc.length >= 40 ? '…' : '') +
          '」 | 原创：' + (rb.original ? '是' : '否') + '\n' +
          'post_create 将发送（兜底直连方案）：\n' +
          JSON.stringify(preview, null, 2).slice(0, 900),
      );
      return { ok: true, dryRun: true, missing: filled.missing };
    }

    // 5) 真正发表（调用方应已 window.confirm 二次确认）
    try {
      var how = await clickPublishAndConfirm(spec);
      onStatus('info', how === 'confirmed' ? '已点击发表并确认弹层，等待结果…' : '已点击发表（无确认弹层），等待结果…');
    } catch (e) {
      onStatus('warn', '点击发表失败：' + (e && e.message ? e.message : e));
      return { ok: false, how: 'click-failed' };
    }

    // 6) 读结果
    try {
      var res = await waitFor(detectResult, 20000, 500);
      if (res.ok) {
        onStatus('ok', '✓ 发表成功（' + res.how + '）。');
        return { ok: true, how: res.how };
      }
      onStatus('warn', '发表被拒绝：' + res.how);
      return { ok: false, how: res.how };
    } catch (e) {
      onStatus('warn', '未能在 20s 内确认发表结果。请手动核对页面是否已发布（可能成功但无明确提示）。');
      return { ok: false, how: 'result-timeout' };
    }
  }

  globalThis.WXCH_PUBLISH = {
    publishFlow: publishFlow,
    fillForm: fillForm,
    injectFile: injectFile,
    setNativeValue: setNativeValue,
    setContentEditable: setContentEditable,
    setCheckboxByLabel: setCheckboxByLabel,
  };
})();
