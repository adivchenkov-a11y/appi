// ==UserScript==
// @name         FlyAPPI Instructor Helper
// @namespace    flyappi-automation
// @version      1.3.0
// @description  Certify pilot levels on flyappi.org with one tap, from your phone's own logged-in session.
// @match        https://flyappi.org/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/adivchenkov-a11y/appi/main/userscript/flyappi-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/adivchenkov-a11y/appi/main/userscript/flyappi-helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BASE_URL = 'https://flyappi.org';
  const AJAX_HEADERS = { 'X-Requested-With': 'XMLHttpRequest' };
  const RECENT_KEY = 'flyappi_helper_recent';
  const MAX_RECENT = 15;

  // Some documents only exist on one level and are merely inherited (with a
  // delay) as a prerequisite elsewhere - never ask for a file there, mirrors
  // the same rule in the desktop app's pilotSession.js.
  const DOCUMENT_OWNERS = [{ match: /besafe/i, owner: 'appi 3 pilot' }];

  function isInheritedDocument(documentLabel, skillLabel) {
    // Matched by keyword, not exact title: the site has already renamed this
    // document once ("Written BESAFE procedure" -> "written solo pilot BESAFE procedure").
    const rule = DOCUMENT_OWNERS.find((r) => r.match.test(documentLabel));
    return Boolean(rule) && rule.owner !== skillLabel.trim().toLowerCase();
  }

  class FlyappiError extends Error {}

  // ---------------------------------------------------------------------
  // Engine: same endpoints/quirks as the desktop app's flyappiClient.js,
  // ported from Playwright+cheerio to fetch()+DOMParser.
  // ---------------------------------------------------------------------

  async function ajaxGetJson(urlPath) {
    const res = await fetch(`${BASE_URL}${urlPath}`, { headers: AJAX_HEADERS });
    if (!res.ok) throw new FlyappiError(`GET ${urlPath} -> HTTP ${res.status}`);
    return res.json();
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function searchMemberByLicense(licenseNumber) {
    const data = await ajaxGetJson(
      `/ajaxSearchItem/AllMember/${encodeURIComponent(licenseNumber)}/None/?_=${Date.now()}`
    );
    // The site's search is fuzzy and happily returns near-misses, so a typo
    // would otherwise silently open (and certify) a different pilot. Only an
    // exact license-number match is ever accepted.
    const wanted = String(licenseNumber).trim();
    const match = (data.obj_list || []).find((m) => String(m.username).trim() === wanted);
    if (!match) throw new FlyappiError(`Пилот с номером лицензии "${licenseNumber}" не найден`);
    return { memberId: match.id, firstName: match.first_name, lastName: match.last_name };
  }

  function parseTitleInfo(title) {
    if (!title) return { certifiable: null, statutesAvailable: [], message: title || '' };
    const certifiableMatch = title.match(/certifiable:\s*(True|False)/i);
    const statutesMatch = title.match(/statutes available:\s*(\[[^\]]*\])/i);
    const messageMatch = title.match(/message:\s*(.*)$/is);
    let statutesAvailable = [];
    if (statutesMatch) {
      statutesAvailable = statutesMatch[1]
        .replace(/[[\]']/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return {
      certifiable: certifiableMatch ? certifiableMatch[1].toLowerCase() === 'true' : null,
      statutesAvailable,
      message: messageMatch ? messageMatch[1].trim() : title,
    };
  }

  function deriveStatus(message, selectValue) {
    const msg = message || '';
    const explicit = msg.match(/Validation Status\s+(\w+)/i);
    if (explicit) return explicit[1];
    if (/Rating\s+(already\s+)?validated/i.test(msg)) return 'validated';
    if (/Rating does not exist/i.test(msg)) return null;
    return selectValue && selectValue !== 'None' ? selectValue : null;
  }

  function extractSlug(el) {
    const slugClass = [...el.classList].find((c) => /^skill_[a-z]/i.test(c));
    return slugClass ? slugClass.replace(/^skill_/, '') : null;
  }

  function parseExam(el) {
    const block = el.querySelector('.exam_levels_required');
    if (!block) return null;
    const stateHost = [...block.querySelectorAll('[title*="exam_levels"]')][0];
    const stateAttr = stateHost ? stateHost.getAttribute('title') || '' : '';
    const status = (stateAttr.match(/'status':\s*'([^']+)'/) || [])[1] || null;
    if (!status) return null;

    const sendBtn = [...block.querySelectorAll('[onclick*="ajaxSendMissingExam"]')][0] || null;
    const examName =
      (sendBtn?.getAttribute('onclick') || '').match(/ajaxSendMissingExam\(\s*'([^']+)'/)?.[1] ||
      (stateAttr.match(/'name':\s*'([^']+)'/) || [])[1] ||
      null;

    return {
      examName,
      status,
      isPassed: status === 'passed',
      needsSending: Boolean(sendBtn) || status === 'to_give',
    };
  }

  async function getCertifyPanel(memberId) {
    const data = await ajaxGetJson(`/ajaxCertifyAMember/${memberId}/0/?_=${Date.now()}`);
    const doc = parseHtml(data.html);
    const bySkillId = new Map();

    doc.querySelectorAll('[data-skill_id]').forEach((el) => {
      const skillId = el.getAttribute('data-skill_id');
      const heading = el.querySelector(':scope > div strong, :scope > strong');
      const label = heading ? heading.textContent.trim() : null;
      if (!label || bySkillId.has(skillId)) return;

      const select = el.querySelector('select.validation_status');
      const titleHost = [...el.querySelectorAll('[title*="certifiable"]')][0];
      const title = titleHost ? titleHost.getAttribute('title') : null;
      const uploadBtn = [...el.querySelectorAll('button')].find((b) =>
        /get skill form|upload/i.test(b.getAttribute('title') || b.textContent || '')
      );
      const sendExamBtn = [...el.querySelectorAll('button')].find((b) =>
        /send the exam/i.test(b.textContent || '')
      );
      const workshopBtn = el.querySelector('button[title="get workshop practical exam tool"]');

      const info = parseTitleInfo(title);
      bySkillId.set(skillId, {
        skillId,
        label,
        slug: extractSlug(el),
        mySkillId: el.getAttribute('data-my_skill_id') || '0',
        currentStatus: deriveStatus(info.message, select ? select.value : null),
        ...info,
        hasDocumentUpload: Boolean(uploadBtn),
        needsExam: Boolean(sendExamBtn),
        exam: parseExam(el),
        hasWorkshopTool: Boolean(workshopBtn),
      });
    });

    return { skills: [...bySkillId.values()] };
  }

  function findSkill(panel, skillName) {
    const needle = skillName.trim().toLowerCase();
    return (
      panel.skills.find((s) => s.label.trim().toLowerCase() === needle) ||
      panel.skills.find((s) => s.label.trim().toLowerCase().includes(needle))
    );
  }

  async function getWorkshopExam(memberId, skillId) {
    const data = await ajaxGetJson(`/ajaxWorkshopExam/${memberId}/0/${skillId}/?_=${Date.now()}`);
    const doc = parseHtml(data.html);
    const byItemId = new Map();

    doc.querySelectorAll('div.skill').forEach((el) => {
      const idClass = [...el.classList].find((c) => /^skill_\d+$/.test(c));
      if (!idClass) return;
      const itemId = idClass.replace('skill_', '');
      if (byItemId.has(itemId)) return;

      const titleHost = [...el.querySelectorAll('[title*="certifiable"]')][0];
      const title = titleHost ? titleHost.getAttribute('title') : null;

      let label = titleHost?.querySelector('strong, b')?.textContent.trim() || titleHost?.textContent.trim();
      if (!label) label = el.querySelector('strong, b')?.textContent.trim() || `пункт ${itemId}`;

      const validateBtn = [...el.querySelectorAll('[onclick*="ajaxSaveItemFast"]')][0];
      const commentBtn = el.querySelector('[onclick*="addComment("]');
      const mySkillId =
        (validateBtn?.getAttribute('onclick') || '').match(/ajaxSaveItemFast\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)/)?.[1] ||
        (commentBtn?.getAttribute('onclick') || '').match(/addComment\('MySkill',\s*(\d+)/)?.[1] ||
        '0';

      const blockText = el.textContent;
      const needsDocument =
        /Document\s+Mandatory/i.test(blockText) || el.querySelector('[onclick*="dashboard/procedures"]') !== null;

      const info = parseTitleInfo(title);
      const validationStatus = el.querySelector('[data-validation-status]')?.getAttribute('data-validation-status') || '';

      byItemId.set(itemId, {
        itemId,
        label: label.replace(/\s+/g, ' ').trim(),
        mySkillId,
        currentStatus: deriveStatus(info.message, validationStatus),
        canThumbUp: Boolean(validateBtn),
        needsDocument,
        ...info,
      });
    });

    return { items: [...byItemId.values()] };
  }

  async function validateItem(memberId, itemId, targetStatus, mySkillId) {
    const data = await ajaxGetJson(
      `/ajaxSaveItemFast/${memberId}/${itemId}/${mySkillId || '0'}/0/${targetStatus}/none/`
    );
    if (!data?.infos?.success) throw new FlyappiError(`ajaxSaveItemFast failed for item ${itemId}`);
    return data;
  }

  async function sendExam(examName, memberId) {
    const data = await ajaxGetJson(
      `/ajaxSendMissingExam/${encodeURIComponent(examName)}/${memberId}/0/?_=${Date.now()}`
    );
    if (!data?.infos?.success) throw new FlyappiError(`не удалось отправить экзамен "${examName}"`);
    return data;
  }

  function getCookie(name) {
    return document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1] || null;
  }

  async function setSkillStatus(memberId, skillId, targetStatus, report, mySkillId) {
    const csrfToken = getCookie('csrftoken');
    const myScill = JSON.stringify({
      my_skill_id: mySkillId || '0',
      skill_id: skillId,
      validation_status: targetStatus,
      value: '',
      report: report || '',
    });
    const form = new FormData();
    form.append('my_skills', myScill);
    const res = await fetch(`${BASE_URL}/ajaxQuickSaveMySkills/${memberId}/unique/0/`, {
      method: 'POST',
      headers: { ...AJAX_HEADERS, ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}) },
      body: form,
    });
    if (!res.ok) throw new FlyappiError(`ajaxQuickSaveMySkills -> HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.infos?.success) throw new FlyappiError(`ajaxQuickSaveMySkills failed for skill ${skillId}`);
    return data;
  }

  function statusOptionValues(doc) {
    const map = {};
    doc.querySelectorAll('select[name="validation_status"] option').forEach((opt) => {
      const label = opt.textContent.trim().toLowerCase().replace(/\s+/g, '_');
      if (label) map[label] = opt.getAttribute('value');
    });
    return map;
  }

  // Django rejects the submission (500, no useful message) if fields the
  // template declares are simply missing from the POST - e.g. the in-workshop
  // document form has a "workshop" select we never touch but must still send.
  function formDefaults(doc) {
    const defaults = {};
    doc.querySelectorAll('input[name], textarea[name], select[name]').forEach((el) => {
      const name = el.getAttribute('name');
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'file' || type === 'checkbox' || type === 'radio') return;
      if (el.tagName === 'SELECT') {
        defaults[name] =
          el.querySelector('option[selected]')?.getAttribute('value') ??
          el.querySelector('option')?.getAttribute('value') ??
          '';
      } else if (el.tagName === 'TEXTAREA') {
        defaults[name] = el.textContent;
      } else {
        defaults[name] = el.getAttribute('value') || '';
      }
    });
    return defaults;
  }

  async function getSkillForm(memberId, skillId, mySkillId) {
    const data = await ajaxGetJson(
      `/ajaxGetMySkillForm/${memberId}/0/${skillId}/${mySkillId || '0'}/?_=${Date.now()}`
    );
    const doc = parseHtml(data.html);
    const formId = doc.querySelector('form#form_my_skill')?.getAttribute('data_my_skill_id');
    if (!formId) throw new FlyappiError('Не нашёл data_my_skill_id в форме документа');
    return { formId, statusValues: statusOptionValues(doc), defaults: formDefaults(doc) };
  }

  async function releaseSkillLock(myScillFormId) {
    await ajaxGetJson(`/ajaxSimpleUpdate/MySkill/${myScillFormId}/locked/False/?_=${Date.now()}`).catch(() => {});
  }

  async function uploadDocument({ memberId, skillId, targetStatus, report, file, mySkillId }) {
    const { formId, statusValues, defaults } = await getSkillForm(memberId, skillId, mySkillId);
    const statusValue = statusValues[targetStatus] ?? targetStatus;
    try {
      const csrfToken = defaults.csrfmiddlewaretoken || getCookie('csrftoken');
      const form = new FormData();
      Object.entries(defaults).forEach(([key, value]) => form.set(key, value));
      if (csrfToken) form.set('csrfmiddlewaretoken', csrfToken);
      form.set('validation_status', statusValue);
      form.set('report', report || defaults.report || '');
      if (file) form.set('document_required', file, file.name);

      const res = await fetch(`${BASE_URL}/ajaxSaveMySkillForm/${formId}/`, {
        method: 'POST',
        headers: AJAX_HEADERS,
        body: form,
      });
      if (!res.ok) throw new FlyappiError(`ajaxSaveMySkillForm -> HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.infos?.success || /error/i.test(data?.infos?.message || '')) {
        throw new FlyappiError(`ajaxSaveMySkillForm failed for skill ${skillId}: ${data?.infos?.message}`);
      }
      return data;
    } catch (err) {
      await releaseSkillLock(formId);
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Orchestration: identical shape to pilotSession.js on the desktop app.
  // ---------------------------------------------------------------------

  async function findPilot(licenseNumber) {
    const member = await searchMemberByLicense(licenseNumber);
    recordRecentLicense({ licenseNumber, firstName: member.firstName, lastName: member.lastName });
    const panel = await getCertifyPanel(member.memberId);

    const pending = panel.skills.filter((s) => s.currentStatus !== 'validated' && s.hasWorkshopTool);
    const checklists = await Promise.all(
      pending.map((s) =>
        getWorkshopExam(member.memberId, s.skillId)
          .then((ws) => [s.skillId, ws.items])
          .catch(() => [s.skillId, []])
      )
    );
    const itemsBySkillId = new Map(checklists);

    const skills = panel.skills.map((s) => {
      const items = itemsBySkillId.get(s.skillId) || [];
      const documents = items
        .filter((i) => i.needsDocument && !isInheritedDocument(i.label, s.label))
        .map((i) => ({ label: i.label, done: i.currentStatus === 'validated' }));
      if (s.hasDocumentUpload && !documents.length) {
        documents.push({ label: s.label, done: s.currentStatus === 'validated' });
      }
      return {
        label: s.label,
        skillId: s.skillId,
        currentStatus: s.currentStatus,
        statutesAvailable: s.statutesAvailable,
        message: s.message,
        hasWorkshopTool: s.hasWorkshopTool,
        hasDocumentUpload: s.hasDocumentUpload,
        documents,
        needsFile: documents.some((d) => !d.done),
        exam: s.exam,
      };
    });

    return { member, licenseNumber, skills };
  }

  async function certifyLevel(memberId, selection, status, log) {
    const { skillLabel, file, report } = selection;
    const steps = [];
    let waitingForExam = false;

    const startPanel = await getCertifyPanel(memberId);
    const startSkill = findSkill(startPanel, skillLabel);
    if (!startSkill) throw new Error(`уровень "${skillLabel}" не виден в панели этого пилота`);
    const skillId = startSkill.skillId;

    if (startSkill.exam && !startSkill.exam.isPassed) {
      if (startSkill.exam.needsSending) {
        await sendExam(startSkill.exam.examName, memberId);
        log(`  📨 экзамен "${startSkill.exam.examName}" отправлен ученику`);
        steps.push('экзамен отправлен, ждём сдачи учеником');
      } else {
        steps.push('экзамен уже отправлен, ждём сдачи учеником');
      }
      waitingForExam = true;
    }

    if (selection.hasWorkshopTool) {
      const workshop = await getWorkshopExam(memberId, skillId);
      let done = 0;
      let already = 0;
      let skipped = 0;
      const missingDocs = [];

      for (const item of workshop.items) {
        if (item.currentStatus === status) {
          already += 1;
          continue;
        }
        if (item.needsDocument) {
          if (isInheritedDocument(item.label, skillLabel)) {
            skipped += 1;
            continue;
          }
          if (!file) {
            missingDocs.push(item.label);
            continue;
          }
          await uploadDocument({ memberId, skillId: item.itemId, targetStatus: status, report, file, mySkillId: item.mySkillId });
          done += 1;
          log(`  📎 ${item.label} — документ загружен`);
          continue;
        }
        if (!item.canThumbUp || (item.statutesAvailable.length && !item.statutesAvailable.includes(status))) {
          skipped += 1;
          continue;
        }
        await validateItem(memberId, item.itemId, status, item.mySkillId);
        done += 1;
        log(`  ✓ ${item.label}`);
      }

      if (missingDocs.length) throw new Error(`нужен файл документа для: ${missingDocs.join(', ')} — выберите его и повторите`);
      steps.push(`пунктов: ${done}${already ? `, уже было ${already}` : ''}${skipped ? `, пропущено ${skipped}` : ''}`);
    }

    if (selection.hasDocumentUpload) {
      if (!file) throw new Error('для этого уровня нужен файл документа — выберите его');
      await uploadDocument({ memberId, skillId, targetStatus: status, report, file, mySkillId: startSkill.mySkillId });
      steps.push('документ загружен');
    }

    if (waitingForExam) return steps.join('; ');

    const panel = await getCertifyPanel(memberId);
    const live = findSkill(panel, skillLabel);
    if (!live) throw new Error('уровень не виден в панели этого пилота');

    if (live.currentStatus === status) {
      steps.push(`уровень уже ${status}`);
    } else if (live.statutesAvailable.length && !live.statutesAvailable.includes(status)) {
      throw new Error(`сайт не даёт поставить "${status}" (доступно: ${live.statutesAvailable.join(', ') || 'ничего'}). ${live.message}`);
    } else {
      await setSkillStatus(memberId, skillId, status, report, live.mySkillId);
      const after = await getCertifyPanel(memberId);
      const confirmed = findSkill(after, skillLabel);
      if (confirmed?.currentStatus !== status) {
        throw new Error(`статус не применился (сейчас: ${confirmed?.currentStatus || 'не начато'}). ${confirmed?.message || ''}`);
      }
      steps.push(`уровень → ${status}`);
    }

    return steps.join('; ');
  }

  async function tryCertify(memberId, selection, status, log) {
    log(`${selection.skillLabel}: начинаю...`);
    try {
      const summary = await certifyLevel(memberId, selection, status, log);
      log(`${selection.skillLabel}: ${summary}`, 'ok');
      return { skillLabel: selection.skillLabel, ok: true, message: summary };
    } catch (err) {
      log(`${selection.skillLabel}: ${err.message}`, 'error');
      return { skillLabel: selection.skillLabel, ok: false, message: err.message };
    }
  }

  async function applySelections(licenseNumber, selections, log) {
    const member = await searchMemberByLicense(licenseNumber);
    const bySkillLabel = new Map();

    for (const selection of selections) {
      const status = selection.targetStatus || 'validated';
      bySkillLabel.set(selection.skillLabel, await tryCertify(member.memberId, selection, status, log));
    }

    const failed = selections.filter((s) => !bySkillLabel.get(s.skillLabel)?.ok);
    if (failed.length && failed.length < selections.length) {
      log('Повторяю уровни, которые могли зависеть от других из этого же запуска...');
      for (const selection of failed) {
        const status = selection.targetStatus || 'validated';
        bySkillLabel.set(selection.skillLabel, await tryCertify(member.memberId, selection, status, log));
      }
    }

    return selections.map((s) => bySkillLabel.get(s.skillLabel));
  }

  // ---------------------------------------------------------------------
  // Local history (per-device, no sync with the Mac app - by design).
  // ---------------------------------------------------------------------

  function getRecentLicenses() {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function recordRecentLicense({ licenseNumber, firstName, lastName }) {
    const rest = getRecentLicenses().filter((e) => e.licenseNumber !== licenseNumber);
    const next = [{ licenseNumber, firstName, lastName }, ...rest].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  }

  // ---------------------------------------------------------------------
  // UI: a floating panel overlaid on the real site.
  // ---------------------------------------------------------------------

  const STYLE = `
    #fh-toggle {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      width: 52px; height: 52px; border-radius: 50%; border: none;
      background: #2563eb; color: white; font-size: 22px; box-shadow: 0 2px 10px rgba(0,0,0,.3);
    }
    #fh-panel {
      position: fixed; inset: auto 10px 84px 10px; max-width: 480px; margin: 0 auto;
      max-height: 78vh; overflow-y: auto; z-index: 999999;
      background: #fff; color: #111; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.35);
      padding: 14px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px;
      display: none;
    }
    #fh-panel.open { display: block; }
    #fh-panel h2 { font-size: 14px; margin: 12px 0 6px; }
    #fh-panel .fh-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    #fh-panel input[type="text"] { padding: 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 16px; flex: 1; min-width: 100px; }
    #fh-panel button { padding: 8px 12px; border-radius: 6px; border: 1px solid #ccc; background: #f2f2f2; font-size: 14px; }
    #fh-panel button.fh-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    #fh-panel .fh-hint { font-size: 12px; opacity: .7; }
    #fh-panel .fh-skill-row { padding: 8px 0; border-bottom: 1px solid #eee; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    #fh-panel .fh-skill-row > label { flex: 1 1 100%; }
    #fh-panel .fh-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid #ccc; white-space: nowrap; }
    #fh-panel .fh-badge.ok { color: #16a34a; border-color: #16a34a; }
    #fh-panel .fh-badge.warn { color: #d97706; border-color: #d97706; }
    #fh-panel .fh-badge.bad { color: #dc2626; border-color: #dc2626; }
    #fh-panel .fh-chip { padding: 4px 10px; border-radius: 12px; border: 1px solid #ccc; background: #f2f2f2; font-size: 12px; }
    #fh-log { height: 160px; overflow-y: auto; background: #f5f5f5; border-radius: 6px; padding: 8px; font-size: 11px; white-space: pre-wrap; }
    #fh-log .err { color: #dc2626; } #fh-log .ok { color: #16a34a; }
  `;

  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const toggle = h('button', { id: 'fh-toggle', title: 'FlyAPPI Helper' }, '🪂');
    const panel = h('div', { id: 'fh-panel' });
    toggle.addEventListener('click', () => panel.classList.toggle('open'));

    const licenseInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Номер лицензии' });
    const findBtn = h('button', { class: 'fh-primary' }, 'Найти');
    const pilotStatus = h('span', { class: 'fh-hint' });
    const pilotName = h('div', { class: 'fh-hint' });
    const recentBox = h('div', { class: 'fh-row' });
    const skillsSection = h('div');
    const logBox = h('div', { id: 'fh-log' });

    function log(message, level = 'info') {
      const line = document.createElement('div');
      line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
      if (level === 'error') line.className = 'err';
      if (level === 'ok') line.className = 'ok';
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function renderRecent() {
      recentBox.innerHTML = '';
      getRecentLicenses().forEach((entry) => {
        const chip = h(
          'button',
          {
            class: 'fh-chip',
            onclick: () => {
              licenseInput.value = entry.licenseNumber;
              loadPilot(entry.licenseNumber);
            },
          },
          `${entry.licenseNumber} — ${entry.firstName} ${entry.lastName}`
        );
        recentBox.appendChild(chip);
      });
    }

    let currentPilot = null;
    const skillFiles = {};

    async function loadPilot(licenseNumber) {
      pilotStatus.textContent = 'ищу...';
      skillsSection.innerHTML = '';
      try {
        currentPilot = await findPilot(licenseNumber);
        pilotStatus.textContent = '';
        pilotName.textContent = `${currentPilot.member.firstName} ${currentPilot.member.lastName}`;
        renderSkills();
        renderRecent();
      } catch (err) {
        pilotStatus.textContent = `ошибка: ${err.message}`;
      }
    }

    function renderSkills() {
      skillsSection.innerHTML = '';
      const statusRow = h('div', { class: 'fh-row' }, [
        h('span', {}, 'Статус:'),
        (() => {
          const r = h('input', { type: 'radio', name: 'fh-status', value: 'validated', checked: 'checked' });
          r.id = 'fh-status-validated';
          return h('label', {}, [r, ' validated']);
        })(),
        (() => {
          const r = h('input', { type: 'radio', name: 'fh-status', value: 'in_progress' });
          r.id = 'fh-status-progress';
          return h('label', {}, [r, ' in_progress']);
        })(),
      ]);
      skillsSection.appendChild(statusRow);

      const list = h('div');
      currentPilot.skills.forEach((skill) => {
        const isValidated = skill.currentStatus === 'validated';
        const row = h('div', { class: 'fh-skill-row' });

        const checkbox = h('input', { type: 'checkbox' });
        checkbox.disabled = isValidated;
        const label = h(
          'label',
          {},
          [checkbox, ` ${skill.label} — ${isValidated ? '✅ выдан' : skill.currentStatus || 'не начато'}`]
        );
        row.appendChild(label);

        if (skill.exam) {
          const cls = skill.exam.isPassed ? 'ok' : skill.exam.needsSending ? 'bad' : 'warn';
          const text = skill.exam.isPassed ? '🎓 сдан' : skill.exam.needsSending ? '📨 не отправлен' : '⏳ ждём сдачи';
          row.appendChild(h('span', { class: `fh-badge ${cls}` }, text));
        }

        (skill.documents || []).forEach((doc) => {
          if (doc.done) row.appendChild(h('span', { class: 'fh-badge ok' }, `📄 загружен`));
        });

        let fileInput = null;
        if (skill.needsFile && !isValidated) {
          fileInput = h('input', { type: 'file' });
          fileInput.style.display = 'block';
          fileInput.style.marginTop = '4px';
          fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) skillFiles[skill.label] = fileInput.files[0];
          });
          row.appendChild(fileInput);
        }

        row.dataset.label = skill.label;
        row.dataset.meta = JSON.stringify({
          hasWorkshopTool: skill.hasWorkshopTool,
          hasDocumentUpload: skill.hasDocumentUpload,
        });
        row._checkbox = checkbox;
        list.appendChild(row);
      });
      skillsSection.appendChild(list);

      const applyRow = h('div', { class: 'fh-row' });
      const applyStatus = h('span', { class: 'fh-hint' });
      const applyBtn = h('button', { class: 'fh-primary' }, 'Применить выбранное');
      applyBtn.addEventListener('click', async () => {
        const status = skillsSection.querySelector('input[name="fh-status"]:checked').value;
        const rows = [...list.children];
        const selections = [];
        for (const row of rows) {
          if (!row._checkbox.checked) continue;
          const meta = JSON.parse(row.dataset.meta);
          selections.push({
            skillLabel: row.dataset.label,
            targetStatus: status,
            hasWorkshopTool: meta.hasWorkshopTool,
            hasDocumentUpload: meta.hasDocumentUpload,
            file: skillFiles[row.dataset.label] || null,
          });
        }
        if (!selections.length) {
          applyStatus.textContent = 'ничего не выбрано';
          return;
        }
        applyStatus.textContent = 'выполняю...';
        await applySelections(currentPilot.licenseNumber, selections, log);
        applyStatus.textContent = 'готово, обновляю...';
        await loadPilot(currentPilot.licenseNumber);
        applyStatus.textContent = 'готово';
      });
      applyRow.appendChild(applyBtn);
      applyRow.appendChild(applyStatus);
      skillsSection.appendChild(applyRow);
    }

    findBtn.addEventListener('click', () => {
      const v = licenseInput.value.trim();
      if (v) loadPilot(v);
    });
    licenseInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') findBtn.click();
    });

    panel.appendChild(h('h2', {}, 'FlyAPPI Helper'));
    panel.appendChild(h('div', { class: 'fh-row' }, [licenseInput, findBtn, pilotStatus]));
    panel.appendChild(pilotName);
    panel.appendChild(recentBox);
    panel.appendChild(skillsSection);
    panel.appendChild(h('h2', {}, 'Лог'));
    panel.appendChild(logBox);

    document.body.appendChild(toggle);
    document.body.appendChild(panel);
    renderRecent();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
