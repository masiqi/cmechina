// ==UserScript==
// @name         好医生北京全员必修课 - 全自动(进考试+答题+循环)
// @namespace    https://tampermonkey.local/
// @version      6.0.1
// @description  北京全员培训章节遍历、有限重考与答案缓存；可停止、清除记录；不自动申请学分，不保证满足观看时长要求。
// @match        https://bjsqypx.haoyisheng.com/qypx/bj/zkbd.jsp*
// @match        http://bjsqypx.haoyisheng.com/qypx/bj/zkbd.jsp*
// @match        https://bjsqypx.haoyisheng.com/qypx/bj/cc.jsp*
// @match        http://bjsqypx.haoyisheng.com/qypx/bj/cc.jsp*
// @match        https://bjsqypx.haoyisheng.com/qypx/bj/slog.jsp*
// @match        http://bjsqypx.haoyisheng.com/qypx/bj/slog.jsp*
// @match        https://bjsqypx.haoyisheng.com/qypx/bj/exam.jsp*
// @match        http://bjsqypx.haoyisheng.com/qypx/bj/exam.jsp*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @connect      bjsqypx.haoyisheng.com
// @run-at       document-end
// @noframes
// ==/UserScript==

/*  浏览器端状态机(每页只做一件事后 location.href 跳走，无需跨页持久状态)：
    zkbd.jsp ─选第一个「未学习」课件→ cc.jsp
    cc.jsp   ─提 slog.jsp URL 直跳──→ slog.jsp
    slog.jsp ─页面自带脚本自动跳────→ exam.jsp  (脚本兜底自跳)
    exam.jsp ─排除法答题，通过后───→ zkbd.jsp  ← 回列表，下一轮选下一个未学习
    回到 zkbd 时该课件状态可能已变「已通过」，跳过；无未学习项 → 全部完成。        */

