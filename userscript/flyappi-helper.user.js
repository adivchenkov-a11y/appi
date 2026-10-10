// ==UserScript==
// @name         FlyAPPI Instructor Helper
// @namespace    flyappi-automation
// @version      2.0.0
// @description  Issue APPI pilot levels on flyappi.org for one or many pilots at once, from your own logged-in session.
// @match        https://flyappi.org/*
// @match        https://www.flyappi.org/*
// @noframes
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/adivchenkov-a11y/appi/main/userscript/flyappi-helper.meta.js
// @downloadURL  https://raw.githubusercontent.com/adivchenkov-a11y/appi/main/userscript/flyappi-helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '2.0.0'; // keep equal to @version (checked by scripts/pack-userscript.js)
  const BASE_URL = location.origin;
  const AJAX_HEADERS = { 'X-Requested-With': 'XMLHttpRequest' };
  const GET_TIMEOUT_MS = 60000;
  const POST_TIMEOUT_MS = 180000; // uploads from a phone on a slow network
  const RETRY_WAIT_MS = 20000;

  const RECENT_KEY = 'flyappi_helper_recent';
  const MEMBERS_KEY = 'flyappi_helper_members';
  const OPEN_KEY = 'flyappi_helper_open';
  const INPUT_KEY = 'flyappi_helper_input';
  const MAX_RECENT = 15;
  const MAX_CACHED_MEMBERS = 300;

  const MAX_PILOTS = 20;
  // Pilots loaded / issued at the same time. Each one is itself a sequence of
  // requests, so 3 is several times faster without hammering the site.
  const LOAD_CONCURRENCY = 3;
  const RUN_CONCURRENCY = 3;

  // ---------------------------------------------------------------------------
  // Rules - same as the desktop app's pilotSession.js.
  // ---------------------------------------------------------------------------

  // Levels the instructor never issues through this tool.
  const HIDDEN_SKILL_SLUGS = new Set(['first_aid']);

  // Some documents physically exist on one level only; higher levels merely copy
  // their status as a prerequisite (sometimes with a delay). The file is uploaded
  // on the owning level only - elsewhere it must neither be asked for nor block.
  const DOCUMENT_OWNERS = [{ match: /besafe/i, owner: 'appi 3 pilot' }];

  function isInheritedDocument(documentLabel, skillLabel) {
    // Matched by keyword, not exact title: the site has already renamed this
    // document once ("Written BESAFE procedure" -> "written solo pilot BESAFE procedure").
    const rule = DOCUMENT_OWNERS.find((r) => r.match.test(documentLabel));
    return Boolean(rule) && rule.owner !== skillLabel.trim().toLowerCase();
  }

  // Independent paths; inside one, a level is only issued after the one before it.
  // The site reveals levels one at a time and later hides the lower ones already
  // passed, so the order has to be known here.
  const CHAINS = {
    main: ['appi_1_discover', 'appi_2_explore', 'appi_3_pilot', 'appi_4_progress'],
    siv: ['siv', 'advanced_siv'],
  };
  const chainOf = (slug) => Object.keys(CHAINS).find((id) => CHAINS[id].includes(slug)) || null;
  const CHAIN_NAMES = {
    appi_1_discover: 'APPI 1 Discover',
    appi_2_explore: 'APPI 2 Explore',
    appi_3_pilot: 'APPI 3 Pilot',
    appi_4_progress: 'APPI 4 Progress',
    siv: 'SIV',
    advanced_siv: 'Advanced SIV',
    dynamic_soaring: 'Dynamic soaring',
  };
  // APPI 3 needs ONE of these ratings; the first is what gets issued by default.
  const APPI3_RATINGS = ['dynamic_soaring', 'thermalling'];
  const MAX_STEPS = 6;

  class FlyappiError extends Error {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Site access. The browser already sends the session cookie, Referer and
  // Origin; only the ajax marker and the CSRF token have to be added.
  // ---------------------------------------------------------------------------

  const endpointName = (urlPath) => urlPath.split('/')[1] || urlPath;

  async function request(urlPath, { method = 'GET', body, headers = {}, timeout = GET_TIMEOUT_MS, read = 'json' } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const what = endpointName(urlPath);
    try {
      const res = await fetch(BASE_URL + urlPath, {
        method,
        body,
        headers: { ...AJAX_HEADERS, ...headers },
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      if (read === 'response') return res;
      const isJson = /json/.test(res.headers.get('content-type') || '');
      if (!res.ok || !isJson) {
        // Logged out, the site answers its ajax endpoints with an HTML error page.
        const hint = isJson ? '' : ' - are you still logged in on flyappi.org?';
        throw new FlyappiError(`${what} -> HTTP ${res.status}${hint}`);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof FlyappiError) throw err;
      if (err.name === 'AbortError') throw new FlyappiError(`${what}: the site did not answer in ${timeout / 1000} s`);
      throw new FlyappiError(`${what}: network error (${err.message})`);
    } finally {
      clearTimeout(timer);
    }
  }

  const ajaxGetJson = (urlPath) => request(urlPath);

  /** True for a refusal that may pass later: gateway errors, or nginx itself saying 403. */
  async function isTemporaryRefusal(res) {
    if ([502, 503, 504].includes(res.status)) return true;
    return res.status === 403 && (await res.clone().text()).includes('<center>nginx');
  }

  /**
   * POSTs are the writes that count. When the site's front (nginx) refuses one,
   * wait and try once more instead of failing the whole run. A 403 from the
   * application itself (e.g. a CSRF failure) is not temporary and is not retried.
   */
  async function postJson(urlPath, form, headers) {
    const send = () => request(urlPath, { method: 'POST', body: form, headers, timeout: POST_TIMEOUT_MS, read: 'response' });
    let res = await send();
    if (await isTemporaryRefusal(res)) {
      await sleep(RETRY_WAIT_MS);
      res = await send();
    }
    if (!res.ok) throw new FlyappiError(`${endpointName(urlPath)} -> HTTP ${res.status}`);
    return res.json();
  }

  function readCsrfToken() {
    return (
      document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/)?.[1] ||
      document.querySelector('input[name="csrfmiddlewaretoken"]')?.value ||
      null
    );
  }

  /** Django sets the CSRF cookie when a page renders; fetch the cheapest one if it is missing. */
  async function getCsrfToken() {
    let token = readCsrfToken();
    if (!token) {
      await fetch(`${BASE_URL}/home/`, { credentials: 'same-origin' }).catch(() => {});
      token = readCsrfToken();
    }
    return token;
  }

  /**
   * The home page streams a background video over the same connection as our
   * requests, and while it downloads they can stall for a minute or more
   * (measured: 3 of 4 loads timed out on /home/, none once it was stopped).
   * Removing the source is what actually stops the download - pause() alone does not.
   */
  function stopPageVideos() {
    document.querySelectorAll('video').forEach((video) => {
      if (!video.currentSrc && !video.src) return;
      video.pause();
      video.removeAttribute('src');
      video.querySelectorAll('source').forEach((s) => s.remove());
      video.load();
    });
  }

  const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

  // ---------------------------------------------------------------------------
  // Site endpoints - same as the desktop app's flyappiClient.js.
  // ---------------------------------------------------------------------------

  async function searchMemberByLicense(licenseNumber) {
    const data = await ajaxGetJson(`/ajaxSearchItem/AllMember/${encodeURIComponent(licenseNumber)}/None/?_=${Date.now()}`);
    // The site's search is fuzzy and happily returns near-misses, so a typo would
    // otherwise silently open (and certify) a different pilot. Only an exact
    // license-number match is ever accepted.
    const wanted = String(licenseNumber).trim();
    const match = (data.obj_list || []).find((m) => String(m.username).trim() === wanted);
    if (!match) throw new FlyappiError(`No pilot with license number "${licenseNumber}"`);
    return { memberId: match.id, firstName: match.first_name, lastName: match.last_name };
  }

  function parseTitleInfo(title) {
    if (!title) return { certifiable: null, statutesAvailable: [], message: title || '' };
    const certifiableMatch = title.match(/certifiable:\s*(True|False)/i);
    const statutesMatch = title.match(/statutes available:\s*(\[[^\]]*\])/i);
    const messageMatch = title.match(/message:\s*(.*)$/is);
    const statutesAvailable = statutesMatch
      ? statutesMatch[1].replace(/[[\]']/g, '').split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    return {
      certifiable: certifiableMatch ? certifiableMatch[1].toLowerCase() === 'true' : null,
      statutesAvailable,
      message: messageMatch ? messageMatch[1].trim() : title,
    };
  }

  /**
   * The site only renders a status <select> for ratings that can still be changed,
   * so an already-validated level has no select at all. The real status is stated
   * in the server-rendered title text.
   */
  function deriveStatus(message, selectValue) {
    const msg = message || '';
    const explicit = msg.match(/Validation Status\s+(\w+)/i);
    if (explicit) return explicit[1];
    if (/Rating\s+(already\s+)?validated/i.test(msg)) return 'validated';
    if (/Rating does not exist/i.test(msg)) return null;
    return selectValue && selectValue !== 'None' ? selectValue : null;
  }

  function extractSlug(node) {
    const slugClass = [...node.classList].find((c) => /^skill_[a-z]/i.test(c));
    return slugClass ? slugClass.replace(/^skill_/, '') : null;
  }

  /**
   * Levels that need an online exam expose its state as a python-dict string, e.g.
   * {'is_complete': False, 'exam_levels': [{'name': 'APPI 3 Pilot', 'status': 'to_give'}]}
   * plus a "give exam" button carrying the exact exam name to send.
   */
  function parseExam(node) {
    const block = node.querySelector('.exam_levels_required');
    if (!block) return null;
    const stateAttr = block.querySelector('[title*="exam_levels"]')?.getAttribute('title') || '';
    const status = (stateAttr.match(/'status':\s*'([^']+)'/) || [])[1] || null;
    if (!status) return null;
    const sendBtn = block.querySelector('[onclick*="ajaxSendMissingExam"]');
    const examName =
      (sendBtn?.getAttribute('onclick') || '').match(/ajaxSendMissingExam\(\s*'([^']+)'/)?.[1] ||
      (stateAttr.match(/'name':\s*'([^']+)'/) || [])[1] ||
      null;
    return {
      examName,
      status, // 'to_give' | 'passed' | anything else == sent, awaiting the student
      isPassed: status === 'passed',
      needsSending: Boolean(sendBtn) || status === 'to_give',
    };
  }

  /** The pilot's levels. The site renders this server-side in ~4 s - read it as rarely as possible. */
  async function getCertifyPanel(memberId) {
    const data = await ajaxGetJson(`/ajaxCertifyAMember/${memberId}/0/?_=${Date.now()}`);
    const doc = parseHtml(data.html);
    const bySkillId = new Map();

    doc.querySelectorAll('[data-skill_id]').forEach((node) => {
      const skillId = node.getAttribute('data-skill_id');
      const label = node.querySelector(':scope > div strong, :scope > strong')?.textContent.trim();
      if (!label || bySkillId.has(skillId)) return; // wrapper/nested duplicate row

      const buttons = [...node.querySelectorAll('button')];
      const select = node.querySelector('select.validation_status');
      const title = node.querySelector('[title*="certifiable"]')?.getAttribute('title') || null;
      const info = parseTitleInfo(title);
      bySkillId.set(skillId, {
        skillId,
        label,
        slug: extractSlug(node),
        // Existing ratings must be updated by their record id; 0 means "create new".
        mySkillId: node.getAttribute('data-my_skill_id') || '0',
        currentStatus: deriveStatus(info.message, select ? select.value : null),
        ...info,
        hasDocumentUpload: buttons.some((b) => /get skill form|upload/i.test(b.getAttribute('title') || b.textContent || '')),
        exam: parseExam(node),
        hasWorkshopTool: Boolean(node.querySelector('button[title="get workshop practical exam tool"]')),
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

  /** A level's checklist ("workshop practical exam tool"). */
  async function getWorkshopExam(memberId, skillId) {
    const data = await ajaxGetJson(`/ajaxWorkshopExam/${memberId}/0/${skillId}/?_=${Date.now()}`);
    const doc = parseHtml(data.html);
    const byItemId = new Map();

    // Each checklist row is a .skill_<id> block. Their inner markup varies a lot
    // (document rows have no thumbs-up at all), so the block itself is the anchor.
    doc.querySelectorAll('div.skill').forEach((node) => {
      const idClass = [...node.classList].find((c) => /^skill_\d+$/.test(c));
      if (!idClass) return;
      const itemId = idClass.replace('skill_', '');
      if (byItemId.has(itemId)) return;

      const titleHost = node.querySelector('[title*="certifiable"]');
      const title = titleHost?.getAttribute('title') || null;
      const label =
        titleHost?.querySelector('strong, b')?.textContent.trim() ||
        titleHost?.textContent.trim() ||
        node.querySelector('strong, b')?.textContent.trim() ||
        `item ${itemId}`;

      const validateBtn = node.querySelector('[onclick*="ajaxSaveItemFast"]');
      const commentBtn = node.querySelector('[onclick*="addComment("]');
      const mySkillId =
        (validateBtn?.getAttribute('onclick') || '').match(/ajaxSaveItemFast\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)/)?.[1] ||
        (commentBtn?.getAttribute('onclick') || '').match(/addComment\('MySkill',\s*(\d+)/)?.[1] ||
        '0';
      const needsDocument =
        /Document\s+Mandatory/i.test(node.textContent) || Boolean(node.querySelector('[onclick*="dashboard/procedures"]'));

      const info = parseTitleInfo(title);
      const validationStatus = node.querySelector('[data-validation-status]')?.getAttribute('data-validation-status') || '';
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
    const data = await ajaxGetJson(`/ajaxSaveItemFast/${memberId}/${itemId}/${mySkillId || '0'}/0/${targetStatus}/none/`);
    if (!data?.infos?.success) throw new FlyappiError(`ajaxSaveItemFast failed for item ${itemId}`);
    return data;
  }

  /** Sends the online exam to the student (the site emails them). */
  async function sendExam(examName, memberId) {
    const data = await ajaxGetJson(`/ajaxSendMissingExam/${encodeURIComponent(examName)}/${memberId}/0/?_=${Date.now()}`);
    if (!data?.infos?.success) throw new FlyappiError(`could not send the exam "${examName}"`);
    return data;
  }

  async function setSkillStatus(memberId, skillId, targetStatus, report, mySkillId) {
    const csrfToken = await getCsrfToken();
    const form = new FormData();
    form.append(
      'my_skills',
      JSON.stringify({ my_skill_id: mySkillId || '0', skill_id: skillId, validation_status: targetStatus, value: '', report: report || '' })
    );
    const data = await postJson(`/ajaxQuickSaveMySkills/${memberId}/unique/0/`, form, csrfToken ? { 'X-CSRFToken': csrfToken } : {});
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

  // Django rejects the submission (500, no useful message) if fields the template
  // declares are missing from the POST - e.g. the in-workshop document form has a
  // "workshop" select we never touch but must still send.
  function formDefaults(doc) {
    const defaults = {};
    doc.querySelectorAll('input[name], textarea[name], select[name]').forEach((field) => {
      const name = field.getAttribute('name');
      const type = (field.getAttribute('type') || field.tagName).toLowerCase();
      if (type === 'file' || type === 'checkbox' || type === 'radio') return;
      if (field.tagName === 'SELECT') {
        defaults[name] =
          field.querySelector('option[selected]')?.getAttribute('value') ?? field.querySelector('option')?.getAttribute('value') ?? '';
      } else if (field.tagName === 'TEXTAREA') {
        defaults[name] = field.textContent;
      } else {
        defaults[name] = field.getAttribute('value') || '';
      }
    });
    return defaults;
  }

  /** Side effect: the site locks (or creates) the record until it is saved or unlocked. */
  async function getSkillForm(memberId, skillId, mySkillId) {
    const data = await ajaxGetJson(`/ajaxGetMySkillForm/${memberId}/0/${skillId}/${mySkillId || '0'}/?_=${Date.now()}`);
    const doc = parseHtml(data.html);
    const formId = doc.querySelector('form#form_my_skill')?.getAttribute('data_my_skill_id');
    if (!formId) throw new FlyappiError('data_my_skill_id not found in the document form');
    return { formId, statusValues: statusOptionValues(doc), defaults: formDefaults(doc) };
  }

  async function releaseSkillLock(formId) {
    await ajaxGetJson(`/ajaxSimpleUpdate/MySkill/${formId}/locked/False/?_=${Date.now()}`).catch(() => {});
  }

  async function uploadDocument({ memberId, skillId, targetStatus, report, file, mySkillId }) {
    const { formId, statusValues, defaults } = await getSkillForm(memberId, skillId, mySkillId);
    try {
      const csrfToken = defaults.csrfmiddlewaretoken || (await getCsrfToken());
      const form = new FormData();
      Object.entries(defaults).forEach(([key, value]) => form.set(key, value));
      if (csrfToken) form.set('csrfmiddlewaretoken', csrfToken);
      form.set('validation_status', statusValues[targetStatus] ?? targetStatus);
      form.set('report', report || defaults.report || '');
      if (file) form.set('document_required', file, file.name);
      const data = await postJson(`/ajaxSaveMySkillForm/${formId}/`, form, csrfToken ? { 'X-CSRFToken': csrfToken } : {});
      // The backend reports success:true even when the inner Django form rejected
      // the submission - the real signal is the wording of its own message.
      if (!data?.infos?.success || /error/i.test(data?.infos?.message || '')) {
        throw new FlyappiError(`document upload failed: ${data?.infos?.message || 'no answer'}`);
      }
      return data;
    } catch (err) {
      await releaseSkillLock(formId);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Local storage (per device, per browser). Every access is guarded: private
  // mode or blocked storage must not break the tool.
  // ---------------------------------------------------------------------------

  function loadStored(key, fallback, storage = localStorage) {
    try {
      return JSON.parse(storage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function store(key, value, storage = localStorage) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable - not essential */
    }
  }

  const getRecentLicenses = () => loadStored(RECENT_KEY, []);

  function recordRecentLicense(entry) {
    const rest = getRecentLicenses().filter((e) => e.licenseNumber !== entry.licenseNumber);
    store(RECENT_KEY, [entry, ...rest].slice(0, MAX_RECENT));
  }

  // License -> member never changes, so the search is done once per device.
  async function getMember(licenseNumber) {
    const cache = loadStored(MEMBERS_KEY, {});
    if (cache[licenseNumber]) return cache[licenseNumber];
    const member = await searchMemberByLicense(licenseNumber);
    const fresh = loadStored(MEMBERS_KEY, {});
    fresh[licenseNumber] = member;
    const keys = Object.keys(fresh);
    keys.slice(0, Math.max(0, keys.length - MAX_CACHED_MEMBERS)).forEach((k) => delete fresh[k]);
    store(MEMBERS_KEY, fresh);
    return member;
  }

  // ---------------------------------------------------------------------------
  // Plans and issuing - same as the desktop app's pilotSession.js.
  // ---------------------------------------------------------------------------

  /**
   * What still has to be done, in order, to reach `targetSlug`. Levels already
   * validated - and lower levels the site has hidden because a higher one is
   * visible - are skipped. A step that is not visible yet unlocks only after the
   * one before it.
   */
  function buildPlan(skills, targetSlug) {
    const bySlug = new Map(skills.map((s) => [s.slug, s]));
    const step = (slug) => {
      const s = bySlug.get(slug);
      return { slug, label: s?.label || CHAIN_NAMES[slug] || slug, visible: Boolean(s), status: s?.currentStatus || null, exam: s?.exam || null };
    };

    const chainId = chainOf(targetSlug);
    if (!chainId) {
      const s = bySlug.get(targetSlug);
      return s && s.currentStatus !== 'validated' ? [step(targetSlug)] : [];
    }
    const chain = CHAINS[chainId];
    const idx = chain.indexOf(targetSlug);
    const highestVisible = Math.max(-1, ...chain.map((slug, i) => (bySlug.has(slug) ? i : -1)));
    const plan = [];
    for (let i = 0; i <= idx; i++) {
      const slug = chain[i];
      const s = bySlug.get(slug);
      if (s ? s.currentStatus === 'validated' : i < highestVisible) continue;
      if (slug === 'appi_3_pilot') {
        const ratingDone = APPI3_RATINGS.some((r) => bySlug.get(r)?.currentStatus === 'validated');
        if (!ratingDone) plan.push(step(APPI3_RATINGS[0]));
      }
      plan.push(step(slug));
    }
    return plan;
  }

  /** Everything the user can aim at for this pilot, with the plan to get there. */
  function buildTargets(skills) {
    const slugs = [...Object.values(CHAINS).flat(), ...skills.map((s) => s.slug).filter((slug) => slug && !chainOf(slug))];
    const targets = [];
    for (const slug of new Set(slugs)) {
      const plan = buildPlan(skills, slug);
      if (!plan.length) continue;
      const s = skills.find((x) => x.slug === slug);
      const chain = chainOf(slug);
      targets.push({ slug, label: s?.label || CHAIN_NAMES[slug] || slug, plan, chain, order: chain ? CHAINS[chain].indexOf(slug) : -1 });
    }
    return targets;
  }

  /**
   * The pilot's view from an already-fetched panel. Checklists are read only for
   * unfinished levels, in parallel - they decide whether a level still needs a
   * document (e.g. APPI 3's BESAFE procedure).
   */
  async function buildView(member, licenseNumber, panel) {
    const visible = panel.skills.filter((s) => !HIDDEN_SKILL_SLUGS.has(s.slug));
    const pending = visible.filter((s) => s.currentStatus !== 'validated' && s.hasWorkshopTool);
    const checklists = await Promise.all(
      pending.map((s) =>
        getWorkshopExam(member.memberId, s.skillId)
          .then((ws) => [s.skillId, ws.items])
          .catch(() => [s.skillId, []])
      )
    );
    const itemsBySkillId = new Map(checklists);

    const skills = visible.map((s) => {
      const documents = (itemsBySkillId.get(s.skillId) || [])
        .filter((i) => i.needsDocument && !isInheritedDocument(i.label, s.label))
        .map((i) => ({ label: i.label, done: i.currentStatus === 'validated' }));
      if (s.hasDocumentUpload && !documents.length) documents.push({ label: s.label, done: s.currentStatus === 'validated' });
      return {
        label: s.label,
        slug: s.slug,
        currentStatus: s.currentStatus,
        exam: s.exam,
        documents,
        needsFile: documents.some((d) => !d.done),
      };
    });

    return { member, licenseNumber, skills, targets: buildTargets(visible) };
  }

  async function findPilot(licenseNumber) {
    const member = await getMember(licenseNumber);
    recordRecentLicense({ licenseNumber, firstName: member.firstName, lastName: member.lastName });
    return buildView(member, licenseNumber, await getCertifyPanel(member.memberId));
  }

  /**
   * Certifies one whole level the standard way, in the order the site enforces:
   *   1. send the online exam, if the level has one and it is not sent yet
   *   2. tick every checklist item ("thumbs up")
   *   3. upload the mandatory document, if a file was given
   *   4. only then set the level's own status - the site refuses it until the
   *      exam is passed and every sub-item (incl. documents) is done
   * A missing exam result or document is a normal intermediate state, not an
   * error. `panel` is a fresh certify panel; the latest one is returned so the
   * next level does not have to re-read it.
   */
  async function certifyLevel(memberId, selection, status, log, panel) {
    const { skillLabel, file } = selection;
    const steps = [];
    const missingFiles = [];
    let waitingForExam = false;

    const startSkill = findSkill(panel, skillLabel);
    if (!startSkill) throw new FlyappiError(`level "${skillLabel}" is not available for this pilot`);
    const skillId = startSkill.skillId;

    if (startSkill.currentStatus === status) {
      return { steps: [`already ${status}`], waitingForExam, missingFiles, panel, fresh: true };
    }

    if (startSkill.exam && !startSkill.exam.isPassed) {
      if (startSkill.exam.needsSending) {
        await sendExam(startSkill.exam.examName, memberId);
        log(`  📨 exam "${startSkill.exam.examName}" sent to the student`);
        steps.push('exam sent');
      } else {
        steps.push('exam already sent');
      }
      waitingForExam = true;
    }

    if (startSkill.hasWorkshopTool) {
      const workshop = await getWorkshopExam(memberId, skillId);
      let done = 0;
      let already = 0;
      let skipped = 0;
      // Sequential on purpose: each save also recomputes the parent chapter on
      // the site, and parallel saves risk duplicate rating records.
      for (const item of workshop.items) {
        if (item.currentStatus === status) {
          already += 1;
          continue;
        }
        // Rows like the BESAFE procedure have no thumbs-up - the only way to
        // close them is uploading the document the site demands.
        if (item.needsDocument) {
          if (isInheritedDocument(item.label, skillLabel)) {
            skipped += 1;
          } else if (!file) {
            missingFiles.push(item.label);
          } else {
            await uploadDocument({ memberId, skillId: item.itemId, targetStatus: status, file, mySkillId: item.mySkillId });
            done += 1;
            log(`  📎 ${item.label} - document uploaded`);
          }
          continue;
        }
        if (!item.canThumbUp || (item.statutesAvailable.length && !item.statutesAvailable.includes(status))) {
          skipped += 1;
          continue;
        }
        await validateItem(memberId, item.itemId, status, item.mySkillId);
        done += 1;
      }
      steps.push(`items: ${done} ticked${already ? `, ${already} already done` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
    }

    if (startSkill.hasDocumentUpload) {
      if (file) {
        await uploadDocument({ memberId, skillId, targetStatus: status, file, mySkillId: startSkill.mySkillId });
        steps.push('document uploaded');
      } else {
        missingFiles.push(skillLabel);
      }
    }

    if (missingFiles.length) steps.push(`needs file: ${missingFiles.join(', ')}`);
    if (waitingForExam || missingFiles.length) {
      // Other levels are unaffected, so the panel stays usable for them - but this
      // level's exam/items just changed, so it is stale for the final view.
      return { steps, waitingForExam, missingFiles, panel, fresh: false };
    }

    // Re-read: ticking items is what makes the final status available.
    const livePanel = await getCertifyPanel(memberId);
    const live = findSkill(livePanel, skillLabel);
    if (!live) throw new FlyappiError('level is no longer visible for this pilot');
    if (live.currentStatus === status) {
      steps.push(`level already ${status}`);
      return { steps, waitingForExam, missingFiles, panel: livePanel, fresh: true };
    }
    if (live.statutesAvailable.length && !live.statutesAvailable.includes(status)) {
      throw new FlyappiError(`the site does not allow "${status}" yet (available: ${live.statutesAvailable.join(', ') || 'none'}). ${live.message}`);
    }

    await setSkillStatus(memberId, skillId, status, '', live.mySkillId);
    // The site reports success even when it ignores the save, so confirm it.
    const after = await getCertifyPanel(memberId);
    const confirmed = findSkill(after, skillLabel);
    if (confirmed?.currentStatus !== status) {
      throw new FlyappiError(`status did not apply (now: ${confirmed?.currentStatus || 'not started'}). ${confirmed?.message || ''}`);
    }
    steps.push(`level → ${status}`);
    return { steps, waitingForExam, missingFiles, panel: after, fresh: true };
  }

  async function tryCertify(memberId, selection, log, panel) {
    const { skillLabel } = selection;
    log(`${skillLabel}: starting...`);
    try {
      const out = await certifyLevel(memberId, selection, 'validated', log, panel);
      const pending = out.waitingForExam || out.missingFiles.length > 0;
      const message = out.steps.join('; ');
      log(`${skillLabel}: ${message}`, pending ? 'warn' : 'ok');
      return {
        result: { skillLabel, status: pending ? 'pending' : 'ok', message, waitingForExam: out.waitingForExam, missingFiles: out.missingFiles },
        panel: out.panel,
        fresh: out.fresh,
      };
    } catch (err) {
      log(`${skillLabel}: ${err.message}`, 'error');
      return { result: { skillLabel, status: 'error', message: err.message, waitingForExam: false, missingFiles: [] }, panel: null, fresh: false };
    }
  }

  /**
   * Brings a pilot to `targetSlug` one level at a time. The panel that confirmed
   * a level is reused for the next one (a panel render costs ~4 s). Stops at the
   * first level that has to wait (online exam, missing file) or fails -
   * everything after it depends on it; the next run continues from there.
   */
  async function applyTarget(licenseNumber, targetSlug, { file, onLog } = {}) {
    const log = (message, level = 'info') => onLog?.(`[${licenseNumber}] ${message}`, level);
    const member = await getMember(licenseNumber);
    const results = [];
    let panel = await getCertifyPanel(member.memberId);
    let fresh = true;
    const visibleSkills = () => panel.skills.filter((sk) => !HIDDEN_SKILL_SLUGS.has(sk.slug));
    const tried = new Set();

    for (let i = 0; i < MAX_STEPS; i++) {
      const next = buildPlan(visibleSkills(), targetSlug)[0];
      if (!next) break; // target reached
      if (tried.has(next.slug)) break; // no progress - never loop on the same level
      tried.add(next.slug);

      if (!next.visible) {
        results.push({ skillLabel: next.label, status: 'pending', message: 'not unlocked on the site yet', waitingForExam: false, missingFiles: [] });
        break;
      }

      const skill = visibleSkills().find((sk) => sk.slug === next.slug);
      const out = await tryCertify(member.memberId, { skillLabel: skill.label, file }, log, panel);
      results.push(out.result);
      if (out.panel) {
        panel = out.panel;
        fresh = out.fresh;
      } else {
        panel = await getCertifyPanel(member.memberId); // state unknown after an error
        fresh = true;
      }
      if (out.result.status !== 'ok') break;
      if (!fresh) {
        panel = await getCertifyPanel(member.memberId);
        fresh = true;
      }
    }

    const finalPanel = fresh ? panel : await getCertifyPanel(member.memberId);
    return { results, pilot: await buildView(member, licenseNumber, finalPanel) };
  }

  // ---------------------------------------------------------------------------
  // UI: a panel over the site, inside a shadow root so neither the site's CSS
  // nor ours leaks into the other. Phone: full screen. Computer: side drawer.
  // ---------------------------------------------------------------------------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --fg: #111; --bg: #fff; --muted: rgba(0,0,0,.6); --border: #d0d0d0; --soft: rgba(127,127,127,.08);
      --blue: #2563eb; --ok: #16a34a; --err: #dc2626; --wait: #d97706;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .root { --fg: #eee; --bg: #1c1c1e; --muted: rgba(255,255,255,.6); --border: #444; --ok: #4ade80; --err: #f87171; --wait: #fbbf24; }
    }
    button, input { font: inherit; color: inherit; }
    .toggle {
      position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 2147483000;
      width: 52px; height: 52px; border-radius: 50%; border: none; background: var(--blue); color: #fff;
      font-size: 24px; box-shadow: 0 2px 10px rgba(0,0,0,.3); cursor: pointer;
    }
    .panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: min(460px, 100vw); z-index: 2147483001;
      background: var(--bg); box-shadow: -4px 0 24px rgba(0,0,0,.3); display: flex; flex-direction: column;
    }
    .panel[hidden] { display: none; }
    @media (max-width: 600px) { .panel { width: 100vw; box-shadow: none; } }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; padding-top: calc(10px + env(safe-area-inset-top)); border-bottom: 1px solid var(--border); }
    .head b { flex: 1; font-size: 15px; }
    .head .ver { font-size: 11px; color: var(--muted); }
    .close { border: none; background: none; font-size: 26px; line-height: 1; padding: 4px 8px; cursor: pointer; }
    .body { flex: 1; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 12px 14px; }
    .search { display: flex; gap: 8px; }
    .search input { flex: 1; min-width: 0; font-size: 16px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent; }
    .btn { padding: 9px 16px; min-height: 44px; border-radius: 8px; border: 1px solid var(--border); background: transparent; cursor: pointer; font-size: 15px; }
    .btn.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
    .btn:disabled { opacity: .5; cursor: default; }
    details { margin-top: 8px; }
    summary { cursor: pointer; font-size: 13px; color: var(--muted); padding: 4px 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .chip { padding: 6px 12px; border-radius: 16px; border: 1px solid var(--border); background: var(--soft); cursor: pointer; font-size: 13px; }
    .legend { margin: 4px 0; padding-left: 18px; font-size: 13px; line-height: 1.7; }
    .hint { font-size: 12px; color: var(--muted); }
    .picker { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; align-items: center; }
    .picker .hint { width: 100%; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 18px; font-weight: 600; cursor: pointer; }
    .pill-on { background: rgba(37,99,235,.15); border-color: var(--blue); }
    .cards { display: flex; flex-direction: column; gap: 10px; }
    .card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--soft); }
    .card-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .lic { font-size: 12px; color: var(--muted); }
    .status { font-size: 13px; margin-bottom: 6px; word-break: break-word; }
    .ok { color: var(--ok); } .err { color: var(--err); } .wait { color: var(--wait); }
    .level { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; border-top: 1px solid var(--border); cursor: pointer; }
    .level input { width: 20px; height: 20px; margin: 0; flex: none; }
    .lvl-name { flex: 1; min-width: 0; }
    .lvl-st { font-size: 12px; color: var(--muted); white-space: nowrap; }
    .plan { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .info { font-size: 12px; margin: 6px 0; display: flex; flex-direction: column; gap: 2px; }
    .files { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .file-btn { position: relative; display: block; text-align: center; padding: 10px; border-radius: 8px; border: 1px solid var(--err); color: var(--err); cursor: pointer; overflow: hidden; }
    /* The real input covers the button: tapping it directly is what reliably opens the picker on iOS. */
    .file-btn input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
    .file-busy { border-color: var(--wait); color: var(--wait); background: rgba(217,119,6,.08); }
    .file-disabled { opacity: .45; pointer-events: none; }
    .issued { margin-top: 8px; font-size: 12px; color: var(--muted); }
    .log { max-height: 220px; overflow-y: auto; background: var(--soft); border-radius: 8px; padding: 8px; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
    .runbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; padding-bottom: calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border); }
    .runbar .btn { min-width: 120px; }
    @media (max-width: 600px) { .runbar .btn { flex: 1; } }
  `;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function buildUi() {
    const host = el('div', { id: 'flyappi-helper' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('style', { textContent: STYLE }));
    const root = el('div', { className: 'root' });
    shadow.append(root);
    document.body.append(host);

    // ---- static layout ----
    const toggle = el('button', { className: 'toggle', title: 'FlyAPPI Helper', textContent: '🪂' });
    const panel = el('div', { className: 'panel', hidden: true });
    const closeBtn = el('button', { className: 'close', title: 'Close', textContent: '×' });
    const input = el('input', {
      type: 'text',
      inputMode: 'numeric',
      autocomplete: 'off',
      placeholder: 'License number(s): 53354 or 53354, 45773',
      value: loadStored(INPUT_KEY, '', sessionStorage),
    });
    const findBtn = el('button', { className: 'btn primary', textContent: 'Find' });
    const recentBox = el('div', { className: 'chips' });
    const pickerBox = el('div', { className: 'picker' });
    const cardsBox = el('div', { className: 'cards' });
    const logBox = el('div', { className: 'log' });
    const runBtn = el('button', { className: 'btn primary', textContent: 'Run', disabled: true });
    const statusText = el('span', { className: 'hint' });

    const legend = el('ul', { className: 'legend' });
    for (const line of [
      '✅ level issued   🔒 level not yet unlocked on the site',
      '🎓 exam passed   ⏳ exam sent, student has not finished   📨 exam not sent yet',
      '📗 file uploaded   📎 file missing - upload it with the button in the pilot\'s card',
      '❌ error from the site (tap for the full text)',
    ]) legend.append(el('li', { textContent: line }));

    panel.append(
      el('div', { className: 'head' }, el('b', { textContent: 'FlyAPPI Helper' }), el('span', { className: 'ver', textContent: `v${VERSION}` }), closeBtn),
      el(
        'div',
        { className: 'body' },
        el('div', { className: 'search' }, input, findBtn),
        el('details', { open: true }, el('summary', { textContent: 'Recent licenses' }), recentBox),
        el('details', {}, el('summary', { textContent: 'What the icons mean' }), legend),
        pickerBox,
        cardsBox,
        el('details', {}, el('summary', { textContent: 'Log' }), logBox)
      ),
      el('div', { className: 'runbar' }, runBtn, statusText)
    );
    root.append(toggle, panel);

    const setOpen = (open) => {
      panel.hidden = !open;
      store(OPEN_KEY, open, sessionStorage);
    };
    toggle.addEventListener('click', () => setOpen(panel.hidden));
    closeBtn.addEventListener('click', () => setOpen(false));
    if (loadStored(OPEN_KEY, false, sessionStorage)) setOpen(true);

    function log(message, level = 'info') {
      const line = el('div', { textContent: `[${new Date().toLocaleTimeString()}] ${message}` });
      line.className = { error: 'err', warn: 'wait', ok: 'ok' }[level] || '';
      logBox.append(line);
      while (logBox.childNodes.length > 500) logBox.firstChild.remove();
      logBox.scrollTop = logBox.scrollHeight;
    }

    // ---- state ----
    /** @type {{license:string, member?:object, skills:any[], targets:any[], error?:string, checked:Set<string>, results?:any[], busy?:string, uploading?:string}[]} */
    let pilots = [];
    let busy = false;
    const anyBusy = () => busy || pilots.some((p) => p.busy);

    // Leaving the page aborts whatever is running - ask first.
    window.addEventListener('beforeunload', (e) => {
      if (!anyBusy()) return;
      e.preventDefault();
      e.returnValue = '';
    });

    const parseLicenses = (text) => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
    const examIcon = (exam) => (!exam ? '' : exam.isPassed ? ' 🎓' : exam.needsSending ? ' 📨' : ' ⏳');
    const planText = (plan) => plan.map((s) => `${s.visible ? '' : '🔒 '}${s.label}${examIcon(s.exam)}`).join(' → ');

    async function pool(items, worker, limit) {
      let next = 0;
      const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await worker(items[next++]);
      });
      await Promise.all(runners);
    }

    function setPilot(pilot, view) {
      pilot.error = undefined;
      pilot.member = view.member;
      pilot.skills = view.skills;
      pilot.targets = view.targets;
      // A target reached meanwhile can't stay ticked.
      for (const slug of [...pilot.checked]) if (!pilot.targets.some((t) => t.slug === slug)) pilot.checked.delete(slug);
    }

    function setPilotError(pilot, err) {
      pilot.error = err.message;
      pilot.skills = [];
      pilot.targets = [];
    }

    function renderRecent() {
      recentBox.replaceChildren();
      for (const entry of getRecentLicenses()) {
        const chip = el('button', { className: 'chip', textContent: `${entry.licenseNumber} — ${entry.firstName} ${entry.lastName}`, title: 'Add to the list' });
        chip.addEventListener('click', () => {
          const current = parseLicenses(input.value);
          if (!current.includes(entry.licenseNumber)) input.value = [...current, entry.licenseNumber].join(', ');
          store(INPUT_KEY, input.value, sessionStorage);
        });
        recentBox.append(chip);
      }
    }

    function resultLine(pilot) {
      if (pilot.error) return { cls: 'err', text: `❌ ${pilot.error}`, title: pilot.error };
      if (pilot.busy) return { cls: 'wait', text: pilot.busy, title: '' };
      if (!pilot.results) return null;
      const r = pilot.results;
      const title = r.map((x) => `${x.skillLabel}: ${x.message}`).join('\n');
      const parts = [];
      const errors = r.filter((x) => x.status === 'error');
      if (errors.length) parts.push(`❌ ${errors[0].skillLabel}: ${errors[0].message}`);
      if (r.some((x) => x.waitingForExam)) parts.push('⏳ waiting for exam');
      if (r.some((x) => x.missingFiles?.length)) parts.push('📎 needs file');
      if (r.some((x) => x.status === 'pending' && /not unlocked/.test(x.message))) parts.push('🔒 next level not unlocked yet');
      if (!parts.length) parts.push(r.length ? '✅ done' : '✅ nothing to do');
      const cls = errors.length ? 'err' : parts[0].startsWith('✅') ? 'ok' : 'wait';
      return { cls, text: parts.join(' · '), title };
    }

    // Targets offered for everyone: paths first (in path order), loose levels after.
    function pickerTargets() {
      const map = new Map();
      for (const p of pilots) {
        for (const t of p.targets) {
          if (!map.has(t.slug)) map.set(t.slug, { ...t, holders: [] });
          map.get(t.slug).holders.push(p);
        }
      }
      const rank = (t) => (t.chain === 'main' ? 0 : t.chain ? 1 : 2);
      return [...map.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
    }

    function renderPicker() {
      pickerBox.replaceChildren();
      const targets = pickerTargets();
      if (!targets.length) return;
      pickerBox.append(el('div', { className: 'hint', textContent: 'Target level for everyone:' }));
      for (const t of targets) {
        const cb = el('input', { type: 'checkbox', disabled: busy, checked: t.holders.every((p) => p.checked.has(t.slug)) });
        cb.addEventListener('change', () => {
          for (const p of t.holders) cb.checked ? p.checked.add(t.slug) : p.checked.delete(t.slug);
          render();
        });
        pickerBox.append(el('label', { className: `pill${cb.checked ? ' pill-on' : ''}` }, cb, ` ${t.label} · ${t.holders.length}`));
      }
    }

    function pilotCard(pilot) {
      const card = el('div', { className: 'card' });
      const name = pilot.member ? `${pilot.member.firstName} ${pilot.member.lastName}` : pilot.busy ? '' : 'not found';
      card.append(el('div', { className: 'card-head' }, el('b', { textContent: name }), el('span', { className: 'lic', textContent: `#${pilot.license}` })));

      const result = resultLine(pilot);
      if (result) {
        const line = el('div', { className: `status ${result.cls}`, textContent: result.text, title: result.title });
        // No hover on a phone: tapping shows the full text.
        if (result.title) line.addEventListener('click', () => alert(result.title));
        card.append(line);
      }

      for (const t of pilot.targets) {
        const cb = el('input', { type: 'checkbox', checked: pilot.checked.has(t.slug), disabled: busy || Boolean(pilot.busy) });
        cb.addEventListener('change', () => {
          cb.checked ? pilot.checked.add(t.slug) : pilot.checked.delete(t.slug);
          render();
        });
        const nameBox = el('span', { className: 'lvl-name' }, el('b', { textContent: t.label }));
        const row = el('label', { className: 'level' }, cb, nameBox);
        const direct = t.plan.length === 1 && t.plan[0].slug === t.slug;
        if (direct) row.append(el('span', { className: 'lvl-st', textContent: `${t.plan[0].status || 'not started'}${examIcon(t.plan[0].exam)}` }));
        else nameBox.append(el('div', { className: 'plan', textContent: planText(t.plan) }));
        card.append(row);
      }

      // Exam and document state of every unfinished level, ticked or not.
      const info = el('div', { className: 'info' });
      for (const skill of pilot.skills.filter((s) => s.currentStatus !== 'validated')) {
        if (skill.exam) {
          const e = skill.exam;
          const [cls, text] = e.isPassed ? ['ok', '🎓 exam passed'] : e.needsSending ? ['err', '📨 exam not sent'] : ['wait', '⏳ exam sent, waiting'];
          info.append(el('div', { className: cls, textContent: `${skill.label}: ${text}` }));
        }
        for (const doc of skill.documents) {
          info.append(el('div', { className: doc.done ? 'ok' : 'err', textContent: `${skill.label}: ${doc.done ? '📗 file uploaded' : '📎 file missing'} (${doc.label})` }));
        }
      }
      if (info.childNodes.length) card.append(info);

      const files = el('div', { className: 'files' });
      for (const skill of pilot.skills.filter((s) => s.needsFile && s.currentStatus !== 'validated')) {
        if (pilot.uploading === skill.label) {
          files.append(el('span', { className: 'file-btn file-busy', textContent: `⏳ Uploading... · ${skill.label}` }));
          continue;
        }
        const locked = busy || Boolean(pilot.busy);
        const fileInput = el('input', { type: 'file', disabled: locked });
        fileInput.addEventListener('change', () => fileInput.files[0] && uploadFor(pilot, skill, fileInput.files[0]));
        files.append(el('label', { className: `file-btn${locked ? ' file-disabled' : ''}` }, `📎 Upload file · ${skill.label}`, fileInput));
      }
      if (files.childNodes.length) card.append(files);

      const issued = pilot.skills.filter((s) => s.currentStatus === 'validated').map((s) => s.label);
      if (issued.length) card.append(el('div', { className: 'issued', textContent: `✅ ${issued.join(', ')}` }));
      return card;
    }

    function render() {
      renderPicker();
      cardsBox.replaceChildren(...pilots.map(pilotCard));
      runBtn.disabled = anyBusy() || !pilots.some((p) => p.checked.size);
      findBtn.disabled = anyBusy();
    }

    // The highest ticked level of each path already includes the lower ones of
    // that path (SIV before Advanced SIV, APPI 2 before APPI 3...), so only it is
    // run; levels outside any path are run each.
    function targetsToRun(pilot) {
      const best = new Map();
      const loose = [];
      for (const t of pilot.targets.filter((x) => pilot.checked.has(x.slug))) {
        if (!t.chain) loose.push(t.slug);
        else if (!best.has(t.chain) || t.order > best.get(t.chain).order) best.set(t.chain, t);
      }
      return [...[...best.values()].map((t) => t.slug), ...loose];
    }

    async function runTarget(pilot, slug, file) {
      try {
        const out = await applyTarget(pilot.license, slug, { file, onLog: log });
        setPilot(pilot, out.pilot); // fresh state comes back with the result
        return out.results;
      } catch (err) {
        log(`[${pilot.license}] ${err.message}`, 'error');
        return [{ skillLabel: CHAIN_NAMES[slug] || slug, status: 'error', message: err.message }];
      }
    }

    // A file goes with the level whose button was pressed; uploads run on their
    // own, so they can be added for several pilots one after another.
    async function uploadFor(pilot, skill, file) {
      if (busy || pilot.busy) return;
      stopPageVideos();
      pilot.busy = '⏳ uploading file...';
      pilot.uploading = skill.label;
      render();
      try {
        pilot.results = await runTarget(pilot, skill.slug, file);
      } finally {
        pilot.busy = undefined;
        pilot.uploading = undefined;
        render();
      }
    }

    async function load() {
      if (anyBusy()) return;
      const licenses = parseLicenses(input.value);
      if (!licenses.length) return;
      if (licenses.length > MAX_PILOTS) {
        statusText.textContent = `at most ${MAX_PILOTS} pilots, got ${licenses.length}`;
        return;
      }
      store(INPUT_KEY, input.value, sessionStorage);
      input.blur(); // hide the phone keyboard so the cards are visible
      stopPageVideos();
      busy = true;
      pilots = licenses.map((license) => ({ license, skills: [], targets: [], checked: new Set(), busy: 'loading...' }));
      render();
      let loaded = 0;
      const started = Date.now();
      await pool(
        pilots,
        async (pilot) => {
          try {
            setPilot(pilot, await findPilot(pilot.license));
          } catch (err) {
            setPilotError(pilot, err);
            log(`[${pilot.license}] ${err.message}`, 'error');
          }
          pilot.busy = undefined;
          statusText.textContent = `loaded ${++loaded} of ${pilots.length}...`;
          render();
        },
        LOAD_CONCURRENCY
      );
      busy = false;
      statusText.textContent = `loaded ${pilots.length} in ${Math.round((Date.now() - started) / 1000)} s`;
      render();
      renderRecent();
    }

    async function run() {
      if (anyBusy()) return;
      stopPageVideos();
      busy = true;
      const todo = pilots.filter((p) => p.checked.size);
      for (const p of todo) p.busy = '⏳ queued';
      render();
      let finished = 0;
      const started = Date.now();
      await pool(
        todo,
        async (pilot) => {
          pilot.busy = '⏳ working...';
          render();
          const all = [];
          for (const slug of targetsToRun(pilot)) all.push(...(await runTarget(pilot, slug, null)));
          pilot.results = all;
          pilot.busy = undefined;
          statusText.textContent = `done ${++finished} of ${todo.length}...`;
          render();
        },
        RUN_CONCURRENCY
      );
      busy = false;
      statusText.textContent = `finished ${todo.length} in ${Math.round((Date.now() - started) / 1000)} s`;
      render();
    }

    findBtn.addEventListener('click', load);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') load();
    });
    input.addEventListener('input', () => store(INPUT_KEY, input.value, sessionStorage));
    runBtn.addEventListener('click', run);

    renderRecent();
    render();
  }

  if (document.body) buildUi();
  else document.addEventListener('DOMContentLoaded', buildUi);
})();
