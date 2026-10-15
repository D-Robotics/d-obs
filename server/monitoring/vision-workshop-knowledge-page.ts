/** Lazy, read-only access to reviewed camera knowledge and its evidence maturity. */
export function renderVisionKnowledgeSection(): string {
  return `<details id="cameraKnowledge" class="atomic-info"><summary>相机接入知识与验收证据</summary><div class="atomic-body"><p class="hint">检索资料前提、接入步骤和原子能力。资料核对、适配器配置与真机验收分别记录。</p><form id="cameraKnowledgeSearch"><label class="field">搜索接入知识<input id="cameraKnowledgeQuery" type="search" maxlength="160" placeholder="相机型号、平台或调优关键词"></label><div class="actions"><button id="cameraKnowledgeSubmit" type="submit" class="btn small">搜索</button></div></form><div id="cameraKnowledgeStatus" role="status" aria-live="polite"></div><div id="cameraKnowledgeList" class="adapter-list"></div><div id="cameraKnowledgeDetail" class="advanced-body" hidden></div></div></details>`;
}

/** Insert inside the workshop IIFE, after its DOM and authenticated request helpers. */
export const VISION_WORKSHOP_KNOWLEDGE_SCRIPT = String.raw`
  (() => {
    const knowledgeRoot = $('cameraKnowledge');
    if (!knowledgeRoot) return;
    const knowledgeForm = $('cameraKnowledgeSearch');
    const knowledgeQuery = $('cameraKnowledgeQuery');
    const knowledgeSubmit = $('cameraKnowledgeSubmit');
    const knowledgeStatus = $('cameraKnowledgeStatus');
    const knowledgeList = $('cameraKnowledgeList');
    const knowledgeDetail = $('cameraKnowledgeDetail');
    let knowledgeOpened = false;
    let knowledgeListGeneration = 0;
    let knowledgeDetailGeneration = 0;
    const knowledgeText = value => {
      if (value == null) return '';
      if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return '资料格式无法显示'; } }
      return clean(value);
    };
    const knowledgeButton = (label, action) => {
      const node = make('button', 'btn small', label); node.type = 'button';
      node.addEventListener('click', action); return node;
    };
    const knowledgeReadiness = value => ({ adapter_unavailable: '适配器未配置', configured_unverified: '已配置 · 真机未验证', unavailable: '能力未配置', manual_required: '需人工执行' }[value] || '执行状态未记录');
    const knowledgeVerification = value => {
      const record = value || {};
      return (record.documentation === 'verified' ? '资料已核对' : '资料核对状态未记录') + ' · ' + (record.hardware === 'unverified' ? '真机未验证' : '真机验收状态未记录');
    };
    function knowledgeError(node, error, retry) {
      node.replaceChildren();
      const notice = make('div', 'notice bad'); notice.setAttribute('role', 'alert');
      append(notice, make('p', '', '读取接入知识失败：' + clean(error && error.message || error || '未知错误')), knowledgeButton('重试读取', retry));
      node.appendChild(notice);
    }
    function knowledgeSection(parent, title) {
      const section = make('section', 'adapter-item'); section.appendChild(make('h3', '', title)); parent.appendChild(section); return section;
    }
    function knowledgeItems(parent, values) {
      const list = make('ul', 'change-list');
      arr(values).forEach(value => {
        const text = knowledgeText(value && typeof value === 'object' ? value.text || value.label || value.title || value : value);
        if (text) list.appendChild(make('li', '', text));
      });
      if (list.children.length) parent.appendChild(list);
    }
    function knowledgeSourceUrl(value) {
      if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
      try { const url = new URL(value); return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null; } catch { return null; }
    }
    function knowledgeRenderDetail(response) {
      if (!response || response.ok !== true || !response.knowledge || typeof response.knowledge !== 'object') throw new Error('知识详情回执不完整');
      const record = response.knowledge; const readiness = response.readiness || {};
      knowledgeDetail.replaceChildren(); knowledgeDetail.hidden = false;
      append(knowledgeDetail, make('h2', '', record.title || record.id), make('p', '', record.summary || ''), make('p', 'review-note', knowledgeVerification(record.verification)), make('p', 'review-note', knowledgeReadiness(readiness.status) + (readiness.reason ? '：' + clean(readiness.reason) : '')));
      if (arr(readiness.adapters).length) knowledgeItems(knowledgeDetail, readiness.adapters.map(adapter => '适配器配置：' + clean(adapter.label || adapter.id)));
      if (record.teamExperience && arr(record.teamExperience.entries).length) {
        const experience = record.teamExperience;
        const details = make('details', 'advanced'); details.appendChild(make('summary', '', '团队现场经验 · 用户报告，历史案例待复核')); knowledgeDetail.appendChild(details);
        const section = knowledgeSection(details, '点亮与 ISP 现场操作指引');
        append(section, make('p', 'hint', '报告日期：' + knowledgeText(experience.reportedOn) + '。' + knowledgeText(experience.provenance && experience.provenance.description)), make('p', 'hint', knowledgeText(experience.scope)));
        arr(experience.entries).forEach(entry => {
          const item = make('div', 'review-note');
          append(item, make('strong', '', knowledgeText(entry.topic)), make('p', '', knowledgeText(entry.guidance)));
          if (entry.historicalExample) item.appendChild(make('p', 'hint', '用户报告的历史线索：' + knowledgeText(entry.historicalExample)));
          if (entry.evidence) item.appendChild(make('p', 'hint', '需核对的证据与边界：' + knowledgeText(entry.evidence)));
          section.appendChild(item);
        });
        if (arr(experience.expertRecordFields).length) knowledgeItems(knowledgeSection(section, '专家流程采集字段'), experience.expertRecordFields);
      }
      if (arr(record.facts).length) {
        const section = knowledgeSection(knowledgeDetail, '已核对的资料事实');
        arr(record.facts).forEach(fact => {
          const item = make('div', 'review-note'); item.appendChild(make('strong', '', fact.title || fact.id || '资料事实'));
          const value = fact.text !== undefined ? fact.text : fact.value;
          if (value !== undefined) item.appendChild(make('p', '', knowledgeText(value)));
          if (arr(fact.sourceIds).length) item.appendChild(make('p', 'hint', '来源标识：' + arr(fact.sourceIds).map(clean).join(' / ')));
          section.appendChild(item);
        });
      }
      if (arr(record.requiredAtomics).length) {
        const section = knowledgeSection(knowledgeDetail, '所需原子能力与验收证据');
        arr(record.requiredAtomics).forEach(atomic => {
          const item = make('div', 'review-note'); const state = arr(readiness.atomics).find(value => value.id === atomic.id);
          append(item, make('strong', '', atomic.label || atomic.id), make('p', 'hint', knowledgeReadiness(state && state.status)));
          if (arr(atomic.operations).length) item.appendChild(make('p', 'hint', '协议操作：' + arr(atomic.operations).map(clean).join(' / ')));
          if (state && arr(state.missingOperations).length) item.appendChild(make('p', 'hint', '尚缺操作：' + arr(state.missingOperations).map(clean).join(' / ')));
          if (arr(atomic.prerequisites).length) { item.appendChild(make('p', 'meta-label', '执行前提')); knowledgeItems(item, atomic.prerequisites); }
          if (arr(atomic.evidence).length) { item.appendChild(make('p', 'meta-label', '需保留的实际回执')); knowledgeItems(item, atomic.evidence); }
          if (atomic.notes) item.appendChild(make('p', 'hint', knowledgeText(atomic.notes)));
          section.appendChild(item);
        });
      }
      if (arr(record.workflow).length) knowledgeItems(knowledgeSection(knowledgeDetail, '接入与调优顺序'), record.workflow);
      if (arr(record.limitations).length) knowledgeItems(knowledgeSection(knowledgeDetail, '限制与待验证项'), record.limitations);
      if (arr(record.sources).length) {
        const section = knowledgeSection(knowledgeDetail, '资料来源');
        arr(record.sources).forEach(source => {
          const item = make('div', 'review-note'); const url = knowledgeSourceUrl(source.url);
          if (url) { const link = make('a', '', source.title || url); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.appendChild(link); }
          else append(item, make('span', '', source.title || '资料来源'), make('span', 'hint', ' · 来源链接不可用'));
          if (source.locator) item.appendChild(make('p', 'hint', knowledgeText(source.locator)));
          if (typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(source.sha256)) item.appendChild(make('code', 'contract-code', 'SHA-256：' + source.sha256));
          section.appendChild(item);
        });
      }
    }
    async function knowledgeLoadDetail(id) {
      const generation = ++knowledgeDetailGeneration;
      knowledgeDetail.hidden = false; knowledgeDetail.replaceChildren(make('p', 'loading', '正在读取知识详情…'));
      try {
        const response = await request('/knowledge/' + encodeURIComponent(clean(id)));
        if (generation !== knowledgeDetailGeneration) return;
        knowledgeRenderDetail(response);
      } catch (error) { if (generation === knowledgeDetailGeneration) knowledgeError(knowledgeDetail, error, () => knowledgeLoadDetail(id)); }
    }
    async function knowledgeLoadIndex(query) {
      const generation = ++knowledgeListGeneration; ++knowledgeDetailGeneration;
      knowledgeOpened = true; knowledgeSubmit.disabled = true;
      knowledgeStatus.replaceChildren(make('p', 'loading', '正在检索接入知识…'));
      knowledgeList.replaceChildren(); knowledgeDetail.replaceChildren(); knowledgeDetail.hidden = true;
      try {
        const response = await request('/knowledge?q=' + encodeURIComponent(query));
        if (generation !== knowledgeListGeneration) return;
        if (!response || response.ok !== true || !Array.isArray(response.entries)) throw new Error('知识目录回执不完整');
        knowledgeStatus.replaceChildren(make('p', 'hint', response.entries.length ? '找到 ' + response.entries.length + ' 项接入知识。' : '没有匹配的接入知识，可更换关键词后搜索。'));
        response.entries.forEach(entry => {
          const item = make('div', 'adapter-item'); const open = knowledgeButton(entry.title || entry.id, () => knowledgeLoadDetail(entry.id));
          append(item, open, make('p', 'hint', entry.summary || ''), make('p', 'hint', knowledgeVerification(entry.verification)), make('p', 'hint', knowledgeReadiness(entry.readiness && entry.readiness.status) + (entry.readiness && entry.readiness.reason ? '：' + clean(entry.readiness.reason) : '')));
          if (entry.teamExperience) item.appendChild(make('p', 'hint', '另含用户报告的现场经验，历史案例待复核；含通用选型与排障线索，不表示其他型号已适配。'));
          knowledgeList.appendChild(item);
        });
      } catch (error) { if (generation === knowledgeListGeneration) knowledgeError(knowledgeStatus, error, () => knowledgeLoadIndex(query)); }
      finally { if (generation === knowledgeListGeneration) knowledgeSubmit.disabled = false; }
    }
    knowledgeRoot.addEventListener('toggle', () => { if (knowledgeRoot.open && !knowledgeOpened) return knowledgeLoadIndex(clean(knowledgeQuery.value).trim()); });
    knowledgeForm.addEventListener('submit', event => { event.preventDefault(); return knowledgeLoadIndex(clean(knowledgeQuery.value).trim()); });
  })();
`;