(function () {
    'use strict';

    var TAG = '[好医生全自动]';
    var FAIL_KEY = 'hys_failed_cware:' + courseId();
    var KNOWN = 'hys_known_answers';     // 题目ID -> 已确认正确的"选项文字"数组
    var page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    var stopped = false;
    var scheduled = [];
    var activeRequest = null;
    try { stopped = sessionStorage.getItem('hys_paused') === '1'; } catch (e) {}

    function later(action, milliseconds) {
        var timer = setTimeout(function () { if (!stopped) action(); }, milliseconds);
        scheduled.push(timer);
        return timer;
    }

    function stopAutomation(message) {
        stopped = true;
        try { sessionStorage.setItem('hys_paused', '1'); } catch (e) {}
        scheduled.forEach(clearTimeout);
        scheduled = [];
        if (activeRequest && typeof activeRequest.abort === 'function') activeRequest.abort();
        setStatus(message || '已停止。点击「继续」恢复；已发送给网站的操作不能撤销。');
    }

    function safePageUrl(value) {
        var target = new URL(String(value).replace(/&amp;/g, '&'), location.href);
        if (target.origin !== location.origin || !/^\/qypx\/bj\/(zkbd|cc|slog|exam)\.jsp$/.test(target.pathname)) {
            throw new Error('拒绝跳转到非当前培训站点的页面');
        }
        if (target.searchParams.has('course_id') && target.searchParams.get('course_id') !== courseId()) {
            throw new Error('跳转地址与当前课程不一致');
        }
        return target.href;
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function log() { var a = [TAG].concat([].slice.call(arguments)); console.log.apply(console, a); }
    function normText(s) { return (s || '').replace(/\s+/g, '').trim(); }

    function getParam(name) {
        return new URLSearchParams(location.search).get(name) || '';
    }

    // ---------- 失败 cware 记录 ----------
    function loadFailed() {
        try { var raw = JSON.parse(localStorage.getItem(FAIL_KEY) || '[]'); return Array.isArray(raw) ? raw : []; }
        catch (e) { return []; }
    }
    function addFailed(cwareId) {
        if (!cwareId) return;
        var f = loadFailed();
        if (f.indexOf(cwareId) === -1) { f.push(cwareId); try { localStorage.setItem(FAIL_KEY, JSON.stringify(f)); } catch (e) {} }
    }
    function clearFailed(cwareId) {
        if (!cwareId) return;
        var f = loadFailed().filter(function (x) { return x !== cwareId; });
        try { localStorage.setItem(FAIL_KEY, JSON.stringify(f)); } catch (e) {}
    }

    // ---------- 顶部状态横幅(全阶段共享) ----------
    var bannerEl = null;
    var bannerText = null;
    var stopButton = null;
    function ensureBanner() {
        if (bannerEl && document.body && bannerEl.parentNode) return bannerEl;
        if (!document.body) return null;
        bannerEl = document.createElement('div');
        bannerEl.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:2147483647;background:#1e3a5f;color:#fff;font:13px/1.6 monospace;padding:6px 12px;box-shadow:0 2px 6px rgba(0,0,0,.4);white-space:pre-wrap;';
        bannerText = document.createElement('span');
        stopButton = document.createElement('button');
        stopButton.style.cssText = 'float:right;margin-left:12px;padding:4px 12px;cursor:pointer;';
        stopButton.onclick = function () {
            if (!stopped) { stopAutomation(); return; }
            try { sessionStorage.removeItem('hys_paused'); } catch (e) {}
            location.reload();
        };
        bannerEl.appendChild(bannerText);
        bannerEl.appendChild(stopButton);
        document.body.appendChild(bannerEl);
        return bannerEl;
    }
    function setStatus(text) {
        var b = ensureBanner();
        if (b) {
            bannerText.textContent = TAG + ' ' + text;
            stopButton.textContent = stopped ? '继续（刷新）' : '停止全自动';
        }
    }

    function courseId() { return getParam('course_id'); }
    function goCourseList() {
        if (stopped) return;
        var cid = courseId();
        if (cid) { log('返回课程列表: zkbd.jsp?course_id=' + cid); location.href = '/qypx/bj/zkbd.jsp?course_id=' + encodeURIComponent(cid); }
        else stopAutomation('未取到 course_id，请手动打开课程列表。');
    }

    // ============================================================
    // 阶段 A：zkbd.jsp 课程列表 —— 找第一个「未学习」课件并进入
    // ============================================================
    function handleCourseList() {
        var table = document.querySelector('table.tables, table.table_checkbox');
        if (!table) { stopAutomation('未找到课程表，请检查登录状态或页面结构。'); return; }

        var rows = table.querySelectorAll('tr');
        var pending = [];        // {cwareId, name, href}
        var passedCount = 0, totalCount = 0;
        var unknownCount = 0;

        for (var i = 0; i < rows.length; i++) {
            var tr = rows[i];
            var tds = tr.querySelectorAll('td');
            if (tds.length < 4) continue;                 // 跳过表头(<th>)行
            totalCount++;
            var nameTd = tds[0];
            var statusTd = tds[tds.length - 1];           // 学习状态列(最后一列)
            var statusText = normText(statusTd.textContent);
            var linkA = statusTd.querySelector('a[href]') || tds[1].querySelector('a[href]');
            if (/已通过|申请学分/.test(statusText)) { passedCount++; continue; }
            if (!linkA || !/未学习|学习中|未通过|未完成|待学习|待考试|未考试/.test(statusText)) { unknownCount++; continue; }
            var href = linkA.getAttribute('href') || '';
            var cm = /cware_id=([^&]+)/i.exec(href);
            var cwareId = cm ? cm[1] : '';
            var name = normText(nameTd.textContent);

            // 状态判定：含「已通过」「申请学分」视为已完成；其余(未学习/学习中)视为待学习
            if (!cwareId) { unknownCount++; continue; }
            pending.push({ cwareId: cwareId, name: name, href: href, status: statusText });
        }

        if (!totalCount || unknownCount) {
            stopAutomation('课件列表为空或存在状态不明的章节，未认定全部完成。');
            return;
        }

        var failed = loadFailed();
        // 过滤掉已标记失败的(防死循环)，除非用户清了 localStorage
        var tryable = pending.filter(function (p) { return failed.indexOf(p.cwareId) === -1; });

        setStatus('课件 ' + passedCount + '/' + totalCount + ' 已通过；待学习 ' + pending.length +
            (failed.length ? '，已跳过失败 ' + failed.length : '') +
            (tryable.length === 0 && pending.length ? '（含失败项）' : ''));

        if (tryable.length === 0) {
            if (pending.length === 0) {
                // 全部已通过
                log('全部课件已完成');
                setStatus('✅ 全部 ' + totalCount + ' 个课件显示已通过；学分、观看时长及其他条件请在网站上核实。');
                // 不再自动跳转，停在列表页
                return;
            }
            stopAutomation('待学习课件均已标记失败，已停止重试。检查问题后可通过油猴菜单清除助手记录。');
            return;
        }

        var target = tryable[0];
        // 记录「正在处理」到 sessionStorage，exam 阶段失败时能定位回这个 cware
        try { sessionStorage.setItem('hys_current_cware', target.cwareId); sessionStorage.setItem('hys_current_course', courseId()); } catch (e) {}
        log('进入课件 #' + target.cwareId + ' ' + target.name + '（状态:' + target.status + '）');
        setStatus('进入课件 ' + target.cwareId + '：' + target.name);
        try {
            var targetUrl = safePageUrl(target.href);
            later(function () { location.href = targetUrl; }, 600);
        } catch (e) { stopAutomation(e.message); }
    }

    // ============================================================
    // 阶段 B：cc.jsp 课件页 —— 提取 slog.jsp URL 直跳(绕过视频/弹题)
    // ============================================================
    function handleCourseware() {
        var MAX_WAIT = 5000, INTERVAL = 200, waited = 0;

        function extractExamURL() {
            // 1) 优先从页面自带 gotoExam 源码提取(URL 由页面构造，参数最准)
            try {
                if (typeof page.gotoExam === 'function') {
                    var src = page.gotoExam.toString();
                    var m = src.match(/slog\.jsp\?[^"'\s)]+/);
                    if (m) return m[0];
                }
            } catch (e) {}
            // 2) 兜底：从整页 HTML 提取
            try {
                var html = document.documentElement.innerHTML || '';
                var m2 = html.match(/slog\.jsp\?[^"'\s<>)]+/);
                if (m2) return m2[0];
            } catch (e) {}
            return null;
        }

        function go() {
            var url = extractExamURL();
            if (url) {
                log('cc.jsp → 跳考试中转页:', url);
                setStatus('课件就绪，跳转考试…');
                try { location.href = safePageUrl(url); } catch (e) { stopAutomation(e.message); }
            } else {
                log('⚠ 未找到 slog.jsp 考试URL，回列表');
                setStatus('⚠ 未找到考试入口，回列表重试');
                addFailed(getParam('cware_id'));
                later(goCourseList, 2000);
            }
        }

        function tick() {
            if (typeof page.gotoExam === 'function' || waited >= MAX_WAIT) { go(); return; }
            waited += INTERVAL;
            later(tick, INTERVAL);
        }
        setStatus('课件页加载中…');
        tick();
    }

    // ============================================================
    // 阶段 C：slog.jsp 中转页 —— 页面自带脚本会自动跳；脚本兜底
    // ============================================================
    function handleSlog() {
        setStatus('考试中转页…');
        // 页面本身有 <script>top.location.href="exam.jsp?..."</script>，正常会自动跳。
        // 兜底：1.5s 后若仍在 slog.jsp，自己提 exam.jsp URL 跳走。
        later(function () {
            try {
                var html = document.documentElement.innerHTML || '';
                var m = html.match(/exam\.jsp\?[^"'\s<>)]+/);
                if (m) { log('slog 兜底跳:', m[0]); location.href = safePageUrl(m[0]); return; }
            } catch (e) { stopAutomation(e.message); return; }
            // 实在没有，用 URL 里的 course_id/paper_id 拼一个
            var cid = getParam('course_id'), pid = getParam('paper_id');
            if (cid && pid) { log('slog 兜底拼 URL'); location.href = 'exam.jsp?course_id=' + encodeURIComponent(cid) + '&paper_id=' + encodeURIComponent(pid); }
            else stopAutomation('中转页没有考试入口，请检查页面提示。');
        }, 1500);
    }

    // ============================================================
    // 阶段 D：exam.jsp 考试页 —— 排除法自动答题(v5 逻辑)
    // ============================================================
    var answers = Object.create(null);
    var questions = [];
    var running = false;
    var DELAY = 600;
    var MAX_ROUNDS = 200;
    var ANSWER_META = ['ques_list', 'ques_num', 'answ_num_list', 'fail_num'];

    function parseQuestions() {
        var qs = [];
        var form = document.forms['form1'] || document.forms[0];
        if (!form) { log('未找到 form1'); return qs; }
        if (form.querySelector('input[name*="captcha" i]:not([type="hidden"]), input[name*="verify" i]:not([type="hidden"]), input[type="password"]')) {
            throw new Error('页面含验证码或登录验证，请手动处理');
        }
        var byId = Object.create(null);
        var ps = form.querySelectorAll('p');
        for (var i = 0; i < ps.length; i++) {
            var inp = ps[i].querySelector('input[name^="ques_"]');
            if (!inp) continue;
            var id = inp.name.substring(5);
            if (!id || !['radio', 'checkbox'].includes(inp.type) || inp.disabled) throw new Error('题目身份、类型或控件状态不明确');
            var val = inp.value;
            var clone = ps[i].cloneNode(true);
            var cInp = clone.querySelector('input');
            if (cInp) cInp.remove();
            var raw = clone.textContent || '';
            var m = raw.match(/^\s*([A-Za-z0-9]{1,2})\s*[：:\.、]\s*([\s\S]*)$/);
            var text = m ? m[2] : raw;
            text = normText(text);
            if (!byId[id]) byId[id] = { id: id, type: inp.type, options: [], text: '' };
            if (byId[id].type !== inp.type) throw new Error('同一道题混用了单选与多选控件');
            var exists = false;
            for (var e = 0; e < byId[id].options.length; e++) {
                if (byId[id].options[e].value === val) { exists = true; break; }
            }
            if (exists) throw new Error('题目包含重复的选项值');
            byId[id].options.push({ value: val, text: text });
            byId[id].type = inp.type;
        }
        var qList = form.querySelector('input[name="ques_list"]');
        var ids = qList ? qList.value.split(',').map(function (id) { return id.trim(); }).filter(Boolean) : Object.keys(byId);
        if (new Set(ids).size !== ids.length || ids.length !== Object.keys(byId).length) throw new Error('题目顺序元数据不完整或包含重复题目');
        for (var k = 0; k < ids.length; k++) {
            var q = byId[ids[k]];
            if (!q) throw new Error('题目顺序元数据与选项不匹配');
            if (!q.options.length || q.options.length > 12 || (q.type === 'checkbox' && q.options.length < 2)
                || q.options.some(function (option) { return !option.text; })
                || new Set(q.options.map(function (option) { return option.text; })).size !== q.options.length) throw new Error('题目选项为空、重复或数量不支持');
            qs.push(q);
        }
        var dts = document.querySelectorAll('dl > dt');
        for (var m2 = 0; m2 < dts.length && m2 < qs.length; m2++) {
            qs[m2].text = normText(dts[m2].textContent);
        }
        return qs;
    }

    function textToValue(q, text) {
        text = normText(text);
        for (var i = 0; i < q.options.length; i++) {
            if (q.options[i].text === text) return q.options[i].value;
        }
        return null;
    }

    function buildCandidates(q) {
        var texts = q.options.map(function (o) { return o.text; });
        if (!texts.length || texts.length > 12) throw new Error('仅支持 1–12 个选项');
        if (q.type === 'checkbox') {
            var subs = [];
            for (var mask = 1; mask < (1 << texts.length); mask++) {
                if ((mask & (mask - 1)) === 0) continue;
                var s = [];
                for (var b = 0; b < texts.length; b++) if (mask & (1 << b)) s.push(texts[b]);
                subs.push(s);
            }
            subs.sort(function (a, b) { return a.length - b.length; });
            return subs;
        }
        return texts.map(function (t) { return [t]; });
    }

    function buildPayload(attempt) {
        var form = document.forms['form1'] || document.forms[0];
        var parts = [];
        var hiddens = form.querySelectorAll('input[type="hidden"]');
        var cwIds = [];
        for (var i = 0; i < hiddens.length; i++) {
            var h = hiddens[i];
            if (h.name === 'cw_id') { cwIds.push(h.value); continue; }
            // 只跳过题目作答字段 ques_<id>(32位题号)，元数据 ques_list/ques_num/answ_num_list/fail_num 照抄
            if (h.name && h.name.indexOf('ques_') === 0 && ANSWER_META.indexOf(h.name) === -1) continue;
            if (h.name) parts.push(encodeURIComponent(h.name) + '=' + encodeURIComponent(h.value));
        }
        for (var c = 0; c < cwIds.length; c++) parts.push('cw_id=' + encodeURIComponent(cwIds[c]));
        for (var qid in attempt) {
            var texts = attempt[qid];
            var q = null;
            for (var qi = 0; qi < questions.length; qi++) if (questions[qi].id === qid) { q = questions[qi]; break; }
            if (!q) throw new Error('提交答案包含未知题目');
            for (var v = 0; v < texts.length; v++) {
                var val = textToValue(q, texts[v]);
                if (val === null) throw new Error('题目选项已变化，不能复用旧答案');
                parts.push(encodeURIComponent('ques_' + qid) + '=' + encodeURIComponent(val));
            }
        }
        return parts.join('&');
    }

    function parseResult(urlText, bodyText, resp) {
        var loc = '';
        if (resp && resp.responseHeaders) {
            var lm = /^Location:\s*(\S+)/im.exec(resp.responseHeaders);
            if (lm) loc = lm[1];
        }
        var target = new URL(loc || urlText, location.href);
        if (target.origin !== location.origin) throw new Error('判分跳转离开了当前培训站点，请检查登录状态');
        if (target.searchParams.has('course_id') && target.searchParams.get('course_id') !== courseId()) throw new Error('判分结果与当前课程不一致');
        var resultPage = /\/examQuiz(?:Pass|Fail)\.jsp$/.test(target.pathname);
        var parameters = target.searchParams;
        var rateText = resultPage ? parameters.get('rightRate') : null;
        if (rateText !== null && (!/^\d+$/.test(rateText) || Number(rateText) > 100)) throw new Error('判分比例格式不正确');
        var rate = rateText === null ? null : Number(rateText);
        var hasErrorIds = resultPage && parameters.has('error_ques');
        var errIds = hasErrorIds ? parameters.get('error_ques').split(',').map(function (id) { return id.trim(); }).filter(Boolean) : [];
        var pass = /\/examQuizPass\.jsp$/.test(target.pathname) && rate === 100;
        var resultDocument = new DOMParser().parseFromString(bodyText || '', 'text/html');
        resultDocument.querySelectorAll('script, style').forEach(function (element) { element.remove(); });
        if (/您?已经通过此课件考试/.test(resultDocument.body.textContent)) pass = true;
        if (pass && errIds.length) throw new Error('通过标记与错题结果矛盾');
        return {
            pass: pass,
            errorIds: errIds,
            hasErrorIds: hasErrorIds,
            rightRate: rate,
            finalUrl: (resp && (resp.finalUrl || resp.url)) || '',
            location: loc,
            status: resp ? (resp.status || 0) : 0
        };
    }

    // fetch(redirect:'follow')：CSP upgrade-insecure-requests 会把 302 的 http Location 升级为 https，成功落地带判分参数
    function submitFetch(attempt) {
        var body = buildPayload(attempt);
        var url = location.href.replace(/exam\.jsp.*$/, 'examDo.jsp');
        var controller = new AbortController();
        activeRequest = controller;
        var timeout = setTimeout(function () { controller.abort(); }, 15000);
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: body,
            credentials: 'include',
            redirect: 'follow',
            signal: controller.signal
        }).then(function (resp) {
            if (!resp.ok) throw new Error('交卷响应异常（HTTP ' + resp.status + '），请核对是否已提交');
            var finalUrl = resp.url || url;
            return resp.text().then(function (txt) {
                return parseResult(finalUrl, txt || '', resp);
            });
        }).finally(function () {
            clearTimeout(timeout);
            activeRequest = null;
        });
    }

    function submitGM(attempt) {
        return new Promise(function (resolve, reject) {
            var body = buildPayload(attempt);
            var url = location.href.replace(/exam\.jsp.*$/, 'examDo.jsp');
            activeRequest = GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                data: body,
                timeout: 15000,
                redirect: 'manual',
                onload: function (resp) {
                    try {
                        if (resp.status < 200 || resp.status >= 400) throw new Error('交卷响应异常，请核对是否已提交');
                        resolve(parseResult(resp.finalUrl || url, resp.responseText || '', resp));
                    } catch (error) { reject(error); }
                },
                onerror: function () { reject(new Error('交卷网络异常，请核对是否已提交')); },
                ontimeout: function () { reject(new Error('交卷请求超时，请核对是否已提交')); },
                onabort: function () { reject(new Error('交卷请求已中止')); }
            });
        }).finally(function () { activeRequest = null; });
    }

    function submit(attempt) {
        if (stopped) return Promise.reject(new Error('助手已停止'));
        return typeof fetch === 'function' ? submitFetch(attempt) : submitGM(attempt);
    }

    function loadKnown() {
        try { var raw = JSON.parse(localStorage.getItem(KNOWN) || '{}'); return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
        catch (e) { return {}; }
    }
    function saveKnown() {
        var out = Object.create(null);
        for (var qid in answers) if (answers[qid] && answers[qid].size) out[qid] = Array.from(answers[qid]);
        try { localStorage.setItem(KNOWN, JSON.stringify(out)); } catch (e) {}
    }

    async function run() {
        if (stopped) return;
        if (running) { log('已在运行中，忽略重复触发'); return; }
        running = true;
        var curCware = '';
        try { if (sessionStorage.getItem('hys_current_course') === courseId()) curCware = sessionStorage.getItem('hys_current_cware') || ''; } catch (e) {}
        try {
            questions = parseQuestions();
            if (!questions.length) {
                stopAutomation('未解析到题目，请检查登录、验证提示或页面结构；不将无题目当成考试通过。');
                return;
            }

            var known = loadKnown();
            questions.forEach(function (q) {
                var cached = known[q.id];
                if (Array.isArray(cached) && new Set(cached).size === cached.length
                    && (q.type === 'checkbox' ? cached.length >= 2 : cached.length === 1)
                    && cached.every(function (text) { return textToValue(q, text) !== null; })) answers[q.id] = new Set(cached);
                else answers[q.id] = new Set();
                q._cand = buildCandidates(q);
                q._cursor = 0;
                q._curTry = null;
            });
            log('解析到 ' + questions.length + ' 道题');
            setStatus('开始答题：' + questions.length + ' 题（排除法求解中…）');

            var round = 0;
            while (!stopped && round < MAX_ROUNDS) {
                round++;
                var attempt = Object.create(null), probing = [];
                for (var i = 0; i < questions.length; i++) {
                    var q = questions[i];
                    if (answers[q.id].size) {
                        attempt[q.id] = Array.from(answers[q.id]);
                    } else {
                        if (q._cursor >= q._cand.length) {
                            var exhausted = new Error('题目选项组合已耗尽，未继续猜题');
                            exhausted.skipCourseware = true;
                            throw exhausted;
                        }
                        q._curTry = q._cand[q._cursor];
                        attempt[q.id] = q._curTry.slice();
                        probing.push(q);
                    }
                }
                var allConfirmed = probing.length === 0;
                var r = await submit(attempt);
                if (stopped) return;
                if (allConfirmed) {
                    log('Round ' + round + ': 终局 -> pass=' + r.pass + ' rightRate=' + r.rightRate + ' errs=' + JSON.stringify(r.errorIds));
                } else {
                    log('Round ' + round + ': 试探 ' + probing.length + '题 -> rightRate=' + r.rightRate + (r.pass ? ' [PASS]' : ''));
                }
                await sleep(DELAY);
                if (stopped) return;

                if (r.pass) {
                    probing.forEach(function (q) {
                        if (!answers[q.id].size && q._curTry) answers[q.id] = new Set(q._curTry);
                    });
                    saveKnown();
                    clearFailed(curCware);
                    log('✅ 全部答对，考试通过');
                    setStatus('✅ 考试通过，返回课程列表…');
                    later(goCourseList, 800);
                    return;
                }

                if (!r.hasErrorIds || !r.errorIds.length || new Set(r.errorIds).size !== r.errorIds.length
                    || r.rightRate === 100 || r.errorIds.some(function (id) { return !questions.some(function (q) { return q.id === id; }); })) {
                    throw new Error('逐题判分缺失或与当前试卷矛盾，已停止；请核对网站上的考试结果');
                }
                questions.forEach(function (q) {
                    if (r.errorIds.indexOf(q.id) === -1) {
                        answers[q.id] = new Set(attempt[q.id]);
                    } else {
                        if (answers[q.id].size) q._cursor = 0;
                        else q._cursor++;
                        answers[q.id] = new Set();
                    }
                });
                saveKnown();
            }
            if (stopped) return;
            log('达到最大轮次上限，标记失败并回列表');
            if (curCware) {
                setStatus('⚠ 本课件达到轮次上限未解出，标记失败，回列表');
                addFailed(curCware);
                later(goCourseList, 2000);
            } else stopAutomation('达到轮次上限，请手动从课程列表检查课件状态。');
        } catch (e) {
            if (stopped) return;
            log('运行异常:', e);
            if (e.skipCourseware && curCware) {
                addFailed(curCware);
                setStatus('⚠ 选项组合已耗尽，标记失败并返回列表');
                later(goCourseList, 2000);
            } else stopAutomation('⚠ ' + (e && e.message) + '；请人工核对后再继续。');
        } finally {
            running = false;
        }
    }

    function handleExam() {
        // 已通过页：直接回列表
        if (/您已经通过此课件考试/.test(document.body ? document.body.textContent : '')) {
            log('本课件已通过，回列表');
            setStatus('本课件已通过，返回列表');
            later(goCourseList, 800);
            return;
        }
        setStatus('脚本就绪，1.2s 后自动开始答题；可点击顶部按钮停止。');
        later(run, 1200);
    }

    // ============================================================
    // 启动：按当前页面分派
    // ============================================================
    function boot() {
        if (window.top !== window.self) return;
        if (stopped) { setStatus('已停止。点击「继续」刷新恢复。'); return; }
        if (!courseId()) { stopAutomation('页面缺少 course_id，请手动打开培训课程列表。'); return; }
        var p = location.pathname.replace(/.*\//, '');
        log('页面:', p, '| course_id=' + courseId());
        try {
            if (p === 'zkbd.jsp') { handleCourseList(); return; }
            if (p === 'cc.jsp') { handleCourseware(); return; }
            if (p === 'slog.jsp') { handleSlog(); return; }
            if (p === 'exam.jsp') { handleExam(); return; }
        } catch (e) { stopAutomation(e.message); return; }
        log('未识别页面，不处理:', p);
    }

    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('全员培训：清除助手记录并暂停', function () {
        if (!confirm('清除当前课程失败记录和全部全员培训答案缓存？网站的学习记录不会被删除。')) return;
        try { localStorage.removeItem(FAIL_KEY); localStorage.removeItem(KNOWN); sessionStorage.removeItem('hys_current_cware'); sessionStorage.removeItem('hys_current_course'); } catch (e) {}
        stopAutomation('已清除助手记录并暂停。点击「继续」刷新恢复。');
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
