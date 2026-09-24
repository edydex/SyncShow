'use strict';

const isTitle = item => item.kind === 'sermon' && (item.sermonTemplate === 'title' || item.presetId === 'wotbc-sermon-title');
const isPoint = item => item.kind === 'sermon' && (item.sermonTemplate === 'point' || (!item.sermonTemplate && item.presetId === 'wotbc-sermon'));

// Stable outline keys keep translated points linked independently of their words.
function outlineRows(text = '', spans = []) {
  const rows = []; let offset = 0, parent = '';
  for (const line of text.split('\n')) {
    const main = line.match(/^((?:[IVXLCDM]+|\d+)[.)])\s+/u);
    const sub = main ? null : line.match(/^\s*([A-Za-zА-Яа-я]+[.)])\s+/u);
    if (main) parent = main[1].replace(/[.)]$/, '');
    if (!main && !sub && rows.length) rows[rows.length - 1].text += '\n' + line;
    else if (line.trim()) rows.push({key: main ? parent : sub ? `${parent}/${sub[1].replace(/[.)]$/, '').toUpperCase().replace(/[А-Я]/g, letter => String.fromCharCode(65 + letter.charCodeAt(0) - 1040))}` : `text-${rows.length}`, text:line, start:offset});
    offset += line.length + 1;
  }
  return rows.map(row => ({...row, spans:spans.filter(s=>s.start<row.start+row.text.length && s.end>row.start)
    .map(s=>({...s,start:Math.max(s.start-row.start,0),end:Math.min(s.end-row.start,row.text.length)}))}));
}
function joinRows(rows) {
  let text = ''; const spans = [];
  for (const row of rows) {
    if (text) text += '\n';
    const offset = text.length; text += row.text;
    spans.push(...row.spans.map(s=>({...s,start:s.start+offset,end:s.end+offset})));
  }
  return {text,spans};
}

/** Resolve authored-language context. Display fallback is deliberately a separate step.
 * @returns {Record<string, any>}
 */
function resolveSermonContext(project) {
  const entries = {}; let state = fresh();
  function fresh() { return {titles:{}, titleSpans:{}, outlines:{}, headings:{}, rawOutlines:{}}; }
  function visit(id) {
    const item = project.items[id];
    if (item.kind === 'group') {
      if (item.groupKind === 'sermon') { const outer=state; state=fresh(); item.childIds.forEach(visit); state=outer; }
      else item.childIds.forEach(visit);
      return;
    }
    if (item.kind === 'song' || item.presetId === 'wotbc-reading-title' || (item.kind === 'bible' && !['wotbc-sermon-scripture','wotbc-sermon-verse'].includes(item.presetId))) state=fresh();
    if (isTitle(item)) {
      state=fresh();
      for (const channel of project.channelIds) {
        state.titles[channel]=item.titlesByChannel?.[channel] || (!item.sermonTemplate ? item.textByChannel?.[channel]?.split('\n')[0] : '') || '';
        state.titleSpans[channel]=item.titleSpansByChannel?.[channel] || [];
        state.headings[channel]=state.titles[channel];
      }
    }
    const resolved = {...item, titlesByChannel:{...item.titlesByChannel}, titleSpansByChannel:{...item.titleSpansByChannel}, textByChannel:{...item.textByChannel}, spansByChannel:{...item.spansByChannel}};
    const inheritance = {}, complete = {};
    const point = isPoint(item);
    const rawRows = Object.fromEntries(project.channelIds.map(channel=>[channel,outlineRows(item.textByChannel?.[channel],item.spansByChannel?.[channel])]));
    const expected = [...new Set(project.channelIds.flatMap(channel=>rawRows[channel].map(row=>row.key)))];
    if (point && !expected.length) expected.push(...new Set(project.channelIds.flatMap(channel=>(state.outlines[channel] || []).map(row=>row.key))));
    for (const channel of project.channelIds) {
      const previous = state.outlines[channel] || [], previousRaw = state.rawOutlines[channel] || [];
      const heading = point ? state.titles[channel] : state.headings[channel];
      const ownHeading = item.titlesByChannel?.[channel];
      const inferredKeys = expected.filter(key => {
        const own = rawRows[channel].find(row=>row.key===key);
        return !own || previousRaw.some(row=>row.key===key && row.text===own.text);
      });
      const config = item.sermonInheritance?.[channel] || {heading:!ownHeading || ownHeading===heading, pointKeys:inferredKeys};
      inheritance[channel]=config;
      if (!isTitle(item) && item.kind==='sermon' && item.sermonTemplate!=='other' && config.heading) {
        if (heading) resolved.titlesByChannel[channel]=heading; else delete resolved.titlesByChannel[channel];
        // Point headings inherit the sermon title's emphasis; contextual point labels do not.
        if (heading) resolved.titleSpansByChannel[channel]=point ? state.titleSpans[channel] || [] : [];
        else delete resolved.titleSpansByChannel[channel];
      }
      if (point) {
        const keys = [...new Set([...expected, ...rawRows[channel].map(row=>row.key)])];
        const rows = keys.map(key=>config.pointKeys.includes(key) ? previous.find(row=>row.key===key) || rawRows[channel].find(row=>row.key===key) : rawRows[channel].find(row=>row.key===key)).filter(Boolean);
        const joined=joinRows(rows);
        resolved.textByChannel[channel]=joined.text; resolved.spansByChannel[channel]=joined.spans;
        complete[channel]=Boolean(rows.length) && expected.every(key=>rows.some(row=>row.key===key));
        state.outlines[channel]=rows; state.rawOutlines[channel]=rawRows[channel];
        state.headings[channel]=rows.at(-1)?.text.trim() || state.headings[channel] || state.titles[channel] || '';
      } else if (item.sermonTemplate==='quote') complete[channel]=Boolean(item.textByChannel?.[channel]?.trim());
    }
    for (const field of ['titlesByChannel','titleSpansByChannel']) if (!Object.keys(resolved[field]).length) delete resolved[field];
    entries[id]={item:resolved, inheritance, complete, headings:{...state.headings}};
  }
  project.rootItemIds.forEach(visit);
  return entries;
}

// Capture inferred links before editing an earlier slide, so old copied text is
// not mistaken for a deliberate override when that earlier wording changes.
function captureSermonInheritance(project) {
  const next=JSON.parse(JSON.stringify(project)), context=resolveSermonContext(project);
  for (const item of Object.values(next.items)) if (item.kind==='sermon' && ['point','quote'].includes(item.sermonTemplate)) item.sermonInheritance=JSON.parse(JSON.stringify(context[item.id].inheritance));
  return next;
}
module.exports={resolveSermonContext,captureSermonInheritance,outlineRows,isPoint};
