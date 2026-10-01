// ==UserScript==
// @name         好医生 CME 学习助手
// @namespace    cmechina-study-assistant
// @version      0.3.1
// @description  直达章节考试、可选视频学习、穷举答题、课程队列与可配置评价；含暂停和诊断面板
// @match        https://*.cmechina.net/*
// @match        http://*.cmechina.net/*
// @match        https://cmechina.net/*
// @match        http://cmechina.net/*
// @run-at       document-end
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const PREFIX = 'cme-assistant:v1:';
  const DEFAULTS = {
    enabled: false,
    studyMode: 'direct',
    rate: 1,
    checkin: true,
    review: false,
    reviewChoice: '非常满意',
    reviewText: '',
    maxAttempts: 100,
    queue: [],
    selectors: {
      reviewEntry: '',
      reviewForm: '',
      reviewSubmit: '',
      reviewSuccess: '',
    },
  };

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function questionKey(value) {
    return normalizeText(value).replace(/^[（(]?\d+[）).、．]\s*/, '')
      .replace(/^[（(\[【]\s*(?:单选|多选|判断)题?\s*[）)\]】]\s*/, '');
  }

  function safeUrl(value, base) {
    try {
      const target = new URL(String(value).replace(/&amp;/g, '&'), base);
      const current = new URL(base);
      if (!['http:', 'https:'].includes(target.protocol) || target.origin !== current.origin) return null;
      return target.href;
    } catch {
      return null;
    }
  }

  function linkUrl(element, base) {
    const handler = element.getAttribute('onclick') || '';
    const match = handler.match(/kjJumpTo\(\s*['"]([^'"]+)['"]/);
    const href = element.getAttribute('href');
    if (match) return safeUrl(match[1], base);
    if (!href || href.startsWith('#')) return null;
    return safeUrl(href, base);
  }

  function nextMask(mask, count) {
    if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('仅支持 1–12 个选项');
    const maximum = 2 ** count - 1;
    let next = Number(mask || 0) + 1;
    while (next <= maximum) {
      if ((next & (next - 1)) !== 0) return next;
      next += 1;
    }
    return null;
  }

  function chapterStatus(row) {
    const text = normalizeText(row.textContent);
    if (row.querySelector('.wxx, .xxz') || /未学习|待考试|未通过|学习中|未完成/.test(text)) return 'pending';
    if (row.querySelector('.kstg') || /已通过|考试通过|已完成/.test(text)) return 'complete';
    return 'unknown';
  }

  function route(pathname) {
    if (/\/course\.jsp$/i.test(pathname)) return 'course';
    if (/\/(study2|polyv|cc)\.jsp$/i.test(pathname)) return 'video';
    if (/\/exam\.jsp$/i.test(pathname)) return 'exam';
    if (/\/examQuizFail\.jsp$/i.test(pathname)) return 'fail';
    if (/\/examQuizPass\.jsp$/i.test(pathname)) return 'pass';
    return 'unknown';
  }

  function createApp(environment) {
    const { document: doc, page, storage, location: locationRef } = environment;
    const clock = environment.now || Date.now;
    const delay = environment.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const navigate = environment.navigate || ((url) => locationRef.assign(url));
    const owner = environment.owner || `${clock()}-${Math.random().toString(36).slice(2)}`;
    let config = load('config', DEFAULTS);
    let context = load('context', null);
    let panel;
    let view;
    let busy = false;
    let timer;
    let status = '已暂停，打开课程目录后点击开始';
    let enteredAt = clock();
    let actionAt = 0;
    let videoStartedAt = 0;
    let lastReportAt = 0;
    let lastPlayAt = 0;
    let seekingAt = 0;
    let finishingAt = 0;
    let examJumps = 0;
    let examSubmitted = false;
    let failureHandled = false;
    let reviewPrepared = false;
    let reviewEntryClicked = false;
    let insufficientNoticeHandled = false;
    let originalAlert;
    let alertWrapper;
    let playerUnavailableAt = 0;
    let lastPlayerError = '';
    let directRequestedAt = 0;
    let questionFlag = null;
    let lastDirectError = '';
    const logs = [];

    function load(key, fallback) {
      const value = storage.get(PREFIX + key, null);
      if (value === null) return structuredClone(fallback);
      return structuredClone(value);
    }

    function save(key, value) {
      storage.set(PREFIX + key, value);
      if (key.startsWith('answers:') || key.startsWith('slow:')) {
        const keys = load('progressKeys', []);
        if (!keys.includes(key)) storage.set(PREFIX + 'progressKeys', [...keys, key]);
      }
    }

    function readConfig() {
      const saved = load('config', DEFAULTS);
      const settings = { ...DEFAULTS, ...saved, selectors: { ...DEFAULTS.selectors, ...saved.selectors } };
      if (!['direct', 'fast', 'normal'].includes(settings.studyMode)) settings.studyMode = 'direct';
      delete settings.fast;
      return settings;
    }

    function log(message) {
      const entry = `${new Date(clock()).toLocaleTimeString()} ${message}`;
      logs.push(entry);
      if (logs.length > 60) logs.shift();
      console.info('[CME助手]', message);
      render();
    }

    function setStatus(message) {
      if (status === message) return;
      status = message;
      render();
    }

    function all(selector, root = doc) {
      return [...root.querySelectorAll(selector)];
    }

    function visible(element) {
      if (!element || !element.isConnected || element.closest('[hidden]')) return false;
      const style = doc.defaultView.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }

    function text(element) {
      return normalizeText(element.textContent || element.value || '');
    }

    function findButton(pattern, root = doc) {
      return all('a, button, input[type="button"], input[type="submit"]', root)
        .find((element) => visible(element) && !element.disabled && pattern.test(text(element)));
    }

    function parameter(name) {
      return new URL(locationRef.href).searchParams.get(name) || doc.querySelector(`input[name="${name}"]`)?.value || '';
    }

    function courseUrl() {
      const id = parameter('course_id');
      if (!id) return null;
      const target = new URL('course.jsp', locationRef.href);
      target.searchParams.set('course_id', id);
      return target.href;
    }

    function persistContext() {
      save('context', context);
    }

    function hasLease() {
      const lease = load('lease', null);
      return lease?.owner === owner && lease.expires > clock();
    }

    async function acquireLease() {
      const lease = load('lease', null);
      if (lease && lease.owner !== owner && lease.expires > clock()) {
        setStatus('另一标签页正在运行；请保持单标签页学习');
        return false;
      }
      save('lease', { owner, expires: clock() + 8000 });
      if (lease?.owner !== owner) await delay(250);
      return hasLease();
    }

    function canAct() {
      return readConfig().enabled && hasLease();
    }

    function releaseLease() {
      if (load('lease', null)?.owner === owner) save('lease', null);
    }

    function stop(message = '已暂停') {
      config = readConfig();
      config.enabled = false;
      save('config', config);
      releaseLease();
      removeAlertHook();
      restoreQuestionFlag();
      setStatus(message);
      log(message);
    }

    function click(element, description) {
      if (!canAct()) return false;
      if (!element || !visible(element) || element.disabled) {
        stop(`找不到可操作的${description}，请手动检查`);
        return false;
      }
      actionAt = clock();
      element.click();
      log(description);
      return true;
    }

    function go(url, description) {
      const target = safeUrl(url, locationRef.href);
      if (!target) {
        stop('拒绝站外跳转或无效地址');
        return;
      }
      if (!canAct()) return;
      actionAt = clock();
      log(description);
      releaseLease();
      navigate(target);
    }

    function waitOrStop(message, seconds = 45) {
      if (clock() - enteredAt > seconds * 1000) stop(message);
      else setStatus(`等待页面加载：${message}`);
    }

    function beginCourse(url) {
      const target = safeUrl(url, locationRef.href);
      if (!target || route(new URL(target).pathname) !== 'course' || !new URL(target).searchParams.get('course_id')) {
        throw new Error('请提供当前站点带 course_id 的 course.jsp 课程目录地址');
      }
      context = { url: target, id: new URL(target).searchParams.get('course_id'), phase: 'learning', reviewUrl: '', lastExam: null };
      persistContext();
      resetPageState();
    }

    function resetPageState() {
      restoreQuestionFlag();
      enteredAt = clock();
      examSubmitted = false;
      failureHandled = false;
      reviewPrepared = false;
      reviewEntryClicked = false;
      finishingAt = 0;
      examJumps = 0;
      videoStartedAt = 0;
      seekingAt = 0;
      insufficientNoticeHandled = false;
      actionAt = 0;
      playerUnavailableAt = 0;
      directRequestedAt = 0;
      lastDirectError = '';
    }

    function start() {
      try {
        config = readConfig();
        context = load('context', null);
        if (route(locationRef.pathname) === 'unknown' && !['review', 'review-submitted'].includes(context?.phase)) {
          throw new Error('请从 course.jsp 课程目录或支持的视频、考试页面开始');
        }
        const currentId = parameter('course_id');
        if (!context || (currentId && context.id !== currentId) || context.phase === 'done') {
          beginCourse(route(locationRef.pathname) === 'course' ? locationRef.href : courseUrl());
        }
        config.enabled = true;
        save('config', config);
        resetPageState();
        installAlertHook();
        const mode = { direct: '直接进入考试', fast: '片尾尝试', normal: '正常播放' }[config.studyMode];
        log(`开始课程 ${context.id}，${mode}模式`);
        void tick();
      } catch (error) {
        stop(error.message);
      }
    }

    function rememberCourse() {
      const id = parameter('course_id');
      if (!id) {
        stop('当前课程目录缺少 course_id，无法区分课程');
        return false;
      }
      if (!context || context.id !== id) {
        stop('当前课程与运行任务不一致，请在此课程点击开始');
        return false;
      }
      context.url = locationRef.href;
      persistContext();
      return true;
    }

    function handleCourse() {
      if (!rememberCourse()) return;
      const rows = all('li.course_list');
      if (!rows.length) {
        waitOrStop('未识别章节列表 li.course_list；需要适配页面');
        return;
      }
      const pending = rows.find((row) => chapterStatus(row) === 'pending');
      if (pending) {
        if (context.phase !== 'learning') {
          context.phase = 'learning';
          context.reviewUrl = '';
          persistContext();
        }
        const links = all('a', pending);
        const anchor = links.find((element) => /\/(study2|polyv|cc|exam)\.jsp$/i.test(new URL(linkUrl(element, locationRef.href) || locationRef.href).pathname));
        if (!anchor) {
          stop('待学习章节缺少可识别的学习/考试地址');
          return;
        }
        const target = new URL(linkUrl(anchor, locationRef.href));
        context.chapterKey = target.searchParams.get('paper_id') || target.searchParams.get('courseware_id') || target.pathname + target.search;
        persistContext();
        go(target.href, `进入章节：${text(pending).slice(0, 80)}`);
        return;
      }
      if (rows.some((row) => chapterStatus(row) !== 'complete')) {
        stop('部分章节状态不明，不能认定全部完成；请提供该目录页面以便适配');
        return;
      }
      if (context.phase === 'learning') log(`课程 ${context.id} 的 ${rows.length} 个章节均已完成`);
      if (!config.review) {
        finishCourse('学习完成；自动评价未开启');
        return;
      }
      context.phase = context.phase === 'review-submitted' ? context.phase : 'review';
      persistContext();
      const entry = config.selectors.reviewEntry
        ? all(config.selectors.reviewEntry).find(visible)
        : findButton(/^(课程评价|课程评估|课程评议|评价课程|去评价|提交课程评价)$/);
      const evaluated = all('a, button, .status, .review-status, .evaluate-status')
        .some((element) => visible(element) && /^(已评价|评价已提交|已完成评价)$/.test(text(element)));
      if (evaluated) {
        finishCourse('页面确认已评价', true);
      } else if (reviewEntryClicked) {
        waitOrStop('已点击评价入口，但评价表单未出现', 30);
      } else if (entry) {
        const target = linkUrl(entry, locationRef.href);
        if (target) {
          context.reviewUrl = target;
          persistContext();
          go(target, '进入课程评价');
        } else {
          reviewEntryClicked = true;
          enteredAt = clock();
          entry.removeAttribute('target');
          click(entry, '打开课程评价');
        }
      } else {
        stop('章节已完成，但找不到课程评价入口；请设置评价入口选择器或手动打开评价页');
      }
    }

    function playerAdapter() {
      const nativeVideo = all('video').find(visible) || doc.querySelector('video');
      const candidates = [...new Set([page.cc_js_Player, page.player])].filter(Boolean);
      for (const candidate of candidates) {
        if (typeof candidate.getDuration !== 'function' || typeof candidate.getPosition !== 'function') continue;
        const adapter = {
          duration: () => readPlayerNumber(() => candidate.getDuration()),
          position: () => readPlayerNumber(() => candidate.getPosition()),
          play: () => candidate.play?.(),
          seek: typeof candidate.jumpToTime === 'function' ? (seconds) => candidate.jumpToTime(seconds) : null,
          paused: () => {
            try { return typeof candidate.isPaused === 'function' ? candidate.isPaused() : true; }
            catch { return false; }
          },
          rate: (value) => {
            const setter = ['setPlaybackRate', 'setPlayRate', 'setRate', 'setSpeed'].find((name) => typeof candidate[name] === 'function');
            if (setter) candidate[setter](value);
            else if (nativeVideo) nativeVideo.playbackRate = value;
          },
        };
        if (adapter.duration() > 0 && adapter.position() >= 0) return adapter;
      }
      if (!nativeVideo) return null;
      const adapter = {
        duration: () => readPlayerNumber(() => nativeVideo.duration),
        position: () => readPlayerNumber(() => nativeVideo.currentTime),
        play: () => nativeVideo.play(),
        seek: (seconds) => { nativeVideo.currentTime = seconds; },
        paused: () => nativeVideo.paused,
        rate: (value) => { nativeVideo.playbackRate = value; },
      };
      return adapter.duration() > 0 && adapter.position() >= 0 ? adapter : null;
    }

    function readPlayerNumber(getter) {
      try {
        const value = getter();
        if (value === null || value === undefined || value === '') return NaN;
        const number = Number(value);
        return Number.isFinite(number) ? number : NaN;
      } catch (error) {
        lastPlayerError = error.message;
        return NaN;
      }
    }

    function waitForPlayer(message) {
      if (!playerUnavailableAt) playerUnavailableAt = clock();
      if (clock() - playerUnavailableAt >= 90000) {
        stop(`${message}持续超过 90 秒，请检查播放器或刷新页面${lastPlayerError ? `：${lastPlayerError}` : ''}`);
      } else setStatus(`等待页面加载：${message}`);
    }

    function restoreQuestionFlag() {
      if (!questionFlag) return;
      if (page.questionIsOk === true) {
        if (questionFlag.existed) page.questionIsOk = questionFlag.value;
        else delete page.questionIsOk;
      }
      questionFlag = null;
    }

    function handleDirectExam() {
      if (directRequestedAt) {
        if (clock() - directRequestedAt >= 30000) stop('已请求直接考试但 30 秒内未跳转，请检查网站提示；不会改为强制播放');
        else setStatus('已设置 questionIsOk=true 并调用 gotoExam()，等待跳转');
        return;
      }
      if (typeof page.gotoExam !== 'function') {
        waitOrStop('网站 gotoExam 入口尚未就绪', 45);
        return;
      }
      if (!canAct()) return;
      questionFlag = { existed: Object.hasOwn(page, 'questionIsOk'), value: page.questionIsOk };
      page.questionIsOk = true;
      directRequestedAt = clock();
      actionAt = clock();
      try {
        page.gotoExam();
        log('直达考试：questionIsOk=true → gotoExam()');
        if (canAct()) setStatus('已请求直接进入考试，等待网站跳转');
      } catch (error) {
        directRequestedAt = 0;
        restoreQuestionFlag();
        lastDirectError = error.message;
        waitOrStop(`网站 gotoExam 暂不可用：${error.message}`, 45);
      }
    }

    function slowKey() {
      return `slow:${context.id}:${parameter('courseware_id') || parameter('paper_id') || locationRef.pathname + locationRef.search}`;
    }

    function useRealPlayback(reason) {
      if (load(slowKey(), false)) {
        stop(`${reason}；正常播放仍未满足网站要求，请手动检查`);
        return;
      }
      save(slowKey(), true);
      seekingAt = 0;
      finishingAt = 0;
      examJumps = 0;
      const player = playerAdapter();
      if (player?.seek) player.seek(0);
      videoStartedAt = clock();
      log(`${reason}；从头正常播放，不伪造学习时长`);
    }

    function installAlertHook() {
      if (alertWrapper) return;
      originalAlert = page.alert;
      alertWrapper = function (message) {
        if (canAct() && route(locationRef.pathname) === 'video' && /学习时长不足/.test(String(message))) {
          if (config.studyMode === 'direct') stop('网站拒绝直接考试：学习时长不足。可手动选择片尾尝试或正常播放模式');
          else useRealPlayback('网站提示学习时长不足');
          return;
        }
        return originalAlert.call(page, message);
      };
      page.alert = alertWrapper;
    }

    function removeAlertHook() {
      if (alertWrapper && page.alert === alertWrapper) page.alert = originalAlert;
      alertWrapper = null;
    }

    async function handleVideo() {
      if (config.studyMode === 'direct') {
        handleDirectExam();
        return;
      }
      const checkin = all('.xywarp').find(visible);
      if (checkin) {
        if (!config.checkin) {
          stop('需要过程签到，请手动完成后继续');
          return;
        }
        const button = checkin.querySelector('.zfb_btns1 a');
        if (!button) {
          stop('遇到未知签到页面，请手动处理');
          return;
        }
        click(button, '完成过程签到');
        return;
      }
      const player = playerAdapter();
      const duration = player?.duration();
      if (!player || !Number.isFinite(duration) || duration <= 0) {
        waitForPlayer('播放器未就绪；支持 CC、Polyv 页面播放器和 HTML5 video');
        return;
      }
      if (!videoStartedAt) {
        videoStartedAt = clock();
        try {
          player.rate(config.rate);
        } catch (error) {
          log(`播放器拒绝倍速设置，继续原速：${error.message}`);
        }
        if (config.studyMode === 'fast' && !load(slowKey(), false)) {
          if (player.seek) {
            seekingAt = clock();
            try {
              player.seek(Math.max(0, duration - 0.5));
            } catch {
              useRealPlayback('播放器拒绝跳转');
              return;
            }
            log('尝试跳到片尾，等待播放器实际位置更新');
          } else useRealPlayback('播放器不支持跳转');
        }
      }
      if (clock() - videoStartedAt > Math.max(90 * 60 * 1000, duration * 1500)) {
        stop('视频播放超时，请检查播放器、网络或验证码');
        return;
      }
      const position = player.position();
      if (!Number.isFinite(position) || position < 0) {
        waitForPlayer('播放器进度未就绪');
        return;
      }
      if (playerUnavailableAt) log('播放器已就绪，恢复自动学习');
      playerUnavailableAt = 0;
      setStatus(`正在学习：${Math.floor(position)} / ${Math.ceil(duration)} 秒${load(slowKey(), false) ? '（正常播放兜底）' : ''}`);
      if (seekingAt && position < duration - 1 && clock() - seekingAt > 30000) {
        useRealPlayback('片尾跳转未成功');
        return;
      }
      if (player.paused() && clock() - lastPlayAt > 5000) {
        lastPlayAt = clock();
        try {
          await player.play();
        } catch (error) {
          stop(`浏览器阻止自动播放，请先手动点播放再开始：${error.message}`);
          return;
        }
        if (!canAct()) return;
      }
      if (typeof page.updatePlayStatus === 'function' && clock() - lastReportAt > 15000) {
        page.updatePlayStatus(1);
        lastReportAt = clock();
      }
      if (!canAct()) return;
      const latestPosition = player.position();
      if (!Number.isFinite(latestPosition) || latestPosition < 0) {
        waitForPlayer('播放器进度暂不可用');
        return;
      }
      if (latestPosition < position - 1) return;
      if (position < duration - 0.8) return;
      if (!finishingAt) {
        finishingAt = clock();
        if (typeof page.playEnd === 'function') page.playEnd();
        log('播放器已到片尾，等待网站完成学习记录');
        return;
      }
      if (clock() - finishingAt < 2500 || clock() - actionAt < 10000) return;
      if (examJumps >= 3) {
        stop('进入考试未成功，请检查学习记录或网站提示');
        return;
      }
      examJumps += 1;
      actionAt = clock();
      const examLink = doc.querySelector('a[onclick*="gotoExam"], a[href*="exam.jsp"]');
      if (typeof page.gotoExam === 'function') {
        page.gotoExam();
        log('调用网站 gotoExam 进入考试');
      } else if (examLink) click(examLink, '进入考试');
      else stop('找不到 gotoExam 或考试入口，需要适配当前视频页');
    }

    function questionTitle(container, feedback = false) {
      const title = container.querySelector('h3, h2, .question_title, .question-title, .question, .title');
      let content;
      if (title) content = title.textContent;
      else {
        const copy = container.cloneNode(true);
        copy.querySelectorAll('ul, ol, label, input, select, textarea, .options, .option').forEach((element) => element.remove());
        content = copy.textContent;
      }
      if (feedback) content = content.replace(/\s*(?:您的答案|你的答案|正确答案|参考答案)\s*[:：][\s\S]*$/, '');
      return questionKey(content);
    }

    function questionIdentifier(container, inputs = []) {
      for (const attribute of ['data-question-id', 'data-ques-id', 'data-qid']) {
        const id = container.getAttribute(attribute);
        if (id) return id.trim().toLowerCase();
      }
      const hidden = all('input[type="hidden"]', container)
        .find((input) => /(?:question|ques|qid).*id|^(?:question_id|ques_id|qid)$/i.test(input.name));
      if (hidden?.value) return hidden.value.trim().toLowerCase();
      const ids = [...new Set(inputs.map((input) => input.name.match(/[a-f0-9]{32}/i)?.[0]?.toLowerCase()).filter(Boolean))];
      return ids.length === 1 ? ids[0] : '';
    }

    function optionTitle(input) {
      const label = input.labels?.[0] || input.closest('label') || input.parentElement;
      return normalizeText(label?.textContent).replace(/^[A-L][.、．:：]\s*/i, '') || String(input.value);
    }

    function examQuestions() {
      return all('.exam_list > li').filter((item) => item.querySelector('input[type="radio"], input[type="checkbox"]')).map((item) => {
        const inputs = all('input[type="radio"], input[type="checkbox"]', item);
        const title = questionTitle(item);
        const id = questionIdentifier(item, inputs);
        return { title, id, key: id ? `id:${id}` : title, inputs, multi: inputs.every((input) => input.type === 'checkbox'), options: inputs.map(optionTitle) };
      });
    }

    function memoryKey() {
      return `answers:${context.id}:${parameter('paper_id') || parameter('courseware_id') || context.chapterKey || locationRef.pathname + locationRef.search}`;
    }

    async function handleExam() {
      if (examSubmitted) {
        waitOrStop('已提交试卷但没有跳转，可能需要手动确认或填写验证码', 60);
        return;
      }
      const questions = examQuestions();
      if (!questions.length) {
        if (clock() - enteredAt > 45000) {
          stop('开始考试后仍没有题目，可能需要手动处理');
          return;
        }
        const startButton = findButton(/^(开始考试|立即考试|确认并开始|开始答题)$/);
        if (startButton) click(startButton, '开始答题');
        else waitOrStop('未识别 .exam_list 题目');
        return;
      }
      const memory = load(memoryKey(), { attempts: 0, questions: {} });
      if (memory.attempts >= config.maxAttempts) {
        stop(`达到 ${config.maxAttempts} 次提交上限，请检查题目和答案`);
        return;
      }
      const seen = new Set();
      const snapshot = [];
      for (const question of questions) {
        if (!question.title || seen.has(question.key) || new Set(question.options).size !== question.options.length
          || question.inputs.length > 12 || question.inputs.some((input) => input.disabled)
          || (!question.multi && question.inputs.some((input) => input.type !== 'radio'))) {
          stop('题干为空、重复、选项过多或禁用；不能可靠匹配答案');
          return;
        }
        seen.add(question.key);
        const legacyKey = Object.keys(memory.questions).find((key) => !key.startsWith('id:') && questionKey(key) === question.title);
        let answer = Object.hasOwn(memory.questions, question.key) ? memory.questions[question.key] : legacyKey ? memory.questions[legacyKey] : null;
        const signature = JSON.stringify([...question.options].sort());
        if (!answer || answer.signature !== signature || answer.multi !== question.multi) answer = { signature, mask: question.multi ? nextMask(0, question.inputs.length) : 1, tried: [], correct: false, options: question.options, multi: question.multi };
        if (question.multi && answer.mask !== null) {
          const mask = nextMask(answer.mask - 1, question.inputs.length);
          if (mask !== answer.mask) {
            answer.mask = mask;
            answer.correct = false;
          }
        }
        if (answer.mask === null) {
          stop(`已尝试该题全部组合：${question.title.slice(0, 50)}`);
          return;
        }
        const desiredTitles = answer.options.filter((option, index) => answer.mask & (2 ** index));
        for (let index = 0; index < question.inputs.length; index += 1) {
          if (!canAct()) return;
          const input = question.inputs[index];
          const selected = desiredTitles.includes(question.options[index]);
          if (selected !== input.checked && (question.multi || selected)) input.click();
        }
        if (question.inputs.some((input, index) => input.checked !== desiredTitles.includes(question.options[index]))) {
          stop('无法可靠选择答案，试卷未提交');
          return;
        }
        answer.title = question.title;
        answer.id = question.id;
        memory.questions[question.key] = answer;
        const letters = question.inputs.flatMap((input, index) => input.checked
          ? [/^[A-L]$/i.test(input.value) ? input.value.toUpperCase() : String.fromCharCode(65 + index)] : []).join('');
        snapshot.push({ key: question.key, title: question.title, id: question.id, letters, selected: desiredTitles, mask: answer.mask });
      }
      const submit = doc.querySelector('#tjkj, .btn1[onclick*="doSubmit"]') || findButton(/^(提交试卷|提交答案|交卷)$/);
      if (!submit || !visible(submit) || submit.disabled) {
        stop('未识别交卷按钮，保留已选答案，请手动提交');
        return;
      }
      await delay(600);
      if (!canAct()) return;
      if (!visible(submit) || submit.disabled) {
        stop('交卷按钮已不可用，未提交试卷');
        return;
      }
      memory.attempts += 1;
      save(memoryKey(), memory);
      context.lastExam = { key: memoryKey(), attempt: memory.attempts, snapshot };
      persistContext();
      const form = submit.closest('form') || doc.querySelector('form[name="form1"]');
      if (form) form.removeAttribute('target');
      examSubmitted = true;
      enteredAt = clock();
      click(submit, `提交第 ${memory.attempts} 次试卷，共 ${questions.length} 题`);
    }

    function feedbackChoice(item, answer) {
      if (!item) return null;
      const match = normalizeText(item.textContent).match(/正确答案\s*[:：]\s*([A-L](?:[\s,，、]*[A-L])*)/i);
      if (!match) return null;
      const letters = match[1].toUpperCase().replace(/[^A-L]/g, '');
      const inputs = all('input[type="radio"], input[type="checkbox"]', item);
      const feedbackOptions = inputs.map(optionTitle);
      const ordered = feedbackOptions.length === answer.options.length ? feedbackOptions : null;
      if (!ordered) return null;
      let mask = 0;
      for (const letter of letters) {
        const label = ordered[letter.charCodeAt(0) - 65];
        const index = answer.options.indexOf(label);
        if (index < 0) return null;
        mask |= 2 ** index;
      }
      return answer.multi && (mask & (mask - 1)) === 0 ? null : mask || null;
    }

    function feedbackFromUrl(lastExam, memory) {
      const parameters = new URL(locationRef.href).searchParams;
      if (!parameters.has('ansList') || !parameters.has('error_order')) return null;
      const submitted = parameters.get('ansList').split(',').map((value) => value.replace(/[\s，、]/g, '').toUpperCase());
      if (submitted.length !== lastExam.snapshot.length || submitted.some((value) => !/^[A-L]+$/.test(value))) {
        throw new Error('ansList 与本轮试卷长度或格式不符，不能复用反馈');
      }
      const orderValues = parameters.get('error_order').split(',').map((value) => value.trim()).filter(Boolean);
      if (orderValues.some((value) => !/^[1-9]\d*$/.test(value))) throw new Error('error_order 包含无效题号');
      const orders = orderValues.map(Number);
      if (new Set(orders).size !== orders.length || orders.some((value) => value > submitted.length)) throw new Error('error_order 题号重复或越界');
      const ids = (parameters.get('error_ques') || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (ids.length && ids.length !== orders.length) throw new Error('error_ques 与错题数量不一致');
      return lastExam.snapshot.map((question, index) => {
        const key = question.key || question.title;
        const answer = memory.questions[key];
        if (!answer) throw new Error('缺少本轮题目答案记忆，请返回考试页重新开始');
        const letters = question.letters || answer.options.flatMap((option, optionIndex) => question.mask & (2 ** optionIndex) ? [String.fromCharCode(65 + optionIndex)] : []).join('');
        if ([...letters].sort().join('') !== [...submitted[index]].sort().join('')) throw new Error('结果页 ansList 不属于已记录的这次提交，不能按旧反馈改答案');
        const wrongIndex = orders.indexOf(index + 1);
        if (wrongIndex >= 0 && question.id && ids[wrongIndex] && question.id.toLowerCase() !== ids[wrongIndex]) throw new Error('结果页错题 ID 与提交记录不符');
        return { key, title: question.title, wrong: wrongIndex >= 0, item: null };
      });
    }

    function handleFail() {
      if (failureHandled) {
        waitOrStop('重新答题没有跳转，请手动检查', 30);
        return;
      }
      const lastExam = context.lastExam;
      if (!lastExam) {
        stop('缺少本次试卷记录；请返回考试页重新开始');
        return;
      }
      const items = all('.answer_list');
      const memory = load(lastExam.key, null);
      if (!memory?.questions) {
        stop('缺少试卷答案记忆，请返回考试页重新开始');
        return;
      }
      const token = JSON.stringify([lastExam.attempt ?? memory.attempts, lastExam.snapshot]);
      const retry = doc.querySelector('#cxdt') || findButton(/^(重新答题|重新考试|再次考试)$/);
      if (memory.lastFeedback === token) {
        if (lastExam.snapshot.some((question) => memory.questions[question.key || question.title]?.mask === null)) {
          stop('本轮已有题目穷举耗尽，需要手动检查');
          return;
        }
        failureHandled = true;
        enteredAt = clock();
        click(retry, '本轮反馈已处理，使用已修正答案重新答题');
        return;
      }
      let feedback = feedbackFromUrl(lastExam, memory);
      const fromUrl = Boolean(feedback);
      const domFeedback = new Map();
      for (const item of items) {
        const title = questionTitle(item, true);
        const id = questionIdentifier(item);
        const candidates = lastExam.snapshot.filter((question) => id && question.id ? id === question.id : questionKey(question.title) === title);
        const heading = item.querySelector('h3');
        const wrong = heading?.classList.contains('cuo') ? true : heading?.classList.contains('dui') ? false : null;
        if (candidates.length !== 1 || wrong === null) {
          if (fromUrl) continue;
          stop('结果题干或对错标记无法匹配；不按新题号猜测');
          return;
        }
        const question = candidates[0];
        const key = question.key || question.title;
        if (domFeedback.has(key)) {
          stop('结果页包含重复题目，不能安全修正');
          return;
        }
        domFeedback.set(key, { key, title: question.title, wrong, item });
      }
      if (fromUrl) {
        for (const entry of feedback) {
          const dom = domFeedback.get(entry.key);
          if (dom && dom.wrong !== entry.wrong) {
            stop('URL 错题参数与页面对错标记矛盾，未修改答案');
            return;
          }
          if (dom) entry.item = dom.item;
        }
      } else feedback = [...domFeedback.values()];
      if (!feedback.length) {
        waitOrStop('未识别逐题对错结果，不能安全重试');
        return;
      }
      if (feedback.length !== lastExam.snapshot.length) {
        stop('考试未通过，但逐题结果缺失，请手动检查');
        return;
      }
      let wrong = 0;
      let exhausted = '';
      for (const entry of feedback) {
        const answer = memory.questions[entry.key];
        if (!answer) {
          stop('结果题目缺少对应的答案记忆');
          return;
        }
        if (!entry.wrong) answer.correct = true;
        else {
          wrong += 1;
          answer.correct = false;
          answer.tried.push(answer.mask);
          const disclosed = feedbackChoice(entry.item, answer);
          answer.mask = disclosed || (answer.multi ? nextMask(answer.mask, answer.options.length) : answer.mask * 2);
          if (answer.mask !== null && answer.mask > 2 ** answer.options.length - 1) answer.mask = null;
          if (answer.mask === null || answer.tried.includes(answer.mask)) exhausted = entry.title;
        }
      }
      if (!wrong) {
        stop('考试未通过，但反馈没有错题，请手动检查');
        return;
      }
      memory.lastFeedback = token;
      save(lastExam.key, memory);
      if (exhausted) {
        stop(`该题选项已耗尽或结果矛盾：${exhausted.slice(0, 50)}`);
        return;
      }
      failureHandled = true;
      enteredAt = clock();
      click(retry, `保留正确答案，修正 ${wrong} 道错题并重新答题`);
    }

    function handlePass() {
      context.lastExam = null;
      persistContext();
      const returnLink = doc.querySelector('.show_exam_btns a[href*="course.jsp"], a[href*="course.jsp"]');
      const target = returnLink && linkUrl(returnLink, locationRef.href);
      go(target || context.url, '考试通过，返回课程目录');
    }

    function reviewForm() {
      if (config.selectors.reviewForm) return all(config.selectors.reviewForm).find(visible);
      return all('form').find((form) => visible(form) && /评价|满意|评估/.test(text(form))
        && form.querySelector('input[type="radio"], select, textarea'));
    }

    function reviewSucceeded() {
      if (config.selectors.reviewSuccess) return all(config.selectors.reviewSuccess).some(visible);
      return all('h1, h2, h3, .success, .message, .msg, .tip, .tips, [role="alert"]')
        .some((element) => visible(element) && /评价成功|评价提交成功|感谢您的评价|评价已提交/.test(text(element)));
    }

    function chooseReviewOption(inputs) {
      const choice = normalizeText(config.reviewChoice);
      const options = inputs.map((input) => ({ input, label: optionTitle(input) }));
      return options.find((option) => normalizeText(option.label) === choice)
        || options.find((option) => String(option.input.value) === choice);
    }

    async function handleReview() {
      if (!config.review) {
        stop('自动评价已关闭，请手动评价或返回目录继续');
        return;
      }
      if (reviewSucceeded()) {
        finishCourse('已确认课程评价成功', true);
        return;
      }
      if (context.phase === 'review-submitted') {
        if (route(locationRef.pathname) === 'course' && all('a, button, .status, .review-status, .evaluate-status')
          .some((element) => visible(element) && /^(已评价|评价已提交|已完成评价)$/.test(text(element)))) {
          const rows = all('li.course_list');
          if (rows.length && rows.every((row) => chapterStatus(row) === 'complete')) finishCourse('目录确认已评价', true);
          else stop('返回目录后章节状态不明确，无法确认评价对应课程');
          return;
        }
        waitOrStop('评价已提交，但未确认成功；不重复提交。请检查结果或设置成功标记', 30);
        return;
      }
      const form = reviewForm();
      if (!form) {
        if (route(locationRef.pathname) === 'course') handleCourse();
        else waitOrStop('未识别课程评价表单，请设置评价表单选择器');
        return;
      }
      if (!reviewPrepared) {
        const groups = new Map();
        for (const input of all('input[type="radio"]', form)) {
          if (!input.name) {
            stop('评价选项没有分组名称，需要适配');
            return;
          }
          if (!groups.has(input.name)) groups.set(input.name, []);
          groups.get(input.name).push(input);
        }
        for (const inputs of groups.values()) {
          const option = chooseReviewOption(inputs);
          if (!option || option.input.disabled) {
            stop(`评价选项中没有“${config.reviewChoice}”；请按页面原文修改评价选项`);
            return;
          }
          if (!canAct()) return;
          if (!option.input.checked) option.input.click();
          if (!option.input.checked) {
            stop('评价选项未成功选中，不提交');
            return;
          }
        }
        for (const select of all('select', form)) {
          const option = [...select.options].find((entry) => normalizeText(entry.textContent) === normalizeText(config.reviewChoice) || entry.value === config.reviewChoice);
          if (!option || select.disabled) {
            stop('评价下拉框与设置不匹配，需要手动处理');
            return;
          }
          select.value = option.value;
          select.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
        }
        for (const textarea of all('textarea', form)) {
          if (textarea.disabled) continue;
          textarea.value = config.reviewText;
          textarea.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
          textarea.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
        }
        if (form.querySelector('input[type="checkbox"]') || !form.checkValidity?.()) {
          stop('评价含未适配的勾选项或必填字段；请手动填写，不自动猜测');
          return;
        }
        reviewPrepared = true;
        log(`已填写评价选项“${config.reviewChoice}”，等待提交`);
      }
      const submit = config.selectors.reviewSubmit
        ? form.querySelector(config.selectors.reviewSubmit)
        : findButton(/^(提交|提交评价|提交课程评价|确认提交|保存评价)$/ , form);
      if (!submit) {
        stop('没有识别评价提交按钮，请设置评价提交选择器');
        return;
      }
      await delay(800);
      if (!canAct()) return;
      if (!visible(submit) || submit.disabled) {
        stop('评价提交按钮已不可用，未提交评价');
        return;
      }
      context.phase = 'review-submitted';
      context.reviewUrl = locationRef.href;
      persistContext();
      enteredAt = clock();
      form.removeAttribute('target');
      click(submit, '提交课程评价，等待网站确认');
    }

    function finishCourse(message, reviewed = false) {
      const completed = load('completed', {});
      completed[context.id] = { at: clock(), reviewed, url: context.url };
      save('completed', completed);
      context.phase = 'done';
      persistContext();
      log(message);
      const target = config.queue.find((url) => {
        const previous = completed[new URL(url).searchParams.get('course_id')];
        return !previous || (config.review && !previous.reviewed);
      });
      if (!target) {
        stop('当前课程及队列已完成');
        return;
      }
      beginCourse(target);
      go(target, `进入队列中的下一门课程 ${context.id}`);
    }

    function pageBlocked() {
      if (all('input[type="password"]').some(visible)) return '登录页面，请先手动登录';
      if (all('input').some((input) => visible(input) && /captcha|verifycode|checkcode|验证码/i.test(`${input.name} ${input.id} ${input.placeholder}`))) return '页面需要验证码，请手动完成';
      if (all('h1, h2, h3, [role="dialog"], .verify-dialog').some((element) => visible(element)
        && /^(人脸识别|身份核验)$|请.*(人脸识别|身份核验|人机验证)/.test(text(element)))) return '页面需要人工身份验证';
      return '';
    }

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        config = readConfig();
        if (!config.enabled) {
          removeAlertHook();
          releaseLease();
          return;
        }
        context = load('context', null);
        const currentRoute = route(locationRef.pathname);
        if (currentRoute === 'unknown' && !['review', 'review-submitted'].includes(context?.phase)) {
          setStatus('本页不参与自动学习；请打开课程目录、视频或考试页');
          return;
        }
        if (!context || !(await acquireLease()) || !canAct()) return;
        installAlertHook();
        const blocked = pageBlocked();
        if (blocked) {
          stop(blocked);
          return;
        }
        const currentId = parameter('course_id');
        if (currentId && currentId !== context.id) {
          stop('检测到另一门课程，请在该课程点击开始；不要多标签页同时学习');
          return;
        }
        if (clock() - actionAt < 3000) return;
        if (currentRoute === 'video' && /学习时长不足/.test(normalizeText(doc.body.textContent)) && !insufficientNoticeHandled) {
          insufficientNoticeHandled = true;
          if (config.studyMode === 'direct') {
            stop('页面提示学习时长不足，直达考试被拒绝；请检查提示或切换模式');
            return;
          }
          useRealPlayback('页面提示学习时长不足');
        }
        if (['review', 'review-submitted'].includes(context.phase)) await handleReview();
        else if (currentRoute === 'course') handleCourse();
        else if (currentRoute === 'video') await handleVideo();
        else if (currentRoute === 'exam') await handleExam();
        else if (currentRoute === 'fail') handleFail();
        else if (currentRoute === 'pass') handlePass();
        else waitOrStop('当前页面不是支持的课程、视频、考试或评价页', 30);
      } catch (error) {
        stop(`异常：${error.message}`);
        console.error('[CME助手]', error);
      } finally {
        busy = false;
      }
    }

    function diagnostic() {
      return JSON.stringify({
        version: '0.3.1',
        page: { origin: locationRef.origin, pathname: locationRef.pathname, courseId: parameter('course_id') },
        route: route(locationRef.pathname),
        phase: context?.phase,
        status,
        counts: { chapters: all('li.course_list').length, questions: all('.exam_list > li').length, results: all('.answer_list').length, videos: all('video').length },
        player: { cc: Boolean(page.cc_js_Player), other: Boolean(page.player), gotoExam: typeof page.gotoExam === 'function' },
        examGate: { flagName: 'questionIsOk', value: page.questionIsOk ?? null },
        lastPlayerError,
        lastDirectError,
        settings: { ...config, queue: config.queue.map((url) => new URL(url).pathname), reviewText: '[已省略]' },
        logs,
      }, null, 2);
    }

    function render() {
      if (!view) return;
      view.querySelector('[data-status]').textContent = status;
      view.querySelector('[data-log]').textContent = logs.slice(-12).join('\n');
      view.querySelector('[data-course]').textContent = context ? `课程 ${context.id} · ${context.phase}` : '未开始';
    }

    function mount() {
      if (doc.getElementById('cme-study-assistant')) return;
      panel = doc.createElement('div');
      panel.id = 'cme-study-assistant';
      view = panel.attachShadow({ mode: 'open' });
      view.innerHTML = `
        <style>
          :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 13px/1.5 system-ui, sans-serif; color: #172033; }
          * { box-sizing: border-box; } section { width: 340px; max-width: calc(100vw - 32px); max-height: 85vh; overflow: auto; padding: 14px; border: 1px solid #cbd5e1; border-radius: 12px; background: #fff; box-shadow: 0 6px 32px #0003; }
          header { display: flex; justify-content: space-between; align-items: center; } strong { font-size: 15px; } p { margin: 8px 0; } small { color: #64748b; }
          button { cursor: pointer; padding: 6px 10px; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 6px; margin: 3px 3px 3px 0; font: inherit; }
          button[data-start] { color: #fff; background: #2563eb; } button[data-stop] { color: #b91c1c; border-color: #fecaca; background: #fff1f2; }
          details { margin-top: 9px; } summary { cursor: pointer; } label { display: block; margin: 7px 0; } input:not([type=checkbox]), textarea, select { width: 100%; padding: 5px; border: 1px solid #cbd5e1; border-radius: 4px; font: inherit; } textarea { min-height: 55px; }
          pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 monospace; max-height: 140px; overflow: auto; background: #f8fafc; padding: 6px; }
          [data-status] { padding: 8px; background: #eff6ff; border-radius: 6px; overflow-wrap: anywhere; }
          .collapsed > :not(header) { display: none; } .collapsed { width: 190px; }
        </style>
        <section>
          <header><strong>CME 学习助手</strong><button data-collapse>收起</button></header>
          <p><small data-course></small></p><p data-status></p>
          <button data-start>开始 / 继续</button><button data-stop>暂停</button><button data-diagnostic>导出诊断</button>
          <details><summary>设置与课程队列</summary>
            <p><small>保存设置会先暂停。暂停只停止助手操作，不停止网站自身播放。</small></p>
            <label>学习 / 考试模式<select data-mode><option value="direct">直接考试：questionIsOk=true → gotoExam()</option><option value="fast">片尾尝试：失败后从头播放</option><option value="normal">正常播放</option></select></label>
            <p><small>直接考试不读取播放器、不等待视频结束；网站拒绝时暂停。片尾模式沿用参考项目思路。</small></p>
            <label>正常播放倍速<select data-rate><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×（播放器可能不支持）</option></select></label>
            <label><input type="checkbox" data-checkin> 自动点击已识别的过程签到</label>
            <label>试卷提交上限<input type="number" min="1" max="100" data-attempts></label>
            <label><input type="checkbox" data-review> 我确认按以下设置自动填写并提交课程评价</label>
            <label>评价选项原文 / value<input data-review-choice placeholder="非常满意"></label>
            <label>评价文字（可留空）<textarea data-review-text></textarea></label>
            <label>后续课程目录地址（每行一个，同站点 course.jsp）<textarea data-queue></textarea></label>
            <details><summary>评价页面适配（CSS 选择器）</summary>
              <label>评价入口<input data-selector="reviewEntry" placeholder="如 a.evaluate"></label>
              <label>评价表单<input data-selector="reviewForm" placeholder="如 form#evaluation"></label>
              <label>表单内提交按钮<input data-selector="reviewSubmit" placeholder="如 #submitEvaluate"></label>
              <label>提交成功标记<input data-selector="reviewSuccess" placeholder="如 .evaluation-success"></label>
              <small>留空使用保守识别；不匹配时暂停。成功标记必须仅在真正提交成功后出现。</small>
            </details>
            <button data-save>保存设置</button><button data-reset>重置助手进度</button>
          </details>
          <details><summary>运行日志</summary><pre data-log></pre></details>
          <p><small>只操作当前已报名课程；不绕过验证码、身份验证或网站时长校验。</small></p>
        </section>`;
      doc.body.appendChild(panel);
      config = readConfig();
      view.querySelector('[data-mode]').value = config.studyMode;
      view.querySelector('[data-rate]').value = String(config.rate);
      view.querySelector('[data-checkin]').checked = config.checkin;
      view.querySelector('[data-attempts]').value = config.maxAttempts;
      view.querySelector('[data-review]').checked = config.review;
      view.querySelector('[data-review-choice]').value = config.reviewChoice;
      view.querySelector('[data-review-text]').value = config.reviewText;
      view.querySelector('[data-queue]').value = config.queue.join('\n');
      for (const input of all('[data-selector]', view)) input.value = config.selectors[input.dataset.selector];
      view.querySelector('[data-start]').addEventListener('click', start);
      view.querySelector('[data-stop]').addEventListener('click', () => stop());
      view.querySelector('[data-collapse]').addEventListener('click', (event) => {
        const collapsed = view.querySelector('section').classList.toggle('collapsed');
        event.target.textContent = collapsed ? '展开' : '收起';
      });
      view.querySelector('[data-diagnostic]').addEventListener('click', () => {
        const blob = new doc.defaultView.Blob([diagnostic()], { type: 'application/json' });
        const url = doc.defaultView.URL.createObjectURL(blob);
        const anchor = doc.createElement('a');
        anchor.href = url;
        anchor.download = `cme-diagnostic-${clock()}.json`;
        anchor.click();
        setTimeout(() => doc.defaultView.URL.revokeObjectURL(url), 1000);
      });
      view.querySelector('[data-save]').addEventListener('click', () => {
        stop('保存设置前暂停');
        try {
          const queue = view.querySelector('[data-queue]').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
            const url = safeUrl(line, locationRef.href);
            if (!url || route(new URL(url).pathname) !== 'course' || !new URL(url).searchParams.get('course_id')) throw new Error('队列中存在站外地址或缺少 course_id 的课程地址');
            return url;
          });
          const maxAttempts = Number(view.querySelector('[data-attempts]').value);
          if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error('提交上限必须为 1–100');
          const selectors = {};
          for (const input of all('[data-selector]', view)) {
            if (input.value.trim()) doc.querySelector(input.value.trim());
            selectors[input.dataset.selector] = input.value.trim();
          }
          config = { ...readConfig(), enabled: false, queue: [...new Set(queue)], maxAttempts, selectors,
            studyMode: view.querySelector('[data-mode]').value, rate: Number(view.querySelector('[data-rate]').value),
            checkin: view.querySelector('[data-checkin]').checked, review: view.querySelector('[data-review]').checked,
            reviewChoice: view.querySelector('[data-review-choice]').value.trim(), reviewText: view.querySelector('[data-review-text]').value.trim() };
          if (config.review && !config.reviewChoice) throw new Error('开启评价时必须填写评价选项');
          save('config', config);
          setStatus('设置已保存，请点击开始 / 继续');
          log('设置已保存，点击开始 / 继续生效');
        } catch (error) {
          setStatus(`设置未保存：${error.message}`);
        }
      });
      view.querySelector('[data-reset]').addEventListener('click', () => {
        if (!page.confirm('清除助手的课程队列完成记录和当前课程答案记忆？不会修改网站学习记录。切换账号前建议重置。')) return;
        stop('已重置助手进度');
        const keys = load('progressKeys', []);
        for (const key of keys) storage.set(PREFIX + key, null);
        save('progressKeys', []);
        save('completed', {});
        save('context', null);
        context = null;
        render();
      });
      render();
      timer = setInterval(() => { void tick(); }, 1000);
      doc.defaultView.addEventListener('pagehide', dispose, { once: true });
      void tick();
    }

    function dispose() {
      clearInterval(timer);
      releaseLease();
      removeAlertHook();
      restoreQuestionFlag();
    }

    return { mount, start, stop, tick, dispose, diagnostic, examQuestions, reviewForm };
  }

  const api = { normalizeText, questionKey, safeUrl, linkUrl, nextMask, chapterStatus, route, createApp };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  if (window.top !== window.self) return;
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
    console.error('[CME助手] 缺少油猴存储 API，请使用 Tampermonkey 安装，不要在控制台直接粘贴运行');
    return;
  }
  const app = createApp({ document, page, location, storage: { get: (key, fallback) => GM_getValue(key, fallback), set: (key, value) => GM_setValue(key, value) } });
  app.mount();
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('CME：开始 / 继续', app.start);
    GM_registerMenuCommand('CME：暂停', () => app.stop());
  }
})();
