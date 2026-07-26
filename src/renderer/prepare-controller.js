/**
 * SyncShow Prepare workspace.
 *
 * The renderer never edits a project object directly. Every mutation goes
 * through the main process with the revision that was opened, then replaces
 * the local view with the newly validated revision returned by main.
 */
(function exposePrepareController() {
  'use strict';

  const PROJECT_PAGE_SIZE = 100;
  const SONG_PAGE_SIZE = 100;
  const SEARCH_DELAY_MS = 220;
  const MAX_EDITABLE_EMPHASIS_SPANS = 256;

  const KIND_LABELS = Object.freeze({
    group: 'Section',
    song: 'Song',
    bible: 'Bible',
    sermon: 'Sermon',
    notice: 'Notice',
    picture: 'Picture',
    blank: 'Blank',
    'imported-deck': 'Slides'
  });

  function byId(id) {
    return document.getElementById(id);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function emphasisError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function splitsSurrogatePair(value, offset) {
    if (offset <= 0 || offset >= value.length) return false;
    const previous = value.charCodeAt(offset - 1);
    const current = value.charCodeAt(offset);
    return previous >= 0xD800
      && previous <= 0xDBFF
      && current >= 0xDC00
      && current <= 0xDFFF;
  }

  function normalizeEditableEmphasisRanges(rawRanges, text) {
    if (!Array.isArray(rawRanges) || rawRanges.length > MAX_EDITABLE_EMPHASIS_SPANS) {
      throw emphasisError(
        'INVALID_EMPHASIS_RANGES',
        `A body can have at most ${MAX_EDITABLE_EMPHASIS_SPANS} emphasized phrases.`
      );
    }
    const value = String(text || '');
    const normalized = [];
    let previousEnd = 0;
    for (const range of rawRanges) {
      if (!range
        || typeof range !== 'object'
        || Array.isArray(range)
        || !Number.isSafeInteger(range.start)
        || !Number.isSafeInteger(range.end)
        || range.start < previousEnd
        || range.end <= range.start
        || range.end > value.length
        || splitsSurrogatePair(value, range.start)
        || splitsSurrogatePair(value, range.end)) {
        throw emphasisError(
          'INVALID_EMPHASIS_RANGES',
          'One emphasized phrase no longer lines up with this body text.'
        );
      }
      normalized.push({
        start: range.start,
        end: range.end,
        gold: range.gold === true
      });
      previousEnd = range.end;
    }
    return normalized;
  }

  function addGoldEmphasisRange(rawRanges, rawText, selectionStart, selectionEnd) {
    const source = String(rawText || '');
    if (!Number.isSafeInteger(selectionStart)
      || !Number.isSafeInteger(selectionEnd)
      || selectionStart < 0
      || selectionEnd > source.length
      || selectionEnd <= selectionStart) {
      throw emphasisError(
        'EMPHASIS_SELECTION_REQUIRED',
        'Select the words you want to show in gold first.'
      );
    }

    let rawStart = selectionStart;
    let rawEnd = selectionEnd;
    while (rawStart < rawEnd && /\s/u.test(source[rawStart])) rawStart += 1;
    while (rawEnd > rawStart && /\s/u.test(source[rawEnd - 1])) rawEnd -= 1;
    if (rawEnd <= rawStart) {
      throw emphasisError(
        'EMPHASIS_SELECTION_REQUIRED',
        'Select words, not only spaces or line breaks.'
      );
    }

    const text = source.trim();
    const leadingTrim = source.length - source.trimStart().length;
    const trailingBoundary = leadingTrim + text.length;
    if (rawStart < leadingTrim || rawEnd > trailingBoundary) {
      throw emphasisError(
        'EMPHASIS_SELECTION_REQUIRED',
        'Select words inside the projected body.'
      );
    }
    const start = rawStart - leadingTrim;
    const end = rawEnd - leadingTrim;
    if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) {
      throw emphasisError(
        'INVALID_EMPHASIS_SELECTION',
        'Select the complete character, then try Gold emphasis again.'
      );
    }

    const ranges = normalizeEditableEmphasisRanges(rawRanges, text);
    if (ranges.length >= MAX_EDITABLE_EMPHASIS_SPANS) {
      throw emphasisError(
        'TOO_MANY_EMPHASIS_RANGES',
        `A body can have at most ${MAX_EDITABLE_EMPHASIS_SPANS} emphasized phrases.`
      );
    }
    if (ranges.some(range => start < range.end && end > range.start)) {
      throw emphasisError(
        'OVERLAPPING_EMPHASIS',
        'That selection overlaps an emphasized phrase. Remove its chip first.'
      );
    }
    const addedRange = { start, end, gold: true };
    ranges.push(addedRange);
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    return {
      text,
      ranges,
      addedRange
    };
  }

  function emphasisSnippet(text, range, maximum = 70) {
    const snippet = String(text || '')
      .slice(range?.start, range?.end)
      .replace(/\s+/gu, ' ')
      .trim();
    if (snippet.length <= maximum) return snippet;
    return `${snippet.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
  }

  function appendOption(select, value, label, data = {}) {
    const option = createElement('option', '', label);
    option.value = value;
    for (const [key, item] of Object.entries(data)) option.dataset[key] = item;
    select.appendChild(option);
    return option;
  }

  function localIsoDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return 'No service date';
    const [year, month, day] = value.split('-').map(Number);
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }).format(new Date(year, month - 1, day, 12));
    } catch (_error) {
      return value;
    }
  }

  function formatUpdatedAt(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(value));
    } catch (_error) {
      return '';
    }
  }

  function localDateTimeValue(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '';
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  }

  function communityPublishAtIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function communitySongStatusKey(songState) {
    if (songState?.pendingVisibility) return 'pending';
    return String(
      songState?.syncState
      || songState?.status
      || songState?.state
      || songState?.remote?.status
      || ''
    ).trim().toLowerCase();
  }

  function communitySongHasConflict(songState) {
    if (Boolean(songState?.conflict) || songState?.hasConflict === true) return true;
    return ['conflict', 'diverged', 'needs-review'].includes(communitySongStatusKey(songState));
  }

  function communityVisibilityOf(songState) {
    const visibility = songState?.visibility || songState?.remote?.visibility;
    return ['private', 'public', 'scheduled-public'].includes(visibility)
      ? visibility
      : 'private';
  }

  function communitySyncVersionOf(songState) {
    const value = songState?.syncVersion ?? songState?.remote?.syncVersion;
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && value.trim()) return value.trim();
    return null;
  }

  function communitySongSummaryState(summary) {
    const songState = summary?.community || summary?.communitySync || summary?.remoteSync;
    if (!songState || typeof songState !== 'object') return null;
    if (communitySongHasConflict(songState)) {
      return { kind: 'conflict', label: 'Community conflict' };
    }
    if (songState.archived === true) {
      return { kind: 'pending', label: 'Community archived' };
    }
    const status = communitySongStatusKey(songState);
    if (['pending', 'dirty', 'local-newer', 'remote-newer'].includes(status)) {
      return { kind: 'pending', label: 'Community update pending' };
    }
    if (['synced', 'current', 'ready'].includes(status) || songState.synced === true) {
      const visibility = communityVisibilityOf(songState);
      return {
        kind: 'synced',
        label: visibility === 'public'
          ? 'Community public'
          : visibility === 'scheduled-public'
            ? 'Community scheduled'
            : 'Community private'
      };
    }
    return null;
  }

  function collectionItems(payload, keys) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    for (const key of keys) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    if (payload.data && typeof payload.data === 'object') {
      return collectionItems(payload.data, keys);
    }
    return [];
  }

  function collectionTotal(payload, fallback) {
    const direct = Number(payload?.total);
    if (Number.isSafeInteger(direct) && direct >= 0) return direct;
    const nested = Number(payload?.data?.total);
    if (Number.isSafeInteger(nested) && nested >= 0) return nested;
    return fallback;
  }

  function collectionNextOffset(payload) {
    const value = payload?.nextOffset !== undefined
      ? payload.nextOffset
      : payload?.data?.nextOffset;
    if (value === null || value === undefined) return null;
    const nextOffset = Number(value);
    return Number.isSafeInteger(nextOffset) && nextOffset >= 0 ? nextOffset : null;
  }

  function checkedResult(result) {
    if (result?.success === false) {
      const details = result.error && typeof result.error === 'object' ? result.error : null;
      const message = details?.message
        || (typeof result.error === 'string' ? result.error : '')
        || result.message
        || 'The operation could not be completed.';
      const error = new Error(message);
      error.code = details?.code || result.code;
      throw error;
    }
    if (result?.data && typeof result.data === 'object' && !result.project) return result.data;
    return result;
  }

  function errorMessage(error, fallback) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return message || fallback;
  }

  function isProjectConflict(error, message = '') {
    return error?.code === 'PROJECT_CONFLICT'
      || /changed since it was opened|reload it before/i.test(message);
  }

  function projectIdOf(summary) {
    return String(summary?.projectId || summary?.id || '');
  }

  function songIdOf(summary) {
    return String(summary?.songId || summary?.id || '');
  }

  function songRevisionOf(summary) {
    return String(summary?.songRevisionId || summary?.revisionId || summary?.currentRevisionId || summary?.revision || '');
  }

  function mergeSongSummaries(existing, incoming) {
    const merged = [];
    const indexById = new Map();
    for (const summary of [...(existing || []), ...(incoming || [])]) {
      const songId = songIdOf(summary);
      if (!songId) continue;
      const existingIndex = indexById.get(songId);
      if (existingIndex === undefined) {
        indexById.set(songId, merged.length);
        merged.push(summary);
      } else {
        merged[existingIndex] = summary;
      }
    }
    return merged;
  }

  function groupSongSummaries(summaries) {
    const groups = [];
    const groupsByFamilyId = new Map();
    for (const summary of Array.isArray(summaries) ? summaries : []) {
      const songId = songIdOf(summary);
      if (!songId) continue;
      const familyId = String(summary?.translationOf || songId);
      let group = groupsByFamilyId.get(familyId);
      if (!group) {
        group = {
          familyId,
          original: null,
          translations: [],
          versions: []
        };
        groupsByFamilyId.set(familyId, group);
        groups.push(group);
      }
      if (!summary?.translationOf && songId === familyId) {
        group.original = summary;
      } else {
        group.translations.push(summary);
      }
      group.versions.push(summary);
    }
    for (const group of groups) {
      group.translations.sort((left, right) =>
        String(left?.language || '').localeCompare(String(right?.language || ''), 'en', { sensitivity: 'base' })
        || String(left?.title || '').localeCompare(String(right?.title || ''), 'en', { sensitivity: 'base' })
        || songIdOf(left).localeCompare(songIdOf(right)));
      group.versions = [
        ...(group.original ? [group.original] : []),
        ...group.translations
      ];
    }
    return groups;
  }

  function songFamilyRelationship(family, options = {}) {
    const translationCount = Array.isArray(family?.translations)
      ? family.translations.length
      : 0;
    if (!family?.original) {
      return `${translationCount === 1 ? 'Translation' : 'Translations'} · original not loaded in this view`;
    }
    if (options.complete === true) {
      return translationCount === 0
        ? 'Original · no translations yet'
        : `Original · ${translationCount} ${translationCount === 1 ? 'translation' : 'translations'}`;
    }
    if (translationCount > 0) {
      const scope = options.searching === true ? 'matching this search' : 'loaded';
      return `Original · ${translationCount} ${translationCount === 1 ? 'translation' : 'translations'} ${scope}`;
    }
    return options.searching === true
      ? 'Original · other translations may be outside this search'
      : 'Original · load more to check translations';
  }

  function canApplySongLibraryPage(request, state) {
    return Boolean(
      request
      && state
      && request.id === state.songRequest
      && request.query === state.songQuery
      && (!request.append || request.offset === state.songNextOffset)
    );
  }

  function applySongLibraryPage(state, request, payload) {
    if (!canApplySongLibraryPage(request, state)) return false;
    const page = collectionItems(payload, ['items', 'songs']);
    state.songs = request.append
      ? mergeSongSummaries(state.songs, page)
      : mergeSongSummaries([], page);
    state.songTotal = Math.max(collectionTotal(payload, state.songs.length), state.songs.length);
    const nextOffset = collectionNextOffset(payload);
    state.songNextOffset = nextOffset !== null && nextOffset > request.offset
      ? nextOffset
      : null;
    return true;
  }

  function summarizeSongImport(result) {
    const rawSummary = result?.summary && typeof result.summary === 'object'
      ? result.summary
      : {};
    const count = key => {
      const value = Number(rawSummary[key]);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    const added = count('added');
    const unchanged = count('unchanged');
    const forked = count('forked');
    const failed = count('failed');
    const succeeded = added + unchanged + forked;
    const failedFiles = Array.isArray(result?.files)
      ? result.files
        .filter(file => file?.status === 'failed' && file.fileName)
        .map(file => String(file.fileName))
      : [];
    const shownFailures = failedFiles.slice(0, 3);
    const remainingFailures = Math.max(0, failedFiles.length - shownFailures.length);
    const failureDetail = shownFailures.length > 0
      ? ` Failed: ${shownFailures.join(', ')}${remainingFailures > 0 ? `, and ${remainingFailures} more` : ''}.`
      : '';
    return {
      kind: failed > 0 ? (succeeded > 0 ? 'warning' : 'error') : 'success',
      message: `Song import finished: ${added} added, ${forked} saved as new copies, ${unchanged} unchanged, ${failed} failed.${failureDetail}`,
      counts: { added, unchanged, forked, failed }
    };
  }

  function flattenProject(project, collapsedGroupIds = null) {
    if (!project || typeof project !== 'object') return [];
    const items = project.items && typeof project.items === 'object' ? project.items : {};
    const rows = [];
    const visiting = new Set();

    function visit(itemId, parentId, depth, parentTitles, siblings) {
      if (visiting.has(itemId) || !items[itemId]) return;
      visiting.add(itemId);
      const item = items[itemId];
      const index = siblings.indexOf(itemId);
      rows.push({
        item,
        parentId,
        depth,
        parentTitles,
        index,
        siblingCount: siblings.length
      });
      if (item.kind === 'group'
        && Array.isArray(item.childIds)
        && !collapsedGroupIds?.has(item.id)) {
        const nextTitles = [...parentTitles, item.title];
        for (const childId of item.childIds) {
          visit(childId, item.id, depth + 1, nextTitles, item.childIds);
        }
      }
      visiting.delete(itemId);
    }

    const roots = Array.isArray(project.rootItemIds) ? project.rootItemIds : [];
    for (const itemId of roots) visit(itemId, null, 0, [], roots);
    return rows;
  }

  function countDescendants(project, itemId) {
    const items = project?.items && typeof project.items === 'object' ? project.items : {};
    const seen = new Set();
    const visit = currentId => {
      const item = items[currentId];
      if (!item || seen.has(currentId)) return;
      seen.add(currentId);
      if (item.kind === 'group' && Array.isArray(item.childIds)) item.childIds.forEach(visit);
    };
    const root = items[itemId];
    if (root?.kind === 'group' && Array.isArray(root.childIds)) root.childIds.forEach(visit);
    return seen.size;
  }

  function describeItem(item) {
    if (!item) return '';
    if (item.kind === 'song') {
      const arrangementCount = Array.isArray(item.arrangement) ? item.arrangement.length : 0;
      return `${arrangementCount} ${arrangementCount === 1 ? 'section' : 'sections'} in the arrangement`;
    }
    if (item.kind === 'group') {
      const count = Array.isArray(item.childIds) ? item.childIds.length : 0;
      return `${count} ${count === 1 ? 'item' : 'items'} inside`;
    }
    if (item.kind === 'picture') return item.altText || 'Full-screen picture';
    if (item.kind === 'sermon' || item.kind === 'notice') {
      const channelCount = item.textByChannel ? Object.keys(item.textByChannel).length : 0;
      return `${channelCount} ${channelCount === 1 ? 'output version' : 'output versions'}`;
    }
    if (item.kind === 'bible') return 'Prepared Bible passage';
    if (item.kind === 'imported-deck') {
      const count = Array.isArray(item.slides) ? item.slides.length : 0;
      return `${count} imported ${count === 1 ? 'slide' : 'slides'}`;
    }
    if (item.kind === 'blank') return 'Black screen';
    return KIND_LABELS[item.kind] || 'Service item';
  }

  function authoritativeSongForItem(project, item) {
    if (!project || item?.kind !== 'song') return null;
    const channelIds = Array.isArray(project.channelIds) ? project.channelIds : [];
    const contentForChannel = channelId => {
      const variant = item.variants?.[channelId];
      if (variant?.mode !== 'content') return null;
      const resource = project.resources?.[variant.resourceId];
      return resource?.kind === 'song' && resource.document
        ? { channelId, document: resource.document }
        : null;
    };
    if (item.primaryChannelId) {
      const persisted = contentForChannel(item.primaryChannelId);
      if (persisted) return persisted;
    }

    const dependencyCounts = new Map();
    for (const channelId of channelIds) {
      let currentChannelId = channelId;
      const visited = new Set();
      while (!visited.has(currentChannelId)) {
        visited.add(currentChannelId);
        const variant = item.variants?.[currentChannelId];
        if (!variant || variant.mode === 'hidden') break;
        if (variant.mode === 'content') {
          dependencyCounts.set(
            currentChannelId,
            (dependencyCounts.get(currentChannelId) || 0) + 1
          );
          break;
        }
        currentChannelId = variant.from;
      }
    }

    const candidates = channelIds
      .map((channelId, channelIndex) => {
        const content = contentForChannel(channelId);
        return content
          ? {
              ...content,
              channelIndex,
              dependencyCount: dependencyCounts.get(channelId) || 0
            }
          : null;
      })
      .filter(Boolean);
    const documentIds = new Set(candidates.map(candidate => candidate.document.id));
    candidates.sort((left, right) => {
      const leftIsOriginal = left.document.translationOf ? 0 : 1;
      const rightIsOriginal = right.document.translationOf ? 0 : 1;
      if (leftIsOriginal !== rightIsOriginal) return rightIsOriginal - leftIsOriginal;
      const leftIsRelationshipRoot = candidates.some(candidate =>
        candidate.document.translationOf === left.document.id) ? 1 : 0;
      const rightIsRelationshipRoot = candidates.some(candidate =>
        candidate.document.translationOf === right.document.id) ? 1 : 0;
      if (leftIsRelationshipRoot !== rightIsRelationshipRoot) {
        return rightIsRelationshipRoot - leftIsRelationshipRoot;
      }
      const leftTargetsMissingRoot = left.document.translationOf
        && !documentIds.has(left.document.translationOf) ? 1 : 0;
      const rightTargetsMissingRoot = right.document.translationOf
        && !documentIds.has(right.document.translationOf) ? 1 : 0;
      if (leftTargetsMissingRoot !== rightTargetsMissingRoot) {
        return leftTargetsMissingRoot - rightTargetsMissingRoot;
      }
      if (left.dependencyCount !== right.dependencyCount) {
        return right.dependencyCount - left.dependencyCount;
      }
      return left.channelIndex - right.channelIndex;
    });
    return candidates[0]
      ? { channelId: candidates[0].channelId, document: candidates[0].document }
      : null;
  }

  function sectionForId(song, sectionId) {
    return song?.sections?.find(section => section.id === sectionId) || null;
  }

  function parentSiblings(project, parentId) {
    if (!project) return [];
    if (!parentId) return Array.isArray(project.rootItemIds) ? project.rootItemIds : [];
    const parent = project.items?.[parentId];
    return parent?.kind === 'group' && Array.isArray(parent.childIds) ? parent.childIds : [];
  }

  function indentDestination(project, row) {
    if (!project || !row || row.index <= 0) return null;
    const siblings = parentSiblings(project, row.parentId);
    const previous = project.items?.[siblings[row.index - 1]];
    if (previous?.kind !== 'group') return null;
    return {
      targetParentId: previous.id,
      targetIndex: Array.isArray(previous.childIds) ? previous.childIds.length : 0
    };
  }

  function outdentDestination(project, row) {
    if (!project || !row?.parentId) return null;
    const parentRow = flattenProject(project).find(candidate => candidate.item.id === row.parentId);
    if (!parentRow) return null;
    return {
      targetParentId: parentRow.parentId,
      targetIndex: parentRow.index + 1
    };
  }

  function reorderDestination(project, sourceItemId, targetItemId, placement = 'before') {
    if (!project || sourceItemId === targetItemId || !['before', 'after'].includes(placement)) return null;
    const rows = flattenProject(project);
    const source = rows.find(row => row.item.id === sourceItemId);
    const target = rows.find(row => row.item.id === targetItemId);
    if (!source || !target) return null;
    let candidateParentId = target.parentId;
    while (candidateParentId) {
      if (candidateParentId === sourceItemId) return null;
      candidateParentId = rows.find(row => row.item.id === candidateParentId)?.parentId || null;
    }
    let targetIndex = target.index + (placement === 'after' ? 1 : 0);
    if (source.parentId === target.parentId && source.index < targetIndex) targetIndex -= 1;
    if (source.parentId === target.parentId && source.index === targetIndex) return null;
    return {
      targetParentId: target.parentId,
      targetIndex
    };
  }

  function songLyricsSource(song) {
    if (!song || !Array.isArray(song.sections)) return '^1\n';
    const lines = [];
    for (const [sectionIndex, section] of song.sections.entries()) {
      if (sectionIndex > 0) lines.push('');
      lines.push(`^${section.marker || section.id}`);
      for (const [slideIndex, slide] of (section.slides || []).entries()) {
        if (slideIndex > 0) lines.push('---');
        for (const rawLine of slide.lines || []) {
          const line = String(rawLine);
          lines.push(line.startsWith('^') ? `^${line}` : line);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  function splitCommaList(value) {
    return String(value || '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
  }

  function songCreditSummary(song) {
    if (!song) return '';
    return [
      song.authors?.length ? `Words: ${song.authors.join(', ')}` : '',
      song.translators?.length ? `Translation: ${song.translators.join(', ')}` : '',
      song.composers?.length ? `Music: ${song.composers.join(', ')}` : ''
    ].filter(Boolean).join(' · ');
  }

  function sourceScalar(value) {
    return JSON.stringify(String(value || ''));
  }

  function buildSongDocumentSource(fields, existingSong = null) {
    const metadata = [
      '---',
      ...(fields.songId ? [`id: ${sourceScalar(fields.songId)}`] : []),
      `title: ${sourceScalar(fields.title)}`,
      `language: ${sourceScalar(fields.language || 'und')}`
    ];
    if (fields.translationOf) metadata.push(`translationOf: ${sourceScalar(fields.translationOf)}`);
    if (fields.license) metadata.push(`license: ${sourceScalar(fields.license)}`);
    if (fields.tags?.length) metadata.push(`tags: ${JSON.stringify(fields.tags)}`);
    if (fields.authors?.length) metadata.push(`authors: ${JSON.stringify(fields.authors)}`);
    if (fields.translators?.length) metadata.push(`translators: ${JSON.stringify(fields.translators)}`);
    if (fields.composers?.length) metadata.push(`composers: ${JSON.stringify(fields.composers)}`);
    if (fields.source) metadata.push(`source: ${sourceScalar(fields.source)}`);
    if (fields.attribution) metadata.push(`attribution: ${sourceScalar(fields.attribution)}`);
    const reserved = new Set([
      'id', 'title', 'language', 'translationOf', 'license',
      'tags', 'authors', 'translators', 'composers', 'music', 'source', 'attribution'
    ]);
    for (const [key, value] of Object.entries(existingSong?.extraMetadata || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (reserved.has(key) || typeof value !== 'string') continue;
      metadata.push(`${key}: ${sourceScalar(value)}`);
    }
    metadata.push('---', '', String(fields.lyrics || '').replace(/\r\n?/g, '\n').trimEnd(), '');
    return metadata.join('\n');
  }

  function editItemDraftSnapshot(draft = {}) {
    return JSON.stringify({
      itemId: String(draft.itemId || ''),
      title: String(draft.title || ''),
      operatorNotes: String(draft.operatorNotes || ''),
      groupKind: String(draft.groupKind || ''),
      presetId: String(draft.presetId || ''),
      altText: String(draft.altText || ''),
      fit: String(draft.fit || ''),
      attribution: String(draft.attribution || ''),
      channels: (Array.isArray(draft.channels) ? draft.channels : []).map(channel => ({
        channelId: String(channel?.channelId || ''),
        title: String(channel?.title || ''),
        text: String(channel?.text || ''),
        spans: (Array.isArray(channel?.spans) ? channel.spans : []).map(span => ({
          start: Number(span?.start),
          end: Number(span?.end),
          gold: span?.gold !== false
        }))
      }))
    });
  }

  function isTextEditingTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"], dialog[open]'));
  }

  function createController(options = {}) {
    const api = options.api || window.api || {};
    const onPublished = typeof options.onPublished === 'function' ? options.onPublished : async () => {};
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};

    const elements = {
      panel: byId('preparePanel'),
      heading: byId('prepareHeading'),
      notice: byId('prepareNotice'),
      projectSearch: byId('prepareProjectSearch'),
      projectList: byId('prepareProjectList'),
      projectCount: byId('prepareProjectCount'),
      btnNewProject: byId('btnNewServiceProject'),
      btnImportProject: byId('btnImportServiceProject'),
      btnExportProject: byId('btnExportServiceProject'),
      btnPublish: byId('btnPublishServiceProject'),
      btnUndo: byId('btnUndoPrepareChange'),
      btnRedo: byId('btnRedoPrepareChange'),
      rundownHeading: byId('prepareRundownHeading'),
      projectMeta: byId('prepareProjectMeta'),
      saveState: byId('prepareSaveState'),
      rundownEmpty: byId('prepareRundownEmpty'),
      rundownList: byId('prepareRundownList'),
      inspectorHeading: byId('prepareInspectorHeading'),
      inspectorSummary: byId('prepareInspectorSummary'),
      inspectorActions: byId('prepareInspectorActions'),
      btnEdit: byId('btnEditPrepareItem'),
      btnDuplicate: byId('btnDuplicatePrepareItem'),
      btnAddInside: byId('btnAddInsidePrepareGroup'),
      btnCollapseGroup: byId('btnCollapsePrepareGroup'),
      btnMoveUp: byId('btnMovePrepareItemUp'),
      btnMoveDown: byId('btnMovePrepareItemDown'),
      btnIndent: byId('btnIndentPrepareItem'),
      btnOutdent: byId('btnOutdentPrepareItem'),
      btnRemove: byId('btnRemovePrepareItem'),
      itemPreview: byId('prepareItemPreview'),
      previewChannel: byId('preparePreviewChannel'),
      previewImage: byId('preparePreviewImage'),
      previewStatus: byId('preparePreviewStatus'),
      previewPosition: byId('preparePreviewPosition'),
      btnPreviousPreview: byId('btnPreviousPreparePreview'),
      btnNextPreview: byId('btnNextPreparePreview'),
      btnAddText: byId('btnAddServiceText'),
      btnAddPicture: byId('btnAddServicePicture'),
      btnAddGroup: byId('btnAddServiceGroup'),
      songInspector: byId('prepareSongInspector'),
      songInspectorHeading: byId('prepareSongInspectorHeading'),
      songInspectorMeta: byId('prepareSongInspectorMeta'),
      songEditor: byId('prepareSongEditor'),
      songArrangementList: byId('prepareSongArrangementList'),
      songArrangementEmpty: byId('prepareSongArrangementEmpty'),
      songArrangementSection: byId('prepareSongArrangementSection'),
      btnAddSongArrangementSection: byId('btnAddSongArrangementSection'),
      btnMoveSongArrangementUp: byId('btnMoveSongArrangementUp'),
      btnMoveSongArrangementDown: byId('btnMoveSongArrangementDown'),
      btnRemoveSongArrangementItem: byId('btnRemoveSongArrangementItem'),
      songTranslationChannel: byId('prepareSongTranslationChannel'),
      songTranslationSong: byId('prepareSongTranslationSong'),
      btnLinkSongTranslation: byId('btnLinkSongTranslation'),
      songOutputTranslations: byId('prepareSongOutputTranslations'),
      bibleDetails: byId('prepareBibleDetails'),
      bibleForm: byId('prepareBibleForm'),
      bibleReference: byId('prepareBibleReference'),
      bibleTranslation: byId('prepareBibleTranslation'),
      bibleStatus: byId('prepareBibleStatus'),
      bibleAmbiguity: byId('prepareBibleAmbiguity'),
      bibleAmbiguityChoices: byId('prepareBibleAmbiguityChoices'),
      bibleResult: byId('prepareBibleResult'),
      biblePreviewReference: byId('prepareBiblePreviewReference'),
      biblePreviewText: byId('prepareBiblePreviewText'),
      btnLookupBible: byId('btnLookupPrepareBible'),
      btnAddBible: byId('btnAddBiblePassage'),
      songSearch: byId('prepareSongSearch'),
      songList: byId('prepareSongList'),
      songCount: byId('prepareSongCount'),
      btnLoadMoreSongs: byId('btnLoadMoreSongs'),
      btnNewSong: byId('btnNewSongDocument'),
      btnImportSong: byId('btnImportSongDocument'),
      newProjectDialog: byId('newServiceProjectDialog'),
      newProjectForm: byId('newServiceProjectForm'),
      newProjectName: byId('newServiceProjectName'),
      newProjectDate: byId('newServiceProjectDate'),
      newProjectError: byId('newServiceProjectError'),
      btnCancelNewProject: byId('btnCancelNewServiceProject'),
      btnCreateProject: byId('btnCreateServiceProject'),
      groupDialog: byId('addServiceGroupDialog'),
      groupForm: byId('addServiceGroupForm'),
      groupTitle: byId('addServiceGroupTitle'),
      groupKind: byId('addServiceGroupKind'),
      groupError: byId('addServiceGroupError'),
      btnCancelGroup: byId('addServiceGroupCancel'),
      btnConfirmGroup: byId('addServiceGroupConfirm'),
      textDialog: byId('addServiceTextDialog'),
      textForm: byId('addServiceTextForm'),
      textKind: byId('addServiceTextKind'),
      textTitle: byId('addServiceTextTitleInput'),
      textBodyField: byId('addServiceTextBodyField'),
      textBody: byId('addServiceTextBody'),
      textError: byId('addServiceTextError'),
      btnCancelText: byId('btnCancelServiceText'),
      btnConfirmText: byId('btnConfirmServiceText'),
      pictureDialog: byId('addServicePictureDialog'),
      pictureForm: byId('addServicePictureForm'),
      pictureAlt: byId('addServicePictureAlt'),
      pictureAttribution: byId('addServicePictureAttribution'),
      pictureCustomizeOutputs: byId('customizeServicePictureOutputs'),
      pictureError: byId('addServicePictureError'),
      btnCancelPicture: byId('btnCancelServicePicture'),
      btnConfirmPicture: byId('btnConfirmServicePicture'),
      editItemDialog: byId('editServiceItemDialog'),
      editItemForm: byId('editServiceItemForm'),
      editItemTitle: byId('editServiceItemTitle'),
      editItemDescription: byId('editServiceItemDescription'),
      editItemNameLabel: byId('editServiceItemNameLabel'),
      editItemNameHint: byId('editServiceItemNameHint'),
      editItemName: byId('editServiceItemName'),
      editItemGroupKindField: byId('editServiceItemGroupKindField'),
      editItemGroupKind: byId('editServiceItemGroupKind'),
      editItemPresetField: byId('editServiceItemPresetField'),
      editItemPreset: byId('editServiceItemPreset'),
      editItemTextFields: byId('editServiceItemTextFields'),
      editItemChannelText: byId('editServiceItemChannelText'),
      editItemPictureOutputs: byId('editServiceItemPictureOutputs'),
      editItemPictureOutputList: byId('editServiceItemPictureOutputList'),
      editItemAltTextField: byId('editServiceItemAltTextField'),
      editItemAltText: byId('editServiceItemAltText'),
      editItemFitField: byId('editServiceItemFitField'),
      editItemFit: byId('editServiceItemFit'),
      editItemAttributionField: byId('editServiceItemAttributionField'),
      editItemAttribution: byId('editServiceItemAttribution'),
      editItemNotes: byId('editServiceItemNotes'),
      editItemError: byId('editServiceItemError'),
      btnCancelEditItem: byId('btnCancelEditServiceItem'),
      btnConfirmEditItem: byId('btnConfirmEditServiceItem'),
      songDialog: byId('songDocumentDialog'),
      songForm: byId('songDocumentForm'),
      songDialogTitle: byId('songDocumentDialogTitle'),
      songTitle: byId('songDocumentTitle'),
      songLanguage: byId('songDocumentLanguage'),
      songTranslationOf: byId('songDocumentTranslationOf'),
      songCommunityVisibility: byId('songDocumentCommunityVisibility'),
      songCommunityPublishAtField: byId('songDocumentPublishAtField'),
      songCommunityPublishAt: byId('songDocumentPublishAt'),
      songCommunityState: byId('songDocumentCommunityState'),
      btnReviewSongCommunityConflict: byId('btnReviewSongCommunityConflict'),
      songCommunityConflictDialog: byId('songCommunityConflictDialog'),
      songCommunityLocalDocuments: byId('songCommunityLocalDocuments'),
      songCommunityRemoteDocuments: byId('songCommunityRemoteDocuments'),
      songCommunityConflictStatus: byId('songCommunityConflictStatus'),
      btnCloseSongCommunityConflict: byId('btnCloseSongCommunityConflict'),
      btnKeepLocalSongConflict: byId('btnKeepLocalSongConflict'),
      btnKeepCommunitySongConflict: byId('btnKeepCommunitySongConflict'),
      songLyrics: byId('songDocumentLyrics'),
      songAuthors: byId('songDocumentAuthors'),
      songTranslators: byId('songDocumentTranslators'),
      songComposers: byId('songDocumentComposers'),
      songTags: byId('songDocumentTags'),
      songAttribution: byId('songDocumentAttribution'),
      songLicense: byId('songDocumentLicense'),
      songSource: byId('songDocumentSource'),
      songValidation: byId('songDocumentValidation'),
      songError: byId('songDocumentError'),
      btnCancelSong: byId('btnCancelSongDocument'),
      btnValidateSong: byId('btnValidateSongDocument'),
      btnSaveSong: byId('btnSaveSongDocument')
    };

    const state = {
      activated: false,
      available: false,
      projects: [],
      projectTotal: 0,
      projectQuery: '',
      projectsBusy: false,
      projectRequest: 0,
      projectTimer: null,
      songs: [],
      songTotal: 0,
      songNextOffset: null,
      songQuery: '',
      songsBusy: false,
      songsLoadingMore: false,
      songImportBusy: false,
      songRequest: 0,
      songTimer: null,
      translationCandidates: [],
      translationCandidatesBusy: false,
      translationFamilyId: null,
      translationRequest: 0,
      currentProject: null,
      revisionId: null,
      projectHistory: [],
      undoStack: [],
      redoStack: [],
      collapsedGroupIds: new Set(),
      selectedItemId: null,
      selectedArrangementId: null,
      bibleLookupBusy: false,
      bibleLookupEpoch: 0,
      preparedBible: null,
      presets: [],
      previewRequest: 0,
      previewBusy: false,
      previewChannelId: null,
      previewCueOffset: 0,
      previewResult: null,
      songEditingId: null,
      songEditingRevisionId: null,
      songEditingSong: null,
      songBaselineSource: null,
      songDraftDirty: false,
      songSaveBusy: false,
      songValidationRequest: 0,
      songCommunityRequest: 0,
      songCommunityBusy: false,
      songCommunityLoaded: false,
      songCommunityRemoteState: null,
      songCommunityExpectedSyncVersion: null,
      songCommunityBaseline: null,
      songCommunityError: null,
      songCommunityConflict: null,
      songCommunityConflictBusy: false,
      songCommunityConflictError: null,
      editItemBaselineSource: null,
      editItemDraftDirty: false,
      groupParentId: null,
      draggedItemId: null,
      mutationBusy: false,
      publishBusy: false
    };
    const editEmphasisByCard = new WeakMap();

    const requiredApi = [
      'listServiceProjects',
      'createServiceProject',
      'openServiceProject',
      'importServiceProject',
      'exportServiceProject',
      'listServiceProjectHistory',
      'restoreServiceProjectRevision',
      'listNativePresets',
      'previewServiceItem',
      'listSongLibrary',
      'readSongDocument',
      'validateSongDocument',
      'saveSongDocument',
      'listSongTranslationsForServiceItem',
      'importSongDocument',
      'addSongToService',
      'createServiceGroup',
      'updateServiceItem',
      'updatePictureOutput',
      'duplicateServiceItem',
      'updateSongArrangement',
      'linkSongTranslation',
      'resetSongTranslation',
      'addBiblePassageToService',
      'lookupBiblePassage',
      'addTextToService',
      'addPictureToService',
      'removeServiceItem',
      'moveServiceItem',
      'publishServiceProject'
    ];

    function setNotice(kind, message, { global = false } = {}) {
      elements.notice.dataset.kind = kind || '';
      elements.notice.textContent = message;
      if (global) onStatus(message);
    }

    function setDialogError(element, message) {
      element.hidden = !message;
      element.textContent = message || '';
    }

    function renderEmphasisEditor(card) {
      const editor = editEmphasisByCard.get(card);
      if (!editor) return;
      const text = editor.textarea.value.trim();
      editor.list.replaceChildren();
      editor.clearButton.disabled = editor.ranges.length < 1;
      if (editor.ranges.length < 1) {
        editor.list.appendChild(createElement(
          'span',
          'prepare-emphasis-empty',
          'No emphasized phrases.'
        ));
        return;
      }
      editor.ranges.forEach((range, index) => {
        const snippet = emphasisSnippet(text, range);
        const chip = createElement('span', 'prepare-emphasis-chip');
        chip.setAttribute('role', 'listitem');
        chip.appendChild(createElement('span', 'prepare-emphasis-swatch'));
        chip.appendChild(createElement('span', 'prepare-emphasis-snippet', `“${snippet}”`));
        const removeButton = createElement('button', 'prepare-emphasis-remove', '×');
        removeButton.type = 'button';
        removeButton.setAttribute(
          'aria-label',
          `Remove emphasis from ${snippet || 'selected phrase'}`
        );
        removeButton.title = 'Remove this emphasized phrase';
        removeButton.addEventListener('click', () => {
          editor.ranges.splice(index, 1);
          editor.dirty = true;
          markEditItemDraftDirty();
          editor.note.textContent = `Removed emphasis from “${snippet}”.`;
          editor.note.hidden = false;
          setDialogError(elements.editItemError, '');
          renderEmphasisEditor(card);
        });
        chip.appendChild(removeButton);
        editor.list.appendChild(chip);
      });
    }

    function attachEmphasisEditor(card, textarea, rawSpans, channelName) {
      const tools = createElement('div', 'prepare-emphasis-tools');
      const actions = createElement('div', 'prepare-emphasis-actions');
      const addButton = createElement('button', 'btn btn-outline btn-compact prepare-gold-emphasis', 'Gold emphasis');
      addButton.type = 'button';
      addButton.dataset.goldEmphasis = '';
      addButton.title = 'Select words in the projected body, then choose this';
      const clearButton = createElement('button', 'btn btn-quiet btn-compact', 'Clear all');
      clearButton.type = 'button';
      clearButton.dataset.clearEmphasis = '';
      actions.append(addButton, clearButton);
      const help = createElement(
        'p',
        'prepare-emphasis-help',
        'Select words in the body, then choose Gold emphasis. Editing the body clears its emphasis so it cannot move to the wrong words.'
      );
      const list = createElement('div', 'prepare-emphasis-list');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', `Emphasized phrases for ${channelName}`);
      const note = createElement('p', 'prepare-emphasis-note');
      note.setAttribute('role', 'status');
      note.setAttribute('aria-live', 'polite');
      note.hidden = true;
      tools.append(actions, help, list, note);

      let ranges = [];
      try {
        ranges = normalizeEditableEmphasisRanges(rawSpans || [], textarea.value.trim());
      } catch (_error) {
        ranges = [];
        note.textContent = 'Existing emphasis could not be matched safely. Select the phrases again.';
        note.hidden = false;
      }
      const editor = {
        textarea,
        list,
        note,
        clearButton,
        channelName,
        ranges,
        dirty: false
      };
      editEmphasisByCard.set(card, editor);

      addButton.addEventListener('click', () => {
        try {
          const result = addGoldEmphasisRange(
            editor.ranges,
            textarea.value,
            textarea.selectionStart,
            textarea.selectionEnd
          );
          editor.ranges = result.ranges;
          editor.dirty = true;
          markEditItemDraftDirty();
          const snippet = emphasisSnippet(result.text, result.addedRange);
          note.textContent = `Gold emphasis added${snippet ? ` to “${snippet}”` : ''}.`;
          note.hidden = false;
          setDialogError(elements.editItemError, '');
          renderEmphasisEditor(card);
        } catch (error) {
          setDialogError(
            elements.editItemError,
            `${channelName}: ${errorMessage(error, 'That phrase could not be emphasized.')}`
          );
        } finally {
          textarea.focus();
        }
      });

      clearButton.addEventListener('click', () => {
        if (editor.ranges.length < 1) return;
        editor.ranges = [];
        editor.dirty = true;
        markEditItemDraftDirty();
        note.textContent = `Cleared all emphasis from ${channelName}.`;
        note.hidden = false;
        setDialogError(elements.editItemError, '');
        renderEmphasisEditor(card);
      });

      textarea.addEventListener('input', () => {
        if (editor.ranges.length < 1) return;
        editor.ranges = [];
        editor.dirty = true;
        note.textContent = 'Emphasis was cleared because this body changed. Select the phrases again.';
        note.hidden = false;
        renderEmphasisEditor(card);
      });

      renderEmphasisEditor(card);
      return tools;
    }

    function currentRows() {
      return flattenProject(state.currentProject, state.collapsedGroupIds);
    }

    function selectedRow() {
      return currentRows().find(row => row.item.id === state.selectedItemId) || null;
    }

    function updateControlStates() {
      const projectOpen = Boolean(state.currentProject && state.revisionId);
      const locked = state.mutationBusy || state.publishBusy;
      const hasProjectedItems = flattenProject(state.currentProject).some(row => row.item.kind !== 'group');

      elements.btnNewProject.disabled = locked || !state.available;
      elements.btnImportProject.disabled = locked || !state.available;
      elements.btnExportProject.disabled = !projectOpen || locked;
      elements.btnUndo.disabled = !projectOpen || locked || state.undoStack.length < 1;
      elements.btnRedo.disabled = !projectOpen || locked || state.redoStack.length < 1;
      elements.btnPublish.disabled = !projectOpen || !hasProjectedItems || locked;
      elements.btnPublish.textContent = state.publishBusy ? 'Preparing slides…' : 'Save & go to Load';
      elements.btnAddText.disabled = !projectOpen || locked;
      elements.btnAddPicture.disabled = !projectOpen || locked;
      elements.btnAddGroup.disabled = !projectOpen || locked;
      elements.btnNewSong.disabled = !state.available || locked;
      elements.btnImportSong.disabled = !state.available || locked;
      elements.btnImportSong.textContent = state.songImportBusy ? 'Importing…' : 'Import files';
      elements.btnLoadMoreSongs.disabled = !state.available
        || locked
        || state.songsBusy
        || state.songsLoadingMore
        || state.songNextOffset === null;
      elements.songSearch.disabled = !state.available;
      elements.projectSearch.disabled = !state.available;
      elements.bibleReference.disabled = !projectOpen || locked || state.bibleLookupBusy;
      elements.bibleTranslation.disabled = !projectOpen || locked || state.bibleLookupBusy;
      elements.btnLookupBible.disabled = !projectOpen
        || locked
        || state.bibleLookupBusy
        || !elements.bibleReference.value.trim();
      elements.btnLookupBible.textContent = state.bibleLookupBusy ? 'Finding…' : 'Find';
      elements.btnAddBible.disabled = !projectOpen || locked || state.bibleLookupBusy || !state.preparedBible;

      const row = selectedRow();
      elements.inspectorActions.hidden = !row;
      elements.btnMoveUp.disabled = !row || row.index <= 0 || locked;
      elements.btnMoveDown.disabled = !row || row.index >= row.siblingCount - 1 || locked;
      elements.btnIndent.disabled = !indentDestination(state.currentProject, row) || locked;
      elements.btnOutdent.disabled = !outdentDestination(state.currentProject, row) || locked;
      elements.btnRemove.disabled = !row || locked;
      elements.btnEdit.disabled = !row || locked || row.item.kind === 'imported-deck';
      elements.btnDuplicate.disabled = !row || locked || row.item.kind === 'imported-deck';
      elements.btnAddInside.hidden = row?.item?.kind !== 'group';
      elements.btnAddInside.disabled = !row || row.item.kind !== 'group' || locked;
      elements.btnCollapseGroup.hidden = row?.item?.kind !== 'group';
      elements.btnCollapseGroup.disabled = !row || row.item.kind !== 'group' || locked;
      elements.btnCollapseGroup.textContent = row?.item?.kind === 'group'
        && state.collapsedGroupIds.has(row.item.id)
        ? 'Expand'
        : 'Collapse';
      elements.previewChannel.disabled = !row || row.item.kind === 'group' || locked || state.previewBusy;
      elements.btnPreviousPreview.disabled = state.previewBusy
        || !state.previewResult
        || state.previewCueOffset <= 0;
      elements.btnNextPreview.disabled = state.previewBusy
        || !state.previewResult
        || state.previewCueOffset >= (state.previewResult.cueCount || 1) - 1;

      const song = row?.item?.kind === 'song'
        ? authoritativeSongForItem(state.currentProject, row.item)?.document
        : null;
      const arrangement = row?.item?.kind === 'song' && Array.isArray(row.item.arrangement)
        ? row.item.arrangement
        : [];
      const arrangementIndex = arrangement.findIndex(entry => entry.id === state.selectedArrangementId);
      elements.songArrangementSection.disabled = !song || locked;
      elements.btnAddSongArrangementSection.disabled = !song
        || locked
        || !elements.songArrangementSection.value;
      elements.btnMoveSongArrangementUp.disabled = arrangementIndex <= 0 || locked;
      elements.btnMoveSongArrangementDown.disabled = arrangementIndex < 0
        || arrangementIndex >= arrangement.length - 1
        || locked;
      elements.btnRemoveSongArrangementItem.disabled = arrangementIndex < 0
        || arrangement.length <= 1
        || locked;
      elements.songTranslationChannel.disabled = !song || locked || state.translationCandidatesBusy;
      elements.songTranslationSong.disabled = !song || locked || state.translationCandidatesBusy;
      elements.btnLinkSongTranslation.disabled = !song
        || locked
        || state.translationCandidatesBusy
        || !elements.songTranslationChannel.value
        || !elements.songTranslationSong.selectedOptions[0]?.dataset.songId;

      elements.saveState.textContent = locked ? 'Saving…' : (projectOpen ? 'Autosaved' : 'Local');
      elements.saveState.classList.toggle('is-saving', locked);
    }

    function renderProjectList() {
      elements.projectCount.textContent = String(state.projectTotal);
      elements.projectList.replaceChildren();

      if (state.projectsBusy) {
        elements.projectList.append(createElement('p', 'prepare-list-message', 'Loading service projects…'));
        return;
      }
      if (state.projects.length === 0) {
        elements.projectList.append(createElement(
          'p',
          'prepare-list-message',
          state.projectQuery ? 'No services match that search.' : 'No service projects yet. Create the first one above.'
        ));
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const summary of state.projects) {
        const projectId = projectIdOf(summary);
        if (!projectId) continue;
        const listItem = createElement('div');
        listItem.setAttribute('role', 'listitem');
        const button = createElement('button', 'prepare-project-button');
        button.type = 'button';
        button.dataset.projectId = projectId;
        if (projectId === state.currentProject?.id) button.setAttribute('aria-current', 'true');
        const title = createElement('strong', '', summary.title || 'Untitled service');
        const details = [
          formatDate(summary.serviceDate),
          Number.isSafeInteger(summary.itemCount) ? `${summary.itemCount} items` : '',
          formatUpdatedAt(summary.updatedAt)
        ].filter(Boolean).join(' · ');
        button.append(title, createElement('span', '', details));
        button.addEventListener('click', () => openProject(projectId));
        listItem.appendChild(button);
        fragment.appendChild(listItem);
      }
      elements.projectList.appendChild(fragment);
    }

    function renderSongList() {
      elements.songList.replaceChildren();
      elements.songList.setAttribute(
        'aria-busy',
        state.songsBusy || state.songsLoadingMore ? 'true' : 'false'
      );
      elements.btnLoadMoreSongs.hidden = state.songsBusy || state.songNextOffset === null;
      elements.btnLoadMoreSongs.textContent = state.songsLoadingMore ? 'Loading more…' : 'Load more songs';
      if (state.songsBusy) {
        elements.songCount.textContent = 'Loading songs…';
        elements.songList.append(createElement('p', 'prepare-list-message', 'Loading song library…'));
        return;
      }
      const shown = state.songs.length;
      const total = Math.max(state.songTotal, shown);
      if (state.songs.length === 0) {
        elements.songCount.textContent = '0 families · 0 versions';
        elements.songList.append(createElement(
          'p',
          'prepare-list-message',
          state.songQuery
            ? 'No songs match that search.'
            : 'Import one or more Markdown or text song files to start this library.'
        ));
        return;
      }

      const families = groupSongSummaries(state.songs);
      const loadedAll = state.songNextOffset === null && shown >= total;
      const completeFamilyView = loadedAll && !state.songQuery;
      const fragment = document.createDocumentFragment();
      for (const [familyIndex, family] of families.entries()) {
        const anchor = family.original || family.translations[0];
        if (!anchor) continue;
        const familyTitle = family.original?.title || anchor.title || family.familyId;
        const familyCard = createElement('section', 'prepare-song-family');
        familyCard.setAttribute('role', 'listitem');

        const familyHeading = createElement('div', 'prepare-song-family-heading');
        const familyCopy = createElement('div', 'prepare-song-family-copy');
        const familyTitleElement = createElement('h4', '', familyTitle);
        familyTitleElement.id = `prepare-song-family-${familyIndex + 1}`;
        familyCard.setAttribute('aria-labelledby', familyTitleElement.id);
        const relationship = songFamilyRelationship(family, {
          complete: completeFamilyView,
          searching: Boolean(state.songQuery)
        });
        familyCopy.append(
          familyTitleElement,
          createElement('small', '', relationship)
        );
        const translateButton = createElement('button', 'btn btn-quiet btn-compact', '+ Translation');
        translateButton.type = 'button';
        translateButton.disabled = state.mutationBusy || state.publishBusy;
        translateButton.setAttribute('aria-label', `Create another translation in the ${familyTitle} song family`);
        translateButton.addEventListener('click', () => openSongEditor(null, { translateFrom: anchor }));
        familyHeading.append(familyCopy, translateButton);

        const versionList = createElement('div', 'prepare-song-version-list');
        versionList.setAttribute('role', 'list');
        versionList.setAttribute('aria-label', `${familyTitle} versions`);
        for (const summary of family.versions) {
          const songId = songIdOf(summary);
          const revisionId = songRevisionOf(summary);
          if (!songId || !revisionId) continue;
          const row = createElement('div', 'prepare-song-row prepare-song-version');
          row.setAttribute('role', 'listitem');
          const copy = createElement('div', 'prepare-song-copy');
          const versionTitle = summary === family.original
            ? 'Original version'
            : (summary.title || songId);
          copy.append(
            createElement('strong', '', versionTitle),
            createElement('small', '', [
              summary.language || '',
              summary.translationOf ? 'Translation' : 'Original',
              Number.isSafeInteger(summary.sectionCount) ? `${summary.sectionCount} sections` : '',
              songCreditSummary(summary)
            ].filter(Boolean).join(' · ') || 'Song')
          );
          const communitySummary = communitySongSummaryState(summary);
          if (communitySummary) {
            copy.append(createElement(
              'span',
              `prepare-song-sync-badge ${communitySummary.kind}`,
              communitySummary.label
            ));
          }
          const actions = createElement('div', 'prepare-song-row-actions');
          const editButton = createElement('button', 'btn btn-quiet btn-compact', 'Edit');
          editButton.type = 'button';
          editButton.disabled = state.mutationBusy || state.publishBusy;
          editButton.setAttribute('aria-label', `Edit ${summary.title || songId}`);
          editButton.addEventListener('click', () => openSongEditor(summary));
          const addButton = createElement('button', 'btn btn-outline btn-compact', 'Add');
          addButton.type = 'button';
          addButton.disabled = !state.currentProject || state.mutationBusy || state.publishBusy;
          addButton.setAttribute('aria-label', `Add ${summary.title || songId} to this service`);
          addButton.addEventListener('click', () => addSong(summary));
          actions.append(editButton, addButton);
          row.append(copy, actions);
          versionList.appendChild(row);
        }
        familyCard.append(familyHeading, versionList);
        fragment.appendChild(familyCard);
      }
      elements.songList.appendChild(fragment);
      elements.songCount.textContent = loadedAll
        ? `${families.length} ${families.length === 1 ? 'family' : 'families'} · ${shown} ${shown === 1 ? 'version' : 'versions'}`
        : `Showing ${families.length} ${families.length === 1 ? 'family' : 'families'} · ${shown} of ${total} versions`;
    }

    function renderRundown() {
      const project = state.currentProject;
      const rows = currentRows();
      if (!project) {
        elements.rundownHeading.textContent = 'No service open';
        elements.projectMeta.textContent = 'Select a service from the left.';
      } else {
        elements.rundownHeading.textContent = project.title;
        elements.projectMeta.textContent = `${formatDate(project.serviceDate)} · ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`;
      }

      elements.rundownEmpty.hidden = rows.length > 0;
      const emptyTitle = elements.rundownEmpty.querySelector('h4');
      const emptyCopy = elements.rundownEmpty.querySelector('p');
      if (!project) {
        emptyTitle.textContent = 'Choose or create a service';
        emptyCopy.textContent = 'Saved service projects appear on the left. Load remains the default screen when SyncShow opens.';
      } else {
        emptyTitle.textContent = 'Start with what you have';
        emptyCopy.textContent = 'Import a song, add a sermon point, or place a picture. You can keep building as the service comes together.';
      }

      elements.rundownList.replaceChildren();
      const fragment = document.createDocumentFragment();
      const locked = state.mutationBusy || state.publishBusy;
      let projectedPosition = 0;
      rows.forEach(row => {
        if (row.item.kind !== 'group') projectedPosition += 1;
        const listItem = document.createElement('li');
        listItem.className = 'prepare-rundown-entry';
        listItem.dataset.itemId = row.item.id;
        listItem.style.setProperty('--prepare-depth', String(Math.min(row.depth, 12)));
        listItem.draggable = !locked;

        const dragHandle = createElement('span', 'prepare-reorder-handle', '⠿');
        dragHandle.setAttribute('aria-hidden', 'true');
        dragHandle.title = 'Drag to move this item';

        const button = createElement(
          'button',
          `prepare-rundown-row${row.item.kind === 'group' ? ' prepare-rundown-section-row' : ''}`
        );
        button.type = 'button';
        button.dataset.itemId = row.item.id;
        if (row.item.id === state.selectedItemId) button.setAttribute('aria-current', 'true');
        const copy = createElement('span', 'prepare-item-copy');
        copy.append(
          createElement('strong', '', row.item.title),
          createElement('small', '', row.item.kind === 'group'
            ? `${describeItem(row.item)} · titled separator, never projected`
            : [
                row.parentTitles.join(' › '),
                describeItem(row.item)
              ].filter(Boolean).join(' · '))
        );
        if (row.item.kind === 'group') {
          button.append(
            createElement('span', 'prepare-section-rule', ''),
            copy,
            createElement('span', 'prepare-item-kind', 'Section')
          );
        } else {
          button.append(
            createElement('span', 'prepare-item-number', String(projectedPosition).padStart(2, '0')),
            copy,
            createElement('span', 'prepare-item-kind', KIND_LABELS[row.item.kind] || row.item.kind)
          );
        }
        button.addEventListener('click', () => {
          if (state.selectedItemId !== row.item.id) {
            state.selectedArrangementId = null;
            state.translationCandidates = [];
            state.translationFamilyId = null;
            state.translationRequest += 1;
            state.previewCueOffset = 0;
            state.previewResult = null;
            state.previewRequest += 1;
          }
          state.selectedItemId = row.item.id;
          renderRundown();
          renderInspector();
          renderSongInspector();
          updateControlStates();
          if (row.item.kind === 'song') loadTranslationCandidates(row.item);
          loadSelectedPreview({ resetOffset: true });
        });

        const moveControls = createElement('span', 'prepare-rundown-move-controls');
        const moveUp = createElement('button', 'prepare-rundown-move-button', '↑');
        moveUp.type = 'button';
        moveUp.disabled = locked || row.index <= 0;
        moveUp.setAttribute('aria-label', `Move ${row.item.title} up`);
        moveUp.title = 'Move up';
        moveUp.addEventListener('click', () => moveItemById(row.item.id, -1));
        const moveDown = createElement('button', 'prepare-rundown-move-button', '↓');
        moveDown.type = 'button';
        moveDown.disabled = locked || row.index >= row.siblingCount - 1;
        moveDown.setAttribute('aria-label', `Move ${row.item.title} down`);
        moveDown.title = 'Move down';
        moveDown.addEventListener('click', () => moveItemById(row.item.id, 1));
        moveControls.append(moveUp, moveDown);

        const clearDropMarker = () => {
          listItem.classList.remove('drop-before', 'drop-after');
        };
        listItem.addEventListener('dragstart', event => {
          if (locked || event.target.closest('.prepare-rundown-move-controls')) {
            event.preventDefault();
            return;
          }
          state.draggedItemId = row.item.id;
          listItem.classList.add('is-dragging');
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', row.item.id);
        });
        listItem.addEventListener('dragover', event => {
          if (!state.draggedItemId || state.draggedItemId === row.item.id) return;
          event.preventDefault();
          const bounds = listItem.getBoundingClientRect();
          const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
          listItem.classList.toggle('drop-before', placement === 'before');
          listItem.classList.toggle('drop-after', placement === 'after');
          event.dataTransfer.dropEffect = 'move';
        });
        listItem.addEventListener('dragleave', event => {
          if (!listItem.contains(event.relatedTarget)) clearDropMarker();
        });
        listItem.addEventListener('drop', event => {
          event.preventDefault();
          const sourceItemId = state.draggedItemId || event.dataTransfer.getData('text/plain');
          const bounds = listItem.getBoundingClientRect();
          const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
          clearDropMarker();
          state.draggedItemId = null;
          moveItemRelative(sourceItemId, row.item.id, placement);
        });
        listItem.addEventListener('dragend', () => {
          state.draggedItemId = null;
          for (const entry of elements.rundownList.querySelectorAll('.prepare-rundown-entry')) {
            entry.classList.remove('is-dragging', 'drop-before', 'drop-after');
          }
        });

        listItem.append(dragHandle, button, moveControls);
        fragment.appendChild(listItem);
      });
      elements.rundownList.appendChild(fragment);
    }

    function renderInspector() {
      const row = selectedRow();
      if (!row) {
        state.selectedItemId = null;
        elements.inspectorHeading.textContent = 'Nothing selected';
        elements.inspectorSummary.textContent = state.currentProject
          ? 'Select an item in the rundown to see its details.'
          : 'Open a service project to begin.';
        elements.inspectorActions.hidden = true;
        elements.itemPreview.hidden = true;
        return;
      }
      elements.inspectorHeading.textContent = row.item.title;
      const location = row.parentTitles.length > 0 ? `Inside ${row.parentTitles.join(' › ')}. ` : '';
      elements.inspectorSummary.textContent = `${location}${KIND_LABELS[row.item.kind] || 'Item'} · ${describeItem(row.item)}`;
      elements.inspectorActions.hidden = false;
      elements.itemPreview.hidden = false;
      renderPreview();
    }

    function renderPreview() {
      const row = selectedRow();
      if (!row) {
        elements.itemPreview.hidden = true;
        return;
      }
      const channels = state.currentProject?.channelIds || [];
      const previousChannel = state.previewChannelId || elements.previewChannel.value;
      elements.previewChannel.replaceChildren();
      for (const channelId of channels) {
        const channel = state.currentProject.channels?.[channelId];
        appendOption(elements.previewChannel, channelId, channel?.label || channelId);
      }
      state.previewChannelId = channels.includes(previousChannel) ? previousChannel : channels[0] || null;
      elements.previewChannel.value = state.previewChannelId || '';

      if (row.item.kind === 'group') {
        elements.previewImage.hidden = true;
        elements.previewImage.removeAttribute('src');
        const count = countDescendants(state.currentProject, row.item.id);
        elements.previewStatus.hidden = false;
        elements.previewStatus.textContent =
          `${count} ${count === 1 ? 'item is' : 'items are'} inside this section. Sections organize the rundown but are not projected.`;
        elements.previewPosition.textContent = 'Section';
        return;
      }
      if (row.item.kind === 'imported-deck') {
        elements.previewImage.hidden = true;
        elements.previewImage.removeAttribute('src');
        elements.previewStatus.hidden = false;
        elements.previewStatus.textContent = 'Imported-deck preview remains available in Load after the deck is rendered.';
        elements.previewPosition.textContent = 'Slides';
        return;
      }
      if (state.previewBusy) {
        elements.previewImage.hidden = true;
        elements.previewStatus.hidden = false;
        elements.previewStatus.textContent = 'Rendering the exact output preview…';
      } else if (state.previewResult?.dataUrl) {
        elements.previewImage.src = state.previewResult.dataUrl;
        elements.previewImage.hidden = false;
        elements.previewStatus.hidden = true;
      } else {
        elements.previewImage.hidden = true;
        elements.previewImage.removeAttribute('src');
        elements.previewStatus.hidden = false;
        elements.previewStatus.textContent = state.previewResult?.message || 'Preview is ready when this item is selected.';
      }
      const cueCount = Number.isSafeInteger(state.previewResult?.cueCount) ? state.previewResult.cueCount : 0;
      elements.previewPosition.textContent = cueCount > 0
        ? `${Math.min(state.previewCueOffset + 1, cueCount)} of ${cueCount}`
        : '0 of 0';
    }

    async function loadSelectedPreview({ resetOffset = false } = {}) {
      const row = selectedRow();
      if (resetOffset) state.previewCueOffset = 0;
      state.previewResult = null;
      const request = ++state.previewRequest;
      if (!row || row.item.kind === 'group' || row.item.kind === 'imported-deck') {
        state.previewBusy = false;
        renderPreview();
        updateControlStates();
        return false;
      }
      state.previewBusy = true;
      renderPreview();
      updateControlStates();
      const projectId = state.currentProject.id;
      const revisionId = state.revisionId;
      const itemId = row.item.id;
      try {
        const result = checkedResult(await api.previewServiceItem({
          projectId,
          expectedRevisionId: revisionId,
          itemId,
          channelId: state.previewChannelId || state.currentProject.channelIds[0],
          cueOffset: state.previewCueOffset
        }));
        if (request !== state.previewRequest
          || state.currentProject?.id !== projectId
          || state.revisionId !== revisionId
          || state.selectedItemId !== itemId) {
          return false;
        }
        state.previewResult = result;
        state.previewCueOffset = Number.isSafeInteger(result?.cueOffset) ? result.cueOffset : state.previewCueOffset;
        return true;
      } catch (error) {
        if (request === state.previewRequest) {
          state.previewResult = {
            message: errorMessage(error, 'This item could not be previewed.')
          };
        }
        return false;
      } finally {
        if (request === state.previewRequest) {
          state.previewBusy = false;
          renderPreview();
          updateControlStates();
        }
      }
    }

    function shiftPreview(direction) {
      const count = state.previewResult?.cueCount || 0;
      const next = state.previewCueOffset + direction;
      if (state.previewBusy || next < 0 || next >= count) return;
      state.previewCueOffset = next;
      loadSelectedPreview();
    }

    function renderSongInspector() {
      const row = selectedRow();
      const item = row?.item?.kind === 'song' ? row.item : null;
      const source = item ? authoritativeSongForItem(state.currentProject, item) : null;
      const song = source?.document || null;
      elements.songInspector.hidden = !item;
      if (!item) {
        state.selectedArrangementId = null;
        return;
      }

      elements.songInspectorHeading.textContent = item.title;
      elements.songInspectorMeta.textContent = song
        ? [
            song.language || 'Language not set',
            `${song.sections.length} ${song.sections.length === 1 ? 'section' : 'sections'}`,
            songCreditSummary(song)
          ].filter(Boolean).join(' · ')
        : 'The pinned song lyrics are unavailable.';

      const arrangement = Array.isArray(item.arrangement) ? item.arrangement : [];
      if (!arrangement.some(entry => entry.id === state.selectedArrangementId)) {
        state.selectedArrangementId = null;
      }
      elements.songArrangementList.replaceChildren();
      for (const [index, entry] of arrangement.entries()) {
        const section = sectionForId(song, entry.sectionId);
        const listItem = createElement('li');
        listItem.tabIndex = 0;
        listItem.dataset.arrangementId = entry.id;
        listItem.setAttribute('role', 'option');
        listItem.setAttribute('aria-selected', String(entry.id === state.selectedArrangementId));
        listItem.textContent = `${index + 1}. ${section?.label || section?.marker || entry.sectionId}`;
        const selectEntry = () => {
          state.selectedArrangementId = entry.id;
          renderSongInspector();
          updateControlStates();
        };
        listItem.addEventListener('click', selectEntry);
        listItem.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          selectEntry();
        });
        elements.songArrangementList.appendChild(listItem);
      }
      elements.songArrangementEmpty.hidden = arrangement.length > 0;

      const previousSection = elements.songArrangementSection.value;
      elements.songArrangementSection.replaceChildren();
      appendOption(elements.songArrangementSection, '', 'Choose section…');
      for (const section of song?.sections || []) {
        appendOption(
          elements.songArrangementSection,
          section.id,
          section.label || section.marker || section.id
        );
      }
      if ([...elements.songArrangementSection.options].some(option => option.value === previousSection)) {
        elements.songArrangementSection.value = previousSection;
      }

      const sourceChannelId = source?.channelId || null;
      const previousChannel = elements.songTranslationChannel.value;
      elements.songTranslationChannel.replaceChildren();
      appendOption(elements.songTranslationChannel, '', 'Choose output…');
      for (const channelId of state.currentProject.channelIds) {
        if (channelId === sourceChannelId) continue;
        const channel = state.currentProject.channels?.[channelId];
        appendOption(
          elements.songTranslationChannel,
          channelId,
          channel?.label || channelId
        );
      }
      if ([...elements.songTranslationChannel.options].some(option => option.value === previousChannel)) {
        elements.songTranslationChannel.value = previousChannel;
      }

      const previousSongId = elements.songTranslationSong.selectedOptions[0]?.dataset.songId;
      const previousRevision = elements.songTranslationSong.selectedOptions[0]?.dataset.songRevisionId;
      elements.songTranslationSong.replaceChildren();
      const emptySongChoice = appendOption(
        elements.songTranslationSong,
        '',
        state.translationCandidatesBusy ? 'Loading matching songs…' : 'Choose matching song…'
      );
      const candidates = state.translationCandidates;
      for (const [index, summary] of candidates.entries()) {
        const option = appendOption(
          elements.songTranslationSong,
          String(index + 1),
          `${summary.title || songIdOf(summary)}${summary.language ? ` · ${summary.language}` : ''}`,
          {
            songId: songIdOf(summary),
            songRevisionId: songRevisionOf(summary)
          }
        );
        if (songIdOf(summary) === previousSongId && songRevisionOf(summary) === previousRevision) {
          option.selected = true;
        }
      }
      if (!state.translationCandidatesBusy && candidates.length === 0) {
        emptySongChoice.textContent = 'No matching versions in the library';
      }

      elements.songOutputTranslations.replaceChildren();
      for (const channelId of state.currentProject.channelIds) {
        const channel = state.currentProject.channels?.[channelId];
        const variant = item.variants?.[channelId] || { mode: 'hidden' };
        let summary = 'Hidden for this song';
        if (variant.mode === 'content') {
          const document = state.currentProject.resources?.[variant.resourceId]?.document;
          summary = document
            ? `${document.title}${document.language ? ` · ${document.language}` : ''}`
            : 'Pinned song version unavailable';
        } else if (variant.mode === 'inherit') {
          summary = `Uses ${state.currentProject.channels?.[variant.from]?.label || variant.from}`;
        } else if (variant.mode === 'derive') {
          summary = `Next-line view from ${state.currentProject.channels?.[variant.from]?.label || variant.from}`;
        }
        const outputRow = createElement('div', 'prepare-song-output-row');
        outputRow.append(
          createElement('strong', 'prepare-song-output-name', channel?.label || channelId),
          createElement('span', 'prepare-pane-subtitle', summary)
        );
        if (variant.mode === 'content' && channelId !== sourceChannelId) {
          const resetButton = createElement('button', 'btn btn-quiet btn-compact', 'Use normal');
          resetButton.type = 'button';
          resetButton.disabled = state.mutationBusy || state.publishBusy;
          resetButton.addEventListener('click', () => resetSelectedSongTranslation(channelId));
          outputRow.appendChild(resetButton);
        }
        elements.songOutputTranslations.appendChild(outputRow);
      }
    }

    function renderAll() {
      renderProjectList();
      renderRundown();
      renderInspector();
      renderSongInspector();
      renderSongList();
      updateControlStates();
    }

    function applyProjectResult(rawResult) {
      const result = checkedResult(rawResult);
      if (!result?.project || typeof result.project !== 'object' || typeof result.revisionId !== 'string') {
        throw new Error('SyncShow did not return the saved service revision.');
      }
      state.currentProject = result.project;
      state.revisionId = result.revisionId;
      if (state.selectedItemId && !result.project.items?.[state.selectedItemId]) {
        state.selectedItemId = null;
      }
      return result;
    }

    async function loadProjects({ openFirst = false } = {}) {
      if (!state.available) return false;
      const request = ++state.projectRequest;
      state.projectsBusy = true;
      renderProjectList();
      let loaded = false;
      try {
        const payload = checkedResult(await api.listServiceProjects({
          query: state.projectQuery,
          pageSize: PROJECT_PAGE_SIZE,
          offset: 0
        }));
        if (request !== state.projectRequest) return false;
        state.projects = collectionItems(payload, ['items', 'projects']);
        state.projectTotal = collectionTotal(payload, state.projects.length);
        loaded = true;
        if (openFirst && !state.currentProject && state.projects[0]) {
          const summary = state.projects[0];
          loaded = await openProject(projectIdOf(summary), null, { announce: false });
        }
      } catch (error) {
        if (request !== state.projectRequest) return false;
        state.projects = [];
        state.projectTotal = 0;
        setNotice('error', errorMessage(error, 'Service projects could not be loaded.'), { global: true });
      } finally {
        if (request === state.projectRequest) {
          state.projectsBusy = false;
          renderProjectList();
        }
      }
      return loaded;
    }

    async function loadProjectHistory({ seedUndo = false } = {}) {
      if (!state.currentProject?.id || typeof api.listServiceProjectHistory !== 'function') {
        state.projectHistory = [];
        if (seedUndo) state.undoStack = [];
        return false;
      }
      try {
        const payload = checkedResult(await api.listServiceProjectHistory({
          projectId: state.currentProject.id,
          limit: 100
        }));
        state.projectHistory = collectionItems(payload, ['items', 'revisions']);
        if (seedUndo) {
          const earlier = state.projectHistory
            .filter(entry => entry.revisionId && entry.revisionId !== state.revisionId)
            .sort((a, b) => Number(a.projectRevision || a.revision || 0) - Number(b.projectRevision || b.revision || 0));
          state.undoStack = earlier.map(entry => entry.revisionId).slice(-100);
          state.redoStack = [];
        }
        return true;
      } catch (_error) {
        state.projectHistory = [];
        if (seedUndo) state.undoStack = [];
        return false;
      } finally {
        updateControlStates();
      }
    }

    async function loadSongs({ append = false } = {}) {
      if (!state.available) return false;
      const offset = append ? state.songNextOffset : 0;
      if (append && (!Number.isSafeInteger(offset) || offset < 0 || state.songsLoadingMore)) {
        return false;
      }
      const request = {
        id: ++state.songRequest,
        query: state.songQuery,
        offset,
        append
      };
      if (append) {
        state.songsLoadingMore = true;
      } else {
        state.songsBusy = true;
        state.songsLoadingMore = false;
        state.songNextOffset = null;
      }
      renderSongList();
      updateControlStates();
      let loaded = false;
      try {
        const payload = checkedResult(await api.listSongLibrary({
          query: request.query,
          pageSize: SONG_PAGE_SIZE,
          offset: request.offset
        }));
        if (!applySongLibraryPage(state, request, payload)) return false;
        loaded = true;
      } catch (error) {
        if (!canApplySongLibraryPage(request, state)) return false;
        if (!append) {
          state.songs = [];
          state.songTotal = 0;
          state.songNextOffset = null;
        }
        setNotice(
          'error',
          errorMessage(
            error,
            append
              ? 'More songs could not be loaded. Try Load more again.'
              : 'The song library could not be loaded.'
          ),
          { global: true }
        );
      } finally {
        if (request.id === state.songRequest && request.query === state.songQuery) {
          if (append) state.songsLoadingMore = false;
          else state.songsBusy = false;
          renderSongList();
          renderSongInspector();
          updateControlStates();
        }
      }
      return loaded;
    }

    async function loadTranslationCandidates(item, { force = false } = {}) {
      const song = authoritativeSongForItem(state.currentProject, item)?.document || null;
      if (!song) {
        state.translationCandidates = [];
        state.translationCandidatesBusy = false;
        state.translationFamilyId = null;
        state.translationRequest += 1;
        renderSongInspector();
        updateControlStates();
        return false;
      }
      const familyId = song.translationOf || song.id;
      if (!force && state.translationFamilyId === familyId && !state.translationCandidatesBusy) {
        return true;
      }
      const request = ++state.translationRequest;
      state.translationFamilyId = familyId;
      state.translationCandidates = [];
      state.translationCandidatesBusy = true;
      renderSongInspector();
      updateControlStates();
      try {
        const payload = checkedResult(await api.listSongTranslationsForServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: item.id
        }));
        if (request !== state.translationRequest
          || state.selectedItemId !== item.id
          || state.translationFamilyId !== familyId) {
          return false;
        }
        state.translationCandidates = collectionItems(payload, ['items', 'songs']);
        return true;
      } catch (error) {
        if (request === state.translationRequest) {
          state.translationCandidates = [];
          setNotice(
            'error',
            errorMessage(error, 'Matching song translations could not be loaded.'),
            { global: true }
          );
        }
        return false;
      } finally {
        if (request === state.translationRequest) {
          state.translationCandidatesBusy = false;
          renderSongInspector();
          updateControlStates();
        }
      }
    }

    async function openProject(projectId, revisionId, { announce = true } = {}) {
      if (!projectId || state.mutationBusy || state.publishBusy) return false;
      state.mutationBusy = true;
      setNotice('busy', 'Opening the service project…');
      updateControlStates();
      try {
        const opened = applyProjectResult(await api.openServiceProject({
          projectId,
          ...(revisionId ? { revisionId } : {})
        }));
        state.selectedItemId = null;
        state.selectedArrangementId = null;
        state.translationCandidates = [];
        state.translationFamilyId = null;
        state.translationRequest += 1;
        state.undoStack = [];
        state.redoStack = [];
        state.collapsedGroupIds = new Set();
        state.previewRequest += 1;
        state.previewResult = null;
        state.previewCueOffset = 0;
        resetBibleLookup();
        await loadProjectHistory({ seedUndo: true });
        if (opened.recovery?.message) {
          setNotice('error', opened.recovery.message, { global: true });
        } else if (announce) {
          setNotice('success', `${state.currentProject.title} is open.`);
        }
        return true;
      } catch (error) {
        setNotice('error', errorMessage(error, 'That service project could not be opened.'), { global: true });
        return false;
      } finally {
        state.mutationBusy = false;
        renderAll();
      }
    }

    async function mutateProject(label, operation, successMessage, options = {}) {
      if (!state.currentProject || !state.revisionId || state.mutationBusy || state.publishBusy) return null;
      const previousRevisionId = state.revisionId;
      state.mutationBusy = true;
      setNotice('busy', label);
      updateControlStates();
      try {
        const rawResult = await operation();
        if (rawResult === null || rawResult?.cancelled === true) {
          setNotice('', 'No change was made.');
          return { cancelled: true };
        }
        const result = applyProjectResult(rawResult);
        if (options.trackHistory !== false
          && result.unchanged !== true
          && previousRevisionId
          && previousRevisionId !== result.revisionId) {
          state.undoStack.push(previousRevisionId);
          if (state.undoStack.length > 100) state.undoStack.shift();
          state.redoStack = [];
        }
        setNotice('success', successMessage, { global: true });
        await loadProjects();
        if (state.selectedItemId) loadSelectedPreview({ resetOffset: true });
        return result;
      } catch (error) {
        const message = errorMessage(error, 'The service could not be changed.');
        if (isProjectConflict(error, message) && state.currentProject?.id) {
          try {
            const currentProjectId = state.currentProject.id;
            applyProjectResult(await api.openServiceProject({ projectId: currentProjectId }));
            state.translationCandidates = [];
            state.translationFamilyId = null;
            state.translationRequest += 1;
            state.undoStack = [];
            state.redoStack = [];
            state.previewRequest += 1;
            state.previewResult = null;
            const selected = selectedRow()?.item;
            setNotice(
              'error',
              `${message} The newest saved version is open now; review it and try again.`,
              { global: true }
            );
            await loadProjects();
            if (selected?.kind === 'song') {
              await loadTranslationCandidates(selected, { force: true });
            }
            return null;
          } catch (reloadError) {
            setNotice(
              'error',
              `${message} SyncShow could not reload the newest version: ${errorMessage(reloadError, 'unknown error')}`,
              { global: true }
            );
            return null;
          }
        }
        setNotice('error', message, { global: true });
        return null;
      } finally {
        state.mutationBusy = false;
        renderAll();
      }
    }

    function openNewProjectDialog() {
      if (!state.available || state.mutationBusy) return;
      setDialogError(elements.newProjectError, '');
      elements.newProjectDate.value = localIsoDate();
      if (!elements.newProjectName.value.trim()) elements.newProjectName.value = 'Sunday Service';
      elements.newProjectDialog.showModal();
      window.setTimeout(() => elements.newProjectName.select(), 0);
    }

    async function createProject(event) {
      event.preventDefault();
      if (state.mutationBusy) return;
      const title = elements.newProjectName.value.trim();
      const serviceDate = elements.newProjectDate.value;
      if (!title || !serviceDate) return;
      state.mutationBusy = true;
      elements.btnCreateProject.disabled = true;
      setDialogError(elements.newProjectError, '');
      setNotice('busy', 'Creating the service project…');
      try {
        applyProjectResult(await api.createServiceProject({ title, serviceDate }));
        state.selectedItemId = null;
        state.selectedArrangementId = null;
        state.translationCandidates = [];
        state.translationFamilyId = null;
        state.translationRequest += 1;
        state.undoStack = [];
        state.redoStack = [];
        state.collapsedGroupIds = new Set();
        state.previewRequest += 1;
        state.previewResult = null;
        resetBibleLookup();
        elements.newProjectDialog.close();
        state.projectQuery = '';
        elements.projectSearch.value = '';
        setNotice('success', `${title} is ready. Add the first song or slide.`, { global: true });
        await loadProjects();
      } catch (error) {
        const message = errorMessage(error, 'The service project could not be created.');
        setDialogError(elements.newProjectError, message);
        setNotice('error', message, { global: true });
      } finally {
        state.mutationBusy = false;
        elements.btnCreateProject.disabled = false;
        renderAll();
      }
    }

    async function importProject() {
      if (!state.available || state.mutationBusy || state.publishBusy) return;
      state.mutationBusy = true;
      setNotice('busy', 'Choose a portable SyncShow service…');
      updateControlStates();
      try {
        const rawResult = await api.importServiceProject();
        if (rawResult === null || rawResult?.cancelled) {
          setNotice('', 'Service import cancelled.');
          return;
        }
        const result = applyProjectResult(checkedResult(rawResult));
        state.selectedItemId = null;
        state.selectedArrangementId = null;
        state.translationCandidates = [];
        state.translationFamilyId = null;
        state.translationRequest += 1;
        state.undoStack = [];
        state.redoStack = [];
        state.collapsedGroupIds = new Set();
        state.previewRequest += 1;
        state.previewResult = null;
        state.previewCueOffset = 0;
        resetBibleLookup();
        await Promise.all([loadProjects(), loadProjectHistory({ seedUndo: true }), loadSongs()]);
        const projectMessage = result.forked
          ? `${result.project.title} was imported as a separate copy and opened.`
          : result.imported === false
            ? `${result.project.title} was already in this library and is open now.`
            : `${result.project.title} was imported and opened.`;
        const songImport = result.songLibrary && typeof result.songLibrary === 'object'
          ? result.songLibrary
          : null;
        const addedSongs = Number.isSafeInteger(songImport?.added) ? songImport.added : 0;
        const unchangedSongs = Number.isSafeInteger(songImport?.unchanged) ? songImport.unchanged : 0;
        const conflictedSongs = Number.isSafeInteger(songImport?.conflicts) ? songImport.conflicts : 0;
        const failedSongs = Number.isSafeInteger(songImport?.failed) ? songImport.failed : 0;
        const songMessages = [];
        if (addedSongs > 0) {
          songMessages.push(`${addedSongs} pinned song${addedSongs === 1 ? '' : 's'} ${addedSongs === 1 ? 'was' : 'were'} added to the Song Library.`);
        } else if (unchangedSongs > 0 && conflictedSongs === 0 && failedSongs === 0) {
          songMessages.push(`${unchangedSongs} pinned song${unchangedSongs === 1 ? ' was' : 's were'} already in the Song Library.`);
        }
        if (conflictedSongs > 0) {
          songMessages.push(`${conflictedSongs} conflicting library song${conflictedSongs === 1 ? ' was' : 's were'} preserved; the imported service keeps its own pinned copy.`);
        }
        if (failedSongs > 0) {
          songMessages.push(`${failedSongs} pinned song${failedSongs === 1 ? '' : 's'} could not be copied to the Song Library, but ${failedSongs === 1 ? 'it remains' : 'they remain'} inside the service.`);
        }
        const message = [projectMessage, ...songMessages].join(' ');
        setNotice('success', message, { global: true });
      } catch (error) {
        setNotice('error', errorMessage(error, 'The portable service could not be imported.'), { global: true });
      } finally {
        state.mutationBusy = false;
        renderAll();
      }
    }

    async function exportProject() {
      if (!state.currentProject || !state.revisionId || state.mutationBusy || state.publishBusy) return;
      state.mutationBusy = true;
      setNotice('busy', 'Choosing where to save the portable service…');
      updateControlStates();
      try {
        const result = checkedResult(await api.exportServiceProject({
          projectId: state.currentProject.id,
          revisionId: state.revisionId
        }));
        if (result === null || result?.cancelled) {
          setNotice('', 'Service export cancelled.');
          return;
        }
        setNotice(
          'success',
          `${state.currentProject.title} was exported${result?.fileName ? ` as ${result.fileName}` : ''}.`,
          { global: true }
        );
      } catch (error) {
        setNotice('error', errorMessage(error, 'The portable service could not be exported.'), { global: true });
      } finally {
        state.mutationBusy = false;
        renderAll();
      }
    }

    function openGroupDialog(parentId = null) {
      if (!state.currentProject || state.mutationBusy || state.publishBusy) return;
      const parent = parentId ? state.currentProject.items?.[parentId] : null;
      state.groupParentId = parent?.kind === 'group' ? parent.id : null;
      elements.groupForm.reset();
      elements.groupKind.value = 'section';
      const description = elements.groupDialog.querySelector('.prepare-dialog-description');
      description.textContent = parent
        ? `This titled separator will be placed inside “${parent.title}”. It is never projected.`
        : 'Sections are headings in the rundown. They help volunteers scan the service and are never projected.';
      setDialogError(elements.groupError, '');
      elements.groupDialog.showModal();
      window.setTimeout(() => elements.groupTitle.focus(), 0);
    }

    async function addGroup(event) {
      event.preventDefault();
      const title = elements.groupTitle.value.trim();
      const groupKind = elements.groupKind.value;
      if (!title) return;
      setDialogError(elements.groupError, '');
      const previousIds = new Set(Object.keys(state.currentProject?.items || {}));
      const result = await mutateProject(
        `Adding ${title}…`,
        () => api.createServiceGroup({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          title,
          groupKind,
          ...(state.groupParentId ? { parentId: state.groupParentId } : {})
        }),
        `${title} was added to the service.`
      );
      if (!result) {
        setDialogError(elements.groupError, 'The section was not added. Review the message above and try again.');
        return;
      }
      const added = Object.values(result.project.items || {}).find(item =>
        item.kind === 'group' && !previousIds.has(item.id));
      if (added) state.selectedItemId = added.id;
      state.groupParentId = null;
      elements.groupDialog.close();
      renderAll();
    }

    function presetsForKind(kind) {
      return state.presets.filter(preset =>
        Array.isArray(preset.kinds) && preset.kinds.includes(kind) && preset.selectable !== false);
    }

    function pictureAssetIdForChannel(item, channelId) {
      if (item?.assetIdsByChannel?.[channelId]) return item.assetIdsByChannel[channelId];
      if (item?.assetId && item.channelIds?.includes(channelId)) return item.assetId;
      return null;
    }

    async function changePictureOutput(itemId, channelId, action) {
      const item = state.currentProject?.items?.[itemId];
      if (item?.kind !== 'picture' || !['choose', 'remove'].includes(action)) return;
      const channelName = state.currentProject.channels?.[channelId]?.label || channelId;
      for (const button of elements.editItemPictureOutputList.querySelectorAll('button')) {
        button.disabled = true;
      }
      setDialogError(elements.editItemError, '');
      const result = await mutateProject(
        action === 'choose'
          ? `Choose the picture for ${channelName}…`
          : `Hiding the picture on ${channelName}…`,
        () => api.updatePictureOutput({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId,
          channelId,
          action
        }),
        action === 'choose'
          ? `${channelName} now uses the selected picture.`
          : `The picture is hidden on ${channelName}.`
      );
      const currentItem = state.currentProject?.items?.[itemId];
      if (currentItem?.kind === 'picture') renderPictureOutputEditor(currentItem);
      if (!result && currentItem?.kind === 'picture') {
        setDialogError(
          elements.editItemError,
          `${channelName} was not changed. Review the message above and try again.`
        );
      }
    }

    function renderPictureOutputEditor(item) {
      elements.editItemPictureOutputList.replaceChildren();
      if (item?.kind !== 'picture') return;
      const visibleCount = state.currentProject.channelIds
        .filter(channelId => pictureAssetIdForChannel(item, channelId))
        .length;
      for (const channelId of state.currentProject.channelIds) {
        const channelName = state.currentProject.channels?.[channelId]?.label || channelId;
        const localizedAssetId = item.assetIdsByChannel?.[channelId] || null;
        const sharedAssetId = item.assetId && item.channelIds?.includes(channelId)
          ? item.assetId
          : null;
        const assetId = localizedAssetId || sharedAssetId;
        const asset = assetId ? state.currentProject.assets?.[assetId] : null;
        const outputRow = createElement(
          'div',
          `prepare-picture-output-row${assetId ? '' : ' is-hidden'}`
        );
        outputRow.dataset.channelId = channelId;
        const copy = createElement('span', 'prepare-picture-output-copy');
        copy.append(
          createElement('strong', '', channelName),
          createElement(
            'small',
            '',
            assetId
              ? `${localizedAssetId ? 'Output-specific picture' : 'Shared picture'}${asset?.fileName ? ` · ${asset.fileName}` : ''}`
              : 'No picture on this output'
          )
        );
        const actions = createElement('span', 'prepare-picture-output-actions');
        const chooseButton = createElement(
          'button',
          'btn btn-outline btn-compact',
          assetId ? 'Replace' : 'Choose'
        );
        chooseButton.type = 'button';
        chooseButton.dataset.pictureOutputAction = 'choose';
        chooseButton.disabled = state.mutationBusy || state.publishBusy;
        chooseButton.addEventListener('click', () => changePictureOutput(item.id, channelId, 'choose'));
        actions.appendChild(chooseButton);
        if (assetId) {
          const removeButton = createElement('button', 'btn btn-quiet btn-compact', 'Remove');
          removeButton.type = 'button';
          removeButton.dataset.pictureOutputAction = 'remove';
          removeButton.disabled = state.mutationBusy || state.publishBusy || visibleCount <= 1;
          if (visibleCount <= 1) {
            removeButton.title = 'Keep the picture on at least one output';
          }
          removeButton.addEventListener('click', () => changePictureOutput(item.id, channelId, 'remove'));
          actions.appendChild(removeButton);
        }
        outputRow.append(
          copy,
          createElement('span', 'prepare-picture-output-state', assetId ? 'Shown' : 'Hidden'),
          actions
        );
        elements.editItemPictureOutputList.appendChild(outputRow);
      }
    }

    function openEditItemDialog() {
      const row = selectedRow();
      if (!row || state.mutationBusy || state.publishBusy || row.item.kind === 'imported-deck') return;
      const item = row.item;
      elements.editItemForm.reset();
      elements.editItemTitle.textContent = `Edit ${KIND_LABELS[item.kind] || 'item'}`;
      elements.editItemDescription.textContent = ['sermon', 'notice'].includes(item.kind)
        ? 'Keep the operator-facing rundown title separate from the title and body projected on each output.'
        : 'Choose Save changes when you are done. Each save creates a recoverable revision.';
      elements.editItemNameLabel.firstChild.textContent = 'Rundown title ';
      elements.editItemNameHint.textContent = 'Shown to the operator; never substituted for projected text';
      elements.editItemName.value = item.title || '';
      elements.editItemNotes.value = item.operatorNotes || '';
      elements.editItemGroupKindField.hidden = true;
      elements.editItemGroupKind.value = item.groupKind || 'section';
      const presetField = ['song', 'bible', 'sermon', 'notice'].includes(item.kind);
      elements.editItemPresetField.hidden = !presetField;
      elements.editItemPreset.replaceChildren();
      const currentPreset = item.kind === 'song' ? item.lyricsPresetId : item.presetId;
      for (const preset of presetsForKind(item.kind)) {
        const option = appendOption(
          elements.editItemPreset,
          preset.id,
          `${preset.label}${preset.description ? ` — ${preset.description}` : ''}`
        );
        if (preset.id === currentPreset) option.selected = true;
      }
      elements.editItemTextFields.hidden = !['sermon', 'notice'].includes(item.kind);
      elements.editItemChannelText.replaceChildren();
      if (!elements.editItemTextFields.hidden) {
        for (const channelId of state.currentProject.channelIds) {
          const output = state.currentProject.channels?.[channelId];
          const channelName = state.currentProject.channels?.[channelId]?.label || channelId;
          const card = createElement('section', 'prepare-output-text-card');
          card.dataset.channelId = channelId;
          const heading = createElement('div', 'prepare-output-text-card-heading');
          heading.append(
            createElement('strong', '', channelName),
            createElement('small', '', output?.language && output.language !== 'und'
              ? output.language
              : 'Configured output')
          );
          const titleLabel = createElement('label', 'field-group');
          const titleCaption = createElement('span', '', 'Projected title');
          const titleInput = createElement('input', 'text-input');
          titleInput.type = 'text';
          titleInput.maxLength = 200;
          titleInput.autocomplete = 'off';
          titleInput.value = item.titlesByChannel?.[channelId] || '';
          titleInput.dataset.channelId = channelId;
          titleInput.dataset.channelTitle = '';
          titleLabel.append(titleCaption, titleInput);
          const bodyLabel = createElement('label', 'field-group');
          const bodyCaption = createElement('span', '', 'Projected body');
          const textarea = createElement('textarea', 'prepare-textarea');
          textarea.maxLength = 20000;
          textarea.value = item.textByChannel?.[channelId] || '';
          textarea.dataset.channelId = channelId;
          textarea.dataset.channelText = '';
          bodyLabel.append(bodyCaption, textarea);
          const bodyEditor = createElement('div', 'prepare-output-body-editor');
          bodyEditor.append(
            bodyLabel,
            attachEmphasisEditor(
              card,
              textarea,
              item.spansByChannel?.[channelId] || [],
              channelName
            )
          );
          card.append(heading, titleLabel, bodyEditor);
          elements.editItemChannelText.appendChild(card);
        }
      }
      elements.editItemPictureOutputs.hidden = item.kind !== 'picture';
      renderPictureOutputEditor(item);
      elements.editItemAltTextField.hidden = item.kind !== 'picture';
      elements.editItemAltText.value = item.altText || '';
      elements.editItemFitField.hidden = item.kind !== 'picture';
      elements.editItemAttributionField.hidden = item.kind !== 'picture';
      elements.editItemFit.value = item.fit || 'fit';
      elements.editItemAttribution.value = item.attribution || '';
      setDialogError(elements.editItemError, '');
      state.editItemDraftDirty = false;
      state.editItemBaselineSource = currentEditItemDraftSource();
      elements.editItemDialog.showModal();
      window.setTimeout(() => elements.editItemName.select(), 0);
    }

    function currentEditItemDraftSource() {
      const row = selectedRow();
      const channels = [];
      for (const card of elements.editItemChannelText.querySelectorAll('.prepare-output-text-card[data-channel-id]')) {
        const editor = editEmphasisByCard.get(card);
        channels.push({
          channelId: card.dataset.channelId,
          title: card.querySelector('[data-channel-title]')?.value || '',
          text: card.querySelector('[data-channel-text]')?.value || '',
          spans: editor?.ranges || []
        });
      }
      return editItemDraftSnapshot({
        itemId: row?.item?.id,
        title: elements.editItemName.value,
        operatorNotes: elements.editItemNotes.value,
        groupKind: elements.editItemGroupKind.value,
        presetId: elements.editItemPreset.value,
        altText: elements.editItemAltText.value,
        fit: elements.editItemFit.value,
        attribution: elements.editItemAttribution.value,
        channels
      });
    }

    function markEditItemDraftDirty() {
      state.editItemDraftDirty = true;
      setDialogError(elements.editItemError, '');
    }

    function editItemDraftIsDirty() {
      if (!state.editItemDraftDirty || state.editItemBaselineSource === null) return false;
      return currentEditItemDraftSource() !== state.editItemBaselineSource;
    }

    function closeEditItemEditor() {
      if (state.mutationBusy || state.publishBusy) return false;
      if (editItemDraftIsDirty()
        && !window.confirm('Discard the unsaved changes to this service item?')) {
        return false;
      }
      closeDialog(elements.editItemDialog, elements.btnEdit);
      state.editItemBaselineSource = null;
      state.editItemDraftDirty = false;
      return true;
    }

    async function saveEditedItem(event) {
      event.preventDefault();
      const row = selectedRow();
      if (!row || row.item.kind === 'imported-deck') return;
      const title = elements.editItemName.value.trim();
      if (!title) return;
      const textByChannel = [];
      const titlesByChannel = [];
      const spansByChannel = [];
      let emphasisChanged = false;
      for (const card of elements.editItemChannelText.querySelectorAll('.prepare-output-text-card[data-channel-id]')) {
        const channelId = card.dataset.channelId;
        const projectedTitle = card.querySelector('[data-channel-title]')?.value.trim() || '';
        const projectedText = card.querySelector('[data-channel-text]')?.value.trim() || '';
        const emphasisEditor = editEmphasisByCard.get(card);
        let ranges = [];
        try {
          ranges = normalizeEditableEmphasisRanges(
            emphasisEditor?.ranges || [],
            projectedText
          );
        } catch (_error) {
          const channelName = state.currentProject.channels?.[channelId]?.label || channelId;
          setDialogError(
            elements.editItemError,
            `${channelName} emphasis no longer lines up with its body. Clear it or select the phrases again.`
          );
          return;
        }
        textByChannel.push({ channelId, text: projectedText });
        titlesByChannel.push({ channelId, title: projectedTitle });
        spansByChannel.push({ channelId, spans: ranges });
        emphasisChanged ||= emphasisEditor?.dirty === true;
        if (projectedTitle && !projectedText) {
          const channelName = state.currentProject.channels?.[channelId]?.label || channelId;
          setDialogError(
            elements.editItemError,
            `${channelName} has a projected title but no body. Add body text or clear both fields to hide it.`
          );
          return;
        }
      }
      if (['sermon', 'notice'].includes(row.item.kind)
        && !textByChannel.some(entry => entry.text)) {
        setDialogError(elements.editItemError, 'Show this item on at least one output by adding body text.');
        return;
      }
      const altText = elements.editItemAltText.value.trim();
      if (row.item.kind === 'picture' && !altText) {
        setDialogError(elements.editItemError, 'Add a useful picture description.');
        return;
      }
      setDialogError(elements.editItemError, '');
      const result = await mutateProject(
        `Saving ${title}…`,
        () => api.updateServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id,
          title,
          groupKind: row.item.kind === 'group' ? row.item.groupKind : undefined,
          textByChannel: textByChannel.length > 0 ? textByChannel : undefined,
          titlesByChannel: titlesByChannel.length > 0 ? titlesByChannel : undefined,
          spansByChannel: emphasisChanged ? spansByChannel : undefined,
          presetId: elements.editItemPresetField.hidden ? undefined : elements.editItemPreset.value,
          altText: row.item.kind === 'picture' ? altText : undefined,
          fit: row.item.kind === 'picture' ? elements.editItemFit.value : undefined,
          attribution: row.item.kind === 'picture' ? elements.editItemAttribution.value.trim() : undefined,
          operatorNotes: elements.editItemNotes.value
        }),
        `${title} was updated.`
      );
      if (result) {
        state.editItemBaselineSource = null;
        state.editItemDraftDirty = false;
        elements.editItemDialog.close();
      }
      else setDialogError(elements.editItemError, 'The item was not updated. Review the message above and try again.');
    }

    async function importSong() {
      if (!state.available || state.mutationBusy || state.publishBusy) return;
      state.mutationBusy = true;
      state.songImportBusy = true;
      setNotice('busy', 'Choose up to 50 Markdown or text song files…');
      updateControlStates();
      try {
        const result = checkedResult(await api.importSongDocument());
        if (result?.cancelled || result === null) {
          setNotice('', 'Song import cancelled.');
          return;
        }
        state.songQuery = '';
        elements.songSearch.value = '';
        const refreshed = await loadSongs();
        const selected = selectedRow()?.item;
        if (selected?.kind === 'song') {
          await loadTranslationCandidates(selected, { force: true });
        }
        const outcome = summarizeSongImport(result);
        setNotice(
          refreshed ? outcome.kind : 'error',
          `${outcome.message}${refreshed ? '' : ' The library list could not be refreshed; leave Prepare and return to retry.'}`,
          { global: true }
        );
      } catch (error) {
        setNotice('error', errorMessage(error, 'The song files could not be imported.'), { global: true });
      } finally {
        state.songImportBusy = false;
        state.mutationBusy = false;
        renderAll();
      }
    }

    function communitySongApiAvailable() {
      return ['getCommunitySongState', 'setCommunitySongVisibility']
        .every(method => typeof api[method] === 'function');
    }

    function communityConflictApiAvailable() {
      return ['getCommunitySongConflict', 'resolveCommunitySongConflict']
        .every(method => typeof api[method] === 'function');
    }

    function communityConflictPayloadOf(result) {
      const conflict = result?.conflict && typeof result.conflict === 'object'
        ? result.conflict
        : result;
      return conflict && typeof conflict === 'object' ? conflict : null;
    }

    function communityConflictGuardsAreValid(conflict = state.songCommunityConflict) {
      return Number.isSafeInteger(conflict?.expectedSyncVersion)
        && conflict.expectedSyncVersion >= 1
        && typeof conflict?.expectedLocalRevision === 'string'
        && /^[a-f0-9]{64}$/.test(conflict.expectedLocalRevision);
    }

    function renderCommunityConflictDocuments(container, documents, emptyMessage) {
      container.replaceChildren();
      if (!Array.isArray(documents) || documents.length === 0) {
        container.appendChild(createElement('p', 'prepare-conflict-empty', emptyMessage));
        return;
      }
      for (const rawDocument of documents) {
        const document = rawDocument && typeof rawDocument === 'object' ? rawDocument : {};
        const card = createElement('article', 'prepare-conflict-document');
        const heading = createElement('header');
        heading.appendChild(createElement(
          'strong',
          '',
          typeof document.title === 'string' && document.title.trim()
            ? document.title.trim()
            : (typeof document.id === 'string' && document.id.trim() ? document.id.trim() : 'Untitled song')
        ));
        const metadata = [
          typeof document.language === 'string' && document.language.trim()
            ? `Language: ${document.language.trim()}`
            : 'Language not specified',
          typeof document.id === 'string' && document.id.trim()
            ? `ID: ${document.id.trim()}`
            : ''
        ].filter(Boolean).join(' · ');
        heading.appendChild(createElement('small', '', metadata));
        card.appendChild(heading);
        const source = typeof document.source === 'string'
          ? document.source
          : '[Saved source unavailable]';
        const maximumPreviewCharacters = 50000;
        const preview = source.length > maximumPreviewCharacters
          ? `${source.slice(0, maximumPreviewCharacters)}\n\n[Preview shortened in SyncShow]`
          : source;
        const sourcePreview = createElement('pre');
        sourcePreview.textContent = preview;
        card.appendChild(sourcePreview);
        container.appendChild(card);
      }
    }

    function renderSongCommunityConflictDialog() {
      const conflict = state.songCommunityConflict;
      const busy = state.songCommunityConflictBusy;
      const validGuards = communityConflictGuardsAreValid(conflict);
      renderCommunityConflictDocuments(
        elements.songCommunityLocalDocuments,
        conflict?.localDocuments,
        state.songCommunityConflictError
          ? 'This Mac’s saved copy could not be loaded.'
          : 'Loading this Mac’s saved copy…'
      );
      renderCommunityConflictDocuments(
        elements.songCommunityRemoteDocuments,
        conflict?.communityDocuments,
        state.songCommunityConflictError
          ? 'The Community copy could not be loaded.'
          : 'Loading the Community copy…'
      );
      elements.songCommunityConflictStatus.dataset.kind = state.songCommunityConflictError
        ? 'error'
        : (conflict && !validGuards ? 'warning' : '');
      elements.songCommunityConflictStatus.textContent = state.songCommunityConflictError
        || (busy
          ? 'Applying the guarded conflict choice…'
          : conflict && validGuards
            ? 'Review every language, then choose which saved copy should become authoritative.'
            : conflict
              ? 'Reload this conflict before choosing a copy.'
              : 'Loading both saved copies…');
      elements.btnCloseSongCommunityConflict.disabled = busy;
      elements.btnKeepLocalSongConflict.disabled = busy || !validGuards;
      elements.btnKeepCommunitySongConflict.disabled = busy || !validGuards;
      elements.btnKeepLocalSongConflict.textContent = busy
        ? 'Applying choice…'
        : 'Keep this Mac’s copy';
      elements.btnKeepCommunitySongConflict.textContent = busy
        ? 'Applying choice…'
        : 'Keep Community copy';
    }

    function currentCommunitySharingSnapshot() {
      const visibility = ['private', 'public', 'scheduled-public'].includes(elements.songCommunityVisibility.value)
        ? elements.songCommunityVisibility.value
        : 'private';
      return JSON.stringify({
        visibility,
        publishAt: visibility === 'scheduled-public'
          ? elements.songCommunityPublishAt.value
          : ''
      });
    }

    function communitySharingDraftIsDirty() {
      return state.songCommunityBaseline !== null
        && currentCommunitySharingSnapshot() !== state.songCommunityBaseline;
    }

    function communityVisibilityDescription(visibility, publishAt) {
      if (visibility === 'public') return 'Community members can find this song now.';
      if (visibility === 'scheduled-public') {
        if (!publishAt || !Number.isFinite(Date.parse(publishAt))) {
          return 'Choose the date and time when Community members may find this song.';
        }
        let formatted = publishAt;
        try {
          formatted = new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
          }).format(new Date(publishAt));
        } catch (_error) {
          // Keep the server timestamp when the platform cannot format it.
        }
        return `Community members can find this song after ${formatted}.`;
      }
      return 'Only Community admins can find this song.';
    }

    function setSongCommunityMessage(kind, title, detail) {
      elements.songCommunityState.dataset.kind = kind || 'idle';
      const strong = elements.songCommunityState.querySelector('strong');
      const copy = elements.songCommunityState.querySelector('span');
      strong.textContent = title;
      copy.textContent = detail;
    }

    function renderSongCommunityState() {
      const available = communitySongApiAvailable();
      const visibility = ['private', 'public', 'scheduled-public'].includes(elements.songCommunityVisibility.value)
        ? elements.songCommunityVisibility.value
        : 'private';
      const scheduled = visibility === 'scheduled-public';
      const conflict = communitySongHasConflict(state.songCommunityRemoteState);
      const archived = state.songCommunityRemoteState?.archived === true;
      const readOnly = state.songCommunityRemoteState?.canWriteSongs === false;
      const disconnected = state.songCommunityRemoteState?.connected === false;
      const existingStateUnknown = Boolean(state.songEditingId)
        && !state.songCommunityLoaded
        && !state.songCommunityError;
      const controlsDisabled = state.songSaveBusy
        || state.songCommunityBusy
        || !available
        || conflict
        || archived
        || readOnly
        || disconnected
        || existingStateUnknown;

      elements.songCommunityPublishAtField.hidden = !scheduled;
      elements.songCommunityVisibility.disabled = controlsDisabled;
      elements.songCommunityPublishAt.disabled = controlsDisabled || !scheduled;
      elements.songCommunityPublishAt.required = scheduled && !elements.songCommunityPublishAt.disabled;
      elements.btnReviewSongCommunityConflict.hidden = !conflict;
      elements.btnReviewSongCommunityConflict.disabled = !conflict
        || !communityConflictApiAvailable()
        || state.songCommunityBusy
        || state.songCommunityConflictBusy;
      elements.btnSaveSong.disabled = state.songSaveBusy
        || state.songCommunityBusy
        || state.songCommunityConflictBusy
        || conflict;

      if (!available) {
        setSongCommunityMessage(
          'warning',
          'Community sharing is not included in this build',
          'The song still saves to the local library. Open a newer SyncShow build to share it with Heritage Community.'
        );
        return;
      }
      if (state.songCommunityBusy || existingStateUnknown) {
        setSongCommunityMessage(
          'pending',
          'Checking Community copy…',
          'SyncShow is reading the current visibility and sync version before allowing a change.'
        );
        return;
      }
      if (conflict) {
        setSongCommunityMessage(
          'conflict',
          'Sync conflict needs review',
          state.songCommunityError
            || (communityConflictApiAvailable()
              ? 'The local and Community copies both changed. Review both saved copies here; SyncShow will not overwrite either one until you choose.'
              : 'The local and Community copies both changed. Open a newer SyncShow build to review them; neither copy was overwritten.')
        );
        return;
      }
      if (archived) {
        setSongCommunityMessage(
          'warning',
          'Community copy is archived',
          'SyncShow will not silently republish an archived song. Sync from Admin Settings and review it first.'
        );
        return;
      }
      if (readOnly) {
        setSongCommunityMessage(
          'warning',
          'This connection is read-only',
          'An approved Community song editor must reconnect this computer before visibility can be changed.'
        );
        return;
      }
      if (state.songCommunityError) {
        setSongCommunityMessage(
          'error',
          disconnected ? 'Connect Heritage Community first' : 'Community settings need attention',
          state.songCommunityError
        );
        return;
      }
      if (!state.songEditingId) {
        setSongCommunityMessage(
          'idle',
          'New songs start private',
          'SyncShow saves the local song first, then applies this Community visibility.'
        );
        return;
      }
      if (state.songCommunityRemoteState?.exists === false
        || communitySongStatusKey(state.songCommunityRemoteState) === 'local-only') {
        setSongCommunityMessage(
          'pending',
          'Not on Community yet',
          `${communityVisibilityDescription(visibility, communityPublishAtIso(elements.songCommunityPublishAt.value))} It will be added after you save.`
        );
        return;
      }
      const syncState = communitySongStatusKey(state.songCommunityRemoteState);
      const stateKind = ['pending', 'dirty', 'local-newer', 'remote-newer'].includes(syncState)
        ? 'pending'
        : 'synced';
      setSongCommunityMessage(
        stateKind,
        stateKind === 'synced' ? 'Community copy is current' : 'Community update is pending',
        communityVisibilityDescription(visibility, communityPublishAtIso(elements.songCommunityPublishAt.value))
      );
    }

    async function loadSongCommunityState(songId) {
      const request = ++state.songCommunityRequest;
      state.songCommunityError = null;
      state.songCommunityRemoteState = songId ? null : { exists: false, status: 'local-only' };
      state.songCommunityExpectedSyncVersion = null;
      state.songCommunityLoaded = !songId;
      elements.songCommunityVisibility.value = 'private';
      elements.songCommunityPublishAt.value = '';
      state.songCommunityBaseline = currentCommunitySharingSnapshot();
      renderSongCommunityState();
      if (!songId || !communitySongApiAvailable()) return;

      state.songCommunityBusy = true;
      renderSongCommunityState();
      try {
        const result = checkedResult(await api.getCommunitySongState({ songId }));
        if (request !== state.songCommunityRequest || state.songEditingId !== songId) return;
        const remoteState = result?.songState && typeof result.songState === 'object'
          ? result.songState
          : result;
        state.songCommunityRemoteState = remoteState && typeof remoteState === 'object'
          ? remoteState
          : { exists: false, status: 'local-only' };
        state.songCommunityExpectedSyncVersion = communitySyncVersionOf(state.songCommunityRemoteState);
        state.songCommunityLoaded = true;
        elements.songCommunityVisibility.value = communityVisibilityOf(state.songCommunityRemoteState);
        elements.songCommunityPublishAt.value = localDateTimeValue(
          state.songCommunityRemoteState.publishAt || state.songCommunityRemoteState.remote?.publishAt
        );
        state.songCommunityBaseline = currentCommunitySharingSnapshot();
      } catch (error) {
        if (request !== state.songCommunityRequest || state.songEditingId !== songId) return;
        const message = errorMessage(error, 'The Community copy could not be checked.');
        state.songCommunityError = message;
        if (['COMMUNITY_CONFLICT', 'SONG_SYNC_CONFLICT', 'SYNC_CONFLICT'].includes(error?.code)
          || /conflict|both changed|changed on the server/i.test(message)) {
          state.songCommunityRemoteState = { conflict: true, status: 'conflict' };
          state.songCommunityLoaded = true;
        }
      } finally {
        if (request === state.songCommunityRequest) {
          state.songCommunityBusy = false;
          renderSongCommunityState();
        }
      }
    }

    async function loadSongCommunityConflict(songId, options) {
      const preserveStatus = typeof options?.preserveStatus === 'string'
        ? options.preserveStatus
        : '';
      if (!songId || !communityConflictApiAvailable()) return null;
      state.songCommunityConflictBusy = true;
      state.songCommunityConflictError = null;
      renderSongCommunityState();
      renderSongCommunityConflictDialog();
      try {
        const result = checkedResult(await api.getCommunitySongConflict({ songId }));
        if (state.songEditingId !== songId) return null;
        const conflict = communityConflictPayloadOf(result);
        if (!conflict
          || !Array.isArray(conflict.localDocuments)
          || !Array.isArray(conflict.communityDocuments)) {
          throw new Error('SyncShow could not read both saved copies. Close this review and sync songs again.');
        }
        state.songCommunityConflict = conflict;
        state.songCommunityConflictError = null;
        return conflict;
      } catch (error) {
        if (state.songEditingId !== songId) return null;
        state.songCommunityConflict = null;
        state.songCommunityConflictError = errorMessage(
          error,
          'The saved song copies could not be loaded for review.'
        );
        return null;
      } finally {
        if (state.songEditingId === songId) {
          state.songCommunityConflictBusy = false;
          renderSongCommunityState();
          renderSongCommunityConflictDialog();
          if (preserveStatus && state.songCommunityConflict) {
            elements.songCommunityConflictStatus.dataset.kind = 'warning';
            elements.songCommunityConflictStatus.textContent = preserveStatus;
          }
        }
      }
    }

    async function openSongCommunityConflict() {
      const songId = state.songEditingId;
      if (!songId
        || !communitySongHasConflict(state.songCommunityRemoteState)
        || !communityConflictApiAvailable()
        || state.songCommunityConflictBusy) return;
      state.songCommunityConflict = null;
      state.songCommunityConflictError = null;
      renderSongCommunityConflictDialog();
      if (!elements.songCommunityConflictDialog.open) {
        elements.songCommunityConflictDialog.showModal();
      }
      await loadSongCommunityConflict(songId);
    }

    function closeSongCommunityConflict() {
      if (state.songCommunityConflictBusy) return;
      closeDialog(elements.songCommunityConflictDialog, elements.btnReviewSongCommunityConflict);
      state.songCommunityConflict = null;
      state.songCommunityConflictError = null;
      renderSongCommunityConflictDialog();
    }

    async function refreshSongEditorAfterConflictResolution(songId) {
      await refreshSongsAfterCommunityConflict();
      const payload = checkedResult(await api.readSongDocument({ songId }));
      fillSongEditor(payload?.song || null, {
        revisionId: payload?.revisionId || payload?.revision
      });
      await loadSongCommunityState(songId);
      const selected = selectedRow()?.item;
      if (selected?.kind === 'song') {
        await loadTranslationCandidates(selected, { force: true });
      }
      renderAll();
    }

    async function resolveSongCommunityConflict(strategy) {
      const songId = state.songEditingId;
      const conflict = state.songCommunityConflict;
      if (!songId
        || !['keep-local', 'keep-remote'].includes(strategy)
        || !communityConflictApiAvailable()
        || state.songCommunityConflictBusy
        || !communityConflictGuardsAreValid(conflict)) return;
      const confirmation = strategy === 'keep-local'
        ? 'Keep this Mac’s saved copy and replace the Community song family? This publishes every saved local translation. Unsaved edits in this form are not included, and the editor will reload. Continue?'
        : 'Keep the Community copy on this Mac? Matching saved local song documents will be replaced. Extra local translations are retained and may keep this conflict open. Unsaved edits in this form are not included, and the editor will reload. Continue?';
      if (!window.confirm(confirmation)) return;

      state.songCommunityConflictBusy = true;
      state.songCommunityConflictError = null;
      renderSongCommunityState();
      renderSongCommunityConflictDialog();
      try {
        const result = checkedResult(await api.resolveCommunitySongConflict({
          songId,
          strategy,
          expectedSyncVersion: conflict.expectedSyncVersion,
          expectedLocalRevision: conflict.expectedLocalRevision
        }));
        const resolution = result?.resolved && typeof result.resolved === 'object'
          ? result.resolved
          : result;
        const warningCode = resolution?.warningCode
          || result?.warningCode
          || result?.lastSync?.warningCode;
        if (resolution?.resolved !== true) {
          const retainedWarning = warningCode === 'RETAINED_LOCAL_DOCUMENTS'
            ? 'Community was applied to matching songs, but extra local translations were retained. The conflict remains. Review the refreshed copies, then keep this Mac’s copy if the full local family should be published.'
            : (result?.warning
              || 'The conflict remains because SyncShow could not safely apply that choice. Neither remaining copy was overwritten.');
          state.songCommunityConflictBusy = false;
          state.songCommunityRemoteState = {
            ...(result?.songState || state.songCommunityRemoteState || {}),
            conflict: result?.songState?.conflict || { code: warningCode || 'CONFLICT_RETAINED' },
            status: 'conflict'
          };
          state.songCommunityError = retainedWarning;
          await refreshSongsAfterCommunityConflict();
          await loadSongCommunityState(songId);
          await loadSongCommunityConflict(songId, { preserveStatus: retainedWarning });
          setNotice('warning', retainedWarning, { global: true });
          return;
        }

        state.songCommunityConflictBusy = false;
        closeSongCommunityConflict();
        await refreshSongEditorAfterConflictResolution(songId);
        const successMessage = strategy === 'keep-local'
          ? 'Conflict resolved. This Mac’s saved song family is now the Community copy.'
          : 'Conflict resolved. The Community copy is now saved on this Mac.';
        elements.songValidation.dataset.kind = 'success';
        elements.songValidation.textContent = successMessage;
        setNotice('success', successMessage, { global: true });
      } catch (error) {
        state.songCommunityConflictError = errorMessage(
          error,
          'The conflict choice could not be applied. Reload the review before trying again.'
        );
        if (['COMMUNITY_RESOLUTION_STALE', 'RESOLUTION_STALE'].includes(error?.code)
          || /reload|changed|stale/i.test(state.songCommunityConflictError)) {
          state.songCommunityConflictError = `${state.songCommunityConflictError} Close and reopen this review to load the latest copies.`;
        }
        setNotice('error', state.songCommunityConflictError, { global: true });
      } finally {
        state.songCommunityConflictBusy = false;
        renderSongCommunityState();
        renderSongCommunityConflictDialog();
      }
    }

    async function saveSongCommunityVisibility(songId) {
      if (!communitySongApiAvailable()) {
        return {
          applied: false,
          message: 'This build saved the song locally but does not include Community sharing.'
        };
      }
      if (communitySongHasConflict(state.songCommunityRemoteState)) {
        return {
          applied: false,
          conflict: true,
          message: 'The song was saved locally. Its Community conflict was not overwritten.'
        };
      }
      if (state.songCommunityRemoteState?.archived === true) {
        return {
          applied: false,
          message: 'The song was saved locally. Its archived Community copy was not republished.'
        };
      }
      const visibility = elements.songCommunityVisibility.value;
      const publishAt = visibility === 'scheduled-public'
        ? communityPublishAtIso(elements.songCommunityPublishAt.value)
        : null;
      if (visibility === 'scheduled-public' && !publishAt) {
        return {
          applied: false,
          message: 'The song was saved locally. Choose a valid Community publish date and save again.'
        };
      }

      state.songCommunityBusy = true;
      state.songCommunityError = null;
      renderSongCommunityState();
      try {
        const result = checkedResult(await api.setCommunitySongVisibility({
          songId,
          visibility,
          publishAt,
          expectedSyncVersion: state.songCommunityExpectedSyncVersion
        }));
        const remoteState = result?.songState && typeof result.songState === 'object'
          ? result.songState
          : result;
        state.songCommunityRemoteState = {
          ...(remoteState && typeof remoteState === 'object' ? remoteState : {}),
          exists: remoteState?.exists !== false,
          visibility,
          publishAt,
          status: communitySongStatusKey(remoteState) || 'synced'
        };
        state.songCommunityExpectedSyncVersion = communitySyncVersionOf(state.songCommunityRemoteState);
        state.songCommunityLoaded = true;
        state.songCommunityBaseline = currentCommunitySharingSnapshot();
        return { applied: true };
      } catch (error) {
        const message = errorMessage(error, 'Community visibility could not be updated.');
        const conflict = ['COMMUNITY_CONFLICT', 'SONG_SYNC_CONFLICT', 'SYNC_CONFLICT'].includes(error?.code)
          || /conflict|both changed|changed on the server/i.test(message);
        state.songCommunityError = message;
        if (conflict) {
          state.songCommunityRemoteState = {
            ...(state.songCommunityRemoteState || {}),
            conflict: true,
            status: 'conflict'
          };
        }
        return {
          applied: false,
          conflict,
          message: conflict
            ? 'The song was saved locally. The Community copy also changed, so neither copy was overwritten.'
            : `The song was saved locally. Community sharing needs attention: ${message}`
        };
      } finally {
        state.songCommunityBusy = false;
        renderSongCommunityState();
      }
    }

    function populateSongFamilyChoices(selectedId = '') {
      elements.songTranslationOf.replaceChildren();
      appendOption(elements.songTranslationOf, '', 'Original song');
      const roots = state.songs.filter(summary => !summary.translationOf);
      let selectedFound = false;
      for (const summary of roots) {
        const songId = songIdOf(summary);
        if (!songId || songId === state.songEditingId) continue;
        const option = appendOption(
          elements.songTranslationOf,
          songId,
          `${summary.title || songId}${summary.language ? ` · ${summary.language}` : ''}`
        );
        if (songId === selectedId) {
          option.selected = true;
          selectedFound = true;
        }
      }
      if (selectedId && !selectedFound && selectedId !== state.songEditingId) {
        const preserved = appendOption(
          elements.songTranslationOf,
          selectedId,
          `Original: ${selectedId} · preserved from this song`
        );
        preserved.selected = true;
      }
    }

    async function refreshSongsAfterCommunityConflict() {
      return loadSongs();
    }

    function fillSongEditor(song = null, options = {}) {
      state.songValidationRequest += 1;
      state.songCommunityRequest += 1;
      state.songEditingSong = song;
      state.songEditingId = song?.id || null;
      state.songEditingRevisionId = options.revisionId || null;
      elements.songForm.reset();
      elements.songDialogTitle.textContent = song ? `Edit ${song.title}` : (options.translateFrom ? 'Create a translation' : 'Create a song');
      elements.songTitle.value = song?.title || (options.translateFrom ? `${options.translateFrom.title || 'Song'} translation` : '');
      elements.songLanguage.value = song?.language || (options.translateFrom ? '' : 'en');
      const familyId = song?.translationOf
        || (options.translateFrom ? (options.translateFrom.translationOf || songIdOf(options.translateFrom)) : '');
      populateSongFamilyChoices(familyId);
      elements.songLyrics.value = song
        ? songLyricsSource(song)
        : options.templateSong
          ? songLyricsSource({
              sections: options.templateSong.sections.map(section => ({
                ...section,
                slides: section.slides.map(slide => ({
                  ...slide,
                  lines: ['[Translate this slide]']
                }))
              }))
            })
          : '^1\n';
      elements.songAuthors.value = (song?.authors || []).join(', ');
      elements.songTranslators.value = (song?.translators || []).join(', ');
      elements.songComposers.value = (song?.composers || []).join(', ');
      elements.songTags.value = (song?.tags || []).join(', ');
      elements.songAttribution.value = song?.attribution || '';
      elements.songLicense.value = song?.license || '';
      elements.songSource.value = song?.source || '';
      elements.songCommunityVisibility.value = 'private';
      elements.songCommunityPublishAt.value = '';
      state.songCommunityBusy = false;
      state.songCommunityLoaded = !song;
      state.songCommunityRemoteState = song ? null : { exists: false, status: 'local-only' };
      state.songCommunityExpectedSyncVersion = null;
      state.songCommunityError = null;
      state.songCommunityConflict = null;
      state.songCommunityConflictBusy = false;
      state.songCommunityConflictError = null;
      state.songCommunityBaseline = currentCommunitySharingSnapshot();
      elements.songValidation.dataset.kind = '';
      elements.songValidation.textContent = 'Choose “Check song” to verify its sections and slide breaks before saving.';
      setDialogError(elements.songError, '');
      state.songBaselineSource = currentSongDocumentSource();
      state.songDraftDirty = false;
      elements.btnCancelSong.textContent = state.songEditingRevisionId ? 'Close' : 'Cancel';
      renderSongCommunityState();
    }

    async function openSongEditor(summary = null, options = {}) {
      if (state.mutationBusy || state.publishBusy) return;
      state.mutationBusy = true;
      setNotice('busy', summary ? 'Opening the song editor…' : 'Preparing a new song…');
      updateControlStates();
      try {
        let payload = null;
        let templateSong = null;
        if (summary) {
          payload = checkedResult(await api.readSongDocument({
            songId: songIdOf(summary),
            revisionId: songRevisionOf(summary)
          }));
        } else if (options.translateFrom) {
          const base = checkedResult(await api.readSongDocument({
            songId: songIdOf(options.translateFrom),
            revisionId: songRevisionOf(options.translateFrom)
          }));
          templateSong = base.song;
        }
        fillSongEditor(payload?.song || null, {
          revisionId: payload?.revisionId || payload?.revision,
          translateFrom: options.translateFrom || null,
          templateSong
        });
        elements.songDialog.showModal();
        loadSongCommunityState(state.songEditingId);
        window.setTimeout(() => elements.songTitle.focus(), 0);
        setNotice('', 'Song editor open.');
      } catch (error) {
        setNotice('error', errorMessage(error, 'The song editor could not be opened.'), { global: true });
      } finally {
        state.mutationBusy = false;
        renderAll();
      }
    }

    function currentSongDocumentSource() {
      return buildSongDocumentSource({
        songId: state.songEditingId,
        title: elements.songTitle.value.trim(),
        language: elements.songLanguage.value.trim(),
        translationOf: elements.songTranslationOf.value,
        lyrics: elements.songLyrics.value,
        authors: splitCommaList(elements.songAuthors.value),
        translators: splitCommaList(elements.songTranslators.value),
        composers: splitCommaList(elements.songComposers.value),
        tags: splitCommaList(elements.songTags.value),
        attribution: elements.songAttribution.value.trim(),
        license: elements.songLicense.value.trim(),
        source: elements.songSource.value.trim()
      }, state.songEditingSong);
    }

    function setSongFormBusy(busy) {
      state.songSaveBusy = busy;
      for (const control of elements.songForm.querySelectorAll('input, textarea, select, button')) {
        control.disabled = busy;
      }
      renderSongCommunityState();
    }

    function markSongDraftDirty() {
      if (state.songSaveBusy) return;
      state.songValidationRequest += 1;
      state.songDraftDirty = true;
      elements.btnCancelSong.textContent = 'Cancel';
      elements.songValidation.dataset.kind = '';
      elements.songValidation.textContent = 'Unsaved changes. Check the song again, or save when you are ready.';
      setDialogError(elements.songError, '');
    }

    function songDraftIsDirty() {
      if (!state.songDraftDirty || state.songBaselineSource === null) return false;
      return currentSongDocumentSource() !== state.songBaselineSource
        || communitySharingDraftIsDirty();
    }

    function closeSongEditor() {
      if (state.songSaveBusy) return false;
      if (state.songCommunityConflictBusy) return false;
      const dirty = songDraftIsDirty();
      if (dirty && !window.confirm('Discard the unsaved changes in this song?')) return false;
      state.songValidationRequest += 1;
      state.songCommunityRequest += 1;
      if (elements.songCommunityConflictDialog.open) {
        elements.songCommunityConflictDialog.close();
      }
      closeDialog(elements.songDialog, elements.btnNewSong);
      state.songBaselineSource = null;
      state.songCommunityBaseline = null;
      state.songCommunityConflict = null;
      state.songCommunityConflictError = null;
      state.songDraftDirty = false;
      return true;
    }

    function guardSongDraftBeforeUnload(event) {
      if (!elements.songDialog.open) return;
      if (state.songSaveBusy) {
        event.preventDefault();
        event.returnValue = false;
        setNotice('busy', 'Wait for the song to finish saving before closing SyncShow.');
        return;
      }
      if (!songDraftIsDirty()) return;
      if (window.confirm('Discard the unsaved song changes and close SyncShow?')) return;
      event.preventDefault();
      event.returnValue = false;
    }

    function guardEditItemDraftBeforeUnload(event) {
      if (!elements.editItemDialog.open) return;
      if (state.mutationBusy || state.publishBusy) {
        event.preventDefault();
        event.returnValue = false;
        setNotice('busy', 'Wait for the service item to finish saving before closing SyncShow.');
        return;
      }
      if (!editItemDraftIsDirty()) return;
      if (window.confirm('Discard the unsaved service-item changes and close SyncShow?')) return;
      event.preventDefault();
      event.returnValue = false;
    }

    async function validateSongDraft({
      announce = false,
      documentSource = currentSongDocumentSource()
    } = {}) {
      const request = ++state.songValidationRequest;
      elements.songValidation.dataset.kind = '';
      elements.songValidation.textContent = 'Checking sections, slide breaks, and translation alignment…';
      setDialogError(elements.songError, '');
      try {
        const result = checkedResult(await api.validateSongDocument({
          documentSource,
          ...(state.songEditingId ? { editingSongId: state.songEditingId } : {})
        }));
        if (request !== state.songValidationRequest) return null;
        if (result?.valid === false) {
          const diagnostic = Array.isArray(result.diagnostics)
            ? result.diagnostics.find(item => item?.severity === 'error')
            : null;
          const message = diagnostic?.message || 'The song needs another edit before it can be saved.';
          elements.songValidation.dataset.kind = 'warning';
          elements.songValidation.textContent = message;
          setDialogError(elements.songError, message);
          return null;
        }
        const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
        const warning = diagnostics.find(item => item?.severity === 'warning')
          || result?.relationship?.warnings?.[0]
          || (result?.relationship?.compatible === false ? { message: 'The translation structure does not align yet.' } : null);
        const sectionCount = result?.song?.sections?.length || result?.summary?.sectionCount || 0;
        const slideCount = result?.song?.sections?.reduce(
          (total, section) => total + (section.slides?.length || 0),
          0
        ) || 0;
        elements.songValidation.dataset.kind = warning ? 'warning' : 'success';
        elements.songValidation.textContent = warning
          ? `${sectionCount} sections and ${slideCount} slides. ${warning.message || 'This draft can be saved, but it cannot be linked until its structure matches the original.'}`
          : `${sectionCount} sections and ${slideCount} slides are valid${result?.song?.translationOf ? ' and aligned for translation linking' : ''}.`;
        if (announce) {
          setNotice(
            warning ? '' : 'success',
            warning ? 'The song can be saved as a draft; review the warning in the editor.' : 'The song structure is valid.'
          );
        }
        return result;
      } catch (error) {
        if (request === state.songValidationRequest) {
          const message = errorMessage(error, 'The song needs another edit before it can be saved.');
          elements.songValidation.dataset.kind = 'warning';
          elements.songValidation.textContent = message;
          setDialogError(elements.songError, message);
        }
        return null;
      }
    }

    async function saveSongDraft(event) {
      event.preventDefault();
      if (state.mutationBusy || state.publishBusy) return;
      state.mutationBusy = true;
      setSongFormBusy(true);
      const documentSource = currentSongDocumentSource();
      setNotice('busy', 'Checking and saving the song to the local library…');
      updateControlStates();
      try {
        const validation = await validateSongDraft({ documentSource });
        if (!validation) return;
        setNotice('busy', 'Saving the song to the local library…');
        const result = checkedResult(await api.saveSongDocument({
          songId: state.songEditingId,
          expectedRevisionId: state.songEditingRevisionId,
          documentSource: validation.documentSource || validation.source || documentSource
        }));
        state.songEditingSong = result.song;
        state.songEditingId = result.song?.id || result.summary?.id || state.songEditingId;
        state.songEditingRevisionId = result.revisionId || result.revision;
        state.songBaselineSource = currentSongDocumentSource();
        state.songDraftDirty = false;
        elements.songDialogTitle.textContent = `Edit ${result.song?.title || elements.songTitle.value.trim()}`;
        elements.btnCancelSong.textContent = 'Close';
        setNotice('busy', 'Song saved locally. Applying its Community visibility…');
        const communityResult = state.songEditingId
          ? await saveSongCommunityVisibility(state.songEditingId)
          : {
              applied: false,
              message: 'The song was saved locally, but SyncShow did not return its library ID for Community sharing.'
            };
        state.songQuery = '';
        elements.songSearch.value = '';
        await loadSongs();
        const selected = selectedRow()?.item;
        if (selected?.kind === 'song') await loadTranslationCandidates(selected, { force: true });
        const message = result.unchanged
          ? 'The library already contains this exact song.'
          : 'Library updated. Services already using this song are unchanged.';
        const finalMessage = communityResult.applied
          ? `${message} Community visibility updated.`
          : `${message} ${communityResult.message}`;
        elements.songValidation.dataset.kind = communityResult.applied ? 'success' : 'warning';
        elements.songValidation.textContent = finalMessage;
        setNotice(communityResult.applied ? 'success' : 'warning', finalMessage, { global: true });
      } catch (error) {
        const message = errorMessage(error, 'The song could not be saved.');
        setDialogError(elements.songError, message);
        setNotice('error', `${message} Your draft is still open.`, { global: true });
      } finally {
        state.mutationBusy = false;
        setSongFormBusy(false);
        renderAll();
      }
    }

    async function addSong(summary) {
      const songId = songIdOf(summary);
      const songRevisionId = songRevisionOf(summary);
      const title = summary.title || songId;
      const selected = selectedRow()?.item;
      const parentId = selected?.kind === 'group' ? selected.id : undefined;
      await mutateProject(
        `Adding ${title}…`,
        () => api.addSongToService({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          songId,
          songRevisionId,
          ...(parentId ? { parentId } : {})
        }),
        `${title} was added to the service.`
      );
    }

    function openTextDialog() {
      if (!state.currentProject || state.mutationBusy || state.publishBusy) return;
      elements.textForm.reset();
      elements.textKind.value = 'sermon';
      elements.textBodyField.hidden = false;
      elements.textTitle.placeholder = 'Main point';
      setDialogError(elements.textError, '');
      elements.textDialog.showModal();
      window.setTimeout(() => elements.textTitle.focus(), 0);
    }

    async function addText(event) {
      event.preventDefault();
      const kind = elements.textKind.value;
      const title = elements.textTitle.value.trim();
      const text = elements.textBody.value.trim();
      if (!title || !['sermon', 'notice', 'blank'].includes(kind) || (kind !== 'blank' && !text)) return;
      setDialogError(elements.textError, '');
      const parent = selectedRow()?.item;
      const parentId = parent?.kind === 'group' ? parent.id : undefined;
      const kindLabel = kind === 'sermon' ? 'the sermon point' : kind === 'notice' ? 'the notice' : 'the blank cue';
      const result = await mutateProject(
        `Adding ${kindLabel}…`,
        () => api.addTextToService({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          kind,
          title,
          ...(kind !== 'blank' ? { text } : {}),
          ...(parentId ? { parentId } : {})
        }),
        `${title} was added to the service.`
      );
      if (result) elements.textDialog.close();
      else setDialogError(elements.textError, 'The slide was not added. Review the message above and try again.');
    }

    function openPictureDialog() {
      if (!state.currentProject || state.mutationBusy || state.publishBusy) return;
      elements.pictureForm.reset();
      setDialogError(elements.pictureError, '');
      elements.pictureDialog.showModal();
      window.setTimeout(() => elements.pictureAlt.focus(), 0);
    }

    async function addPicture(event) {
      event.preventDefault();
      const altText = elements.pictureAlt.value.trim();
      const attribution = elements.pictureAttribution.value.trim();
      if (!altText) return;
      setDialogError(elements.pictureError, '');
      const selected = selectedRow()?.item;
      const parentId = selected?.kind === 'group' ? selected.id : undefined;
      const existingItemIds = new Set(Object.keys(state.currentProject.items || {}));
      const customizeOutputs = elements.pictureCustomizeOutputs.checked;
      const result = await mutateProject(
        'Choose the picture file…',
        () => api.addPictureToService({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          altText,
          attribution,
          ...(parentId ? { parentId } : {})
        }),
        'The picture was added to the service.'
      );
      if (result?.cancelled) return;
      if (result) {
        const added = Object.values(result.project.items || {})
          .find(item => item.kind === 'picture' && !existingItemIds.has(item.id));
        if (added) state.selectedItemId = added.id;
        elements.pictureDialog.close();
        renderAll();
        if (customizeOutputs && added) {
          window.setTimeout(() => openEditItemDialog(), 0);
        }
      } else {
        setDialogError(elements.pictureError, 'The picture was not added. Review the message above and try again.');
      }
    }

    function resetBibleLookup(message = 'Enter a reference, then choose Find.') {
      state.bibleLookupEpoch += 1;
      state.preparedBible = null;
      state.bibleLookupBusy = false;
      elements.bibleAmbiguity.hidden = true;
      elements.bibleAmbiguityChoices.replaceChildren();
      elements.bibleResult.hidden = true;
      elements.biblePreviewReference.textContent = 'Passage preview';
      elements.biblePreviewText.textContent = '';
      elements.bibleStatus.textContent = state.currentProject
        ? message
        : 'Open a service before adding a passage.';
      updateControlStates();
    }

    async function lookupPrepareBible(selectedBookId = null) {
      const reference = elements.bibleReference.value.trim();
      const translationId = elements.bibleTranslation.value;
      if (!state.currentProject || !reference || state.bibleLookupBusy) return;
      const epoch = ++state.bibleLookupEpoch;
      const projectId = state.currentProject.id;
      const revisionId = state.revisionId;
      state.preparedBible = null;
      state.bibleLookupBusy = true;
      elements.bibleAmbiguity.hidden = true;
      elements.bibleAmbiguityChoices.replaceChildren();
      elements.bibleResult.hidden = true;
      elements.bibleStatus.textContent = 'Finding that passage…';
      updateControlStates();
      try {
        const result = checkedResult(await api.lookupBiblePassage({
          query: reference,
          translationId,
          ...(selectedBookId ? { selectedBook: selectedBookId } : {})
        }));
        if (epoch !== state.bibleLookupEpoch
          || projectId !== state.currentProject?.id
          || revisionId !== state.revisionId) {
          return;
        }
        if (result?.status === 'ambiguous' && Array.isArray(result.choices)) {
          elements.bibleStatus.textContent = result.message || 'Choose which book you meant.';
          elements.bibleAmbiguity.hidden = false;
          for (const choice of result.choices) {
            const button = createElement('button', 'btn btn-outline btn-compact', choice.reference || choice.book);
            button.type = 'button';
            button.setAttribute('role', 'option');
            button.addEventListener('click', () => lookupPrepareBible(choice.book));
            elements.bibleAmbiguityChoices.appendChild(button);
          }
          return;
        }
        if (result?.status !== 'ok' || !result.passage) {
          elements.bibleStatus.textContent = result?.message || 'That passage could not be found.';
          return;
        }
        const passage = result.passage;
        state.preparedBible = {
          projectId,
          reference,
          translationId,
          selectedBookId,
          passage
        };
        elements.biblePreviewReference.textContent =
          `${passage.reference} · ${passage.translation?.abbr || translationId}`;
        elements.biblePreviewText.textContent = passage.verses
          .map(verse => `${verse.number} ${verse.text}`)
          .join(' ');
        elements.bibleResult.hidden = false;
        elements.bibleStatus.textContent = 'Check the passage, then add it to the service.';
      } catch (error) {
        if (epoch === state.bibleLookupEpoch) {
          elements.bibleStatus.textContent = errorMessage(error, 'That passage could not be found.');
        }
      } finally {
        if (epoch === state.bibleLookupEpoch) {
          state.bibleLookupBusy = false;
          updateControlStates();
        }
      }
    }

    async function addPreparedBible() {
      const prepared = state.preparedBible;
      if (!prepared || prepared.projectId !== state.currentProject?.id) return;
      const selected = selectedRow()?.item;
      const parentId = selected?.kind === 'group' ? selected.id : undefined;
      const result = await mutateProject(
        `Adding ${prepared.passage.reference}…`,
        () => api.addBiblePassageToService({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          reference: prepared.reference,
          translationId: prepared.translationId,
          ...(prepared.selectedBookId ? { selectedBookId: prepared.selectedBookId } : {}),
          ...(parentId ? { parentId } : {})
        }),
        `${prepared.passage.reference} was added to the service.`
      );
      if (result) {
        elements.bibleReference.value = '';
        resetBibleLookup('Passage added. Enter another reference when you need one.');
      }
    }

    async function saveSelectedSongArrangement(arrangement, busyMessage, successMessage) {
      const row = selectedRow();
      if (row?.item?.kind !== 'song') return null;
      return mutateProject(
        busyMessage,
        () => api.updateSongArrangement({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id,
          arrangement
        }),
        successMessage
      );
    }

    async function addSongArrangementSection() {
      const row = selectedRow();
      const sectionId = elements.songArrangementSection.value;
      if (row?.item?.kind !== 'song' || !sectionId) return;
      const arrangement = [
        ...row.item.arrangement.map(entry => ({ id: entry.id, sectionId: entry.sectionId })),
        { sectionId }
      ];
      const result = await saveSelectedSongArrangement(
        arrangement,
        'Adding the song section…',
        'The song arrangement was updated.'
      );
      if (result) {
        const updated = result.project.items[row.item.id];
        state.selectedArrangementId = updated?.arrangement?.at(-1)?.id || null;
        renderAll();
      }
    }

    async function moveSongArrangementSelection(direction) {
      const row = selectedRow();
      if (row?.item?.kind !== 'song') return;
      const arrangement = row.item.arrangement.map(entry => ({
        id: entry.id,
        sectionId: entry.sectionId
      }));
      const index = arrangement.findIndex(entry => entry.id === state.selectedArrangementId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= arrangement.length) return;
      [arrangement[index], arrangement[targetIndex]] = [arrangement[targetIndex], arrangement[index]];
      await saveSelectedSongArrangement(
        arrangement,
        'Reordering the song…',
        'The song arrangement was updated.'
      );
    }

    async function removeSongArrangementSelection() {
      const row = selectedRow();
      if (row?.item?.kind !== 'song' || row.item.arrangement.length <= 1) return;
      const arrangement = row.item.arrangement
        .filter(entry => entry.id !== state.selectedArrangementId)
        .map(entry => ({ id: entry.id, sectionId: entry.sectionId }));
      if (arrangement.length === row.item.arrangement.length) return;
      const result = await saveSelectedSongArrangement(
        arrangement,
        'Removing the song section…',
        'The song arrangement was updated.'
      );
      if (result) {
        state.selectedArrangementId = null;
        renderAll();
      }
    }

    async function linkSelectedSongTranslation() {
      const row = selectedRow();
      const channelId = elements.songTranslationChannel.value;
      const option = elements.songTranslationSong.selectedOptions[0];
      const songId = option?.dataset.songId;
      const songRevisionId = option?.dataset.songRevisionId;
      if (row?.item?.kind !== 'song' || !channelId || !songId || !songRevisionId) return;
      const channelLabel = state.currentProject.channels?.[channelId]?.label || channelId;
      await mutateProject(
        `Linking ${channelLabel} lyrics…`,
        () => api.linkSongTranslation({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id,
          channelId,
          songId,
          songRevisionId
        }),
        `${option.textContent} now supplies ${channelLabel}.`
      );
    }

    async function resetSelectedSongTranslation(channelId) {
      const row = selectedRow();
      if (row?.item?.kind !== 'song' || !state.currentProject.channels?.[channelId]) return;
      const channelLabel = state.currentProject.channels[channelId].label || channelId;
      await mutateProject(
        `Restoring normal ${channelLabel} behavior…`,
        () => api.resetSongTranslation({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id,
          channelId
        }),
        `${channelLabel} now uses its normal song behavior.`
      );
    }

    async function restoreHistory(direction) {
      if (!state.currentProject || !state.revisionId || state.mutationBusy || state.publishBusy) return;
      const sourceStack = direction === 'undo' ? state.undoStack : state.redoStack;
      const targetStack = direction === 'undo' ? state.redoStack : state.undoStack;
      const targetRevisionId = sourceStack.pop();
      if (!targetRevisionId) return;
      const currentRevisionId = state.revisionId;
      state.mutationBusy = true;
      setNotice('busy', direction === 'undo' ? 'Undoing the last saved change…' : 'Redoing the saved change…');
      updateControlStates();
      try {
        const result = applyProjectResult(await api.restoreServiceProjectRevision({
          projectId: state.currentProject.id,
          expectedRevisionId: currentRevisionId,
          targetRevisionId
        }));
        targetStack.push(currentRevisionId);
        if (targetStack.length > 100) targetStack.shift();
        state.previewRequest += 1;
        state.previewResult = null;
        setNotice(
          'success',
          direction === 'undo' ? 'The last change was undone and autosaved.' : 'The change was redone and autosaved.',
          { global: true }
        );
        await Promise.all([loadProjects(), loadProjectHistory()]);
        if (state.selectedItemId && result.project.items?.[state.selectedItemId]) {
          loadSelectedPreview({ resetOffset: true });
        }
      } catch (error) {
        sourceStack.push(targetRevisionId);
        const message = errorMessage(error, `The ${direction} could not be completed.`);
        if (isProjectConflict(error, message)) {
          try {
            const projectId = state.currentProject.id;
            applyProjectResult(await api.openServiceProject({ projectId }));
            state.selectedArrangementId = null;
            state.translationCandidates = [];
            state.translationFamilyId = null;
            state.translationRequest += 1;
            state.undoStack = [];
            state.redoStack = [];
            state.previewRequest += 1;
            state.previewResult = null;
            state.previewCueOffset = 0;
            await Promise.all([
              loadProjects(),
              loadProjectHistory({ seedUndo: true })
            ]);
            const selected = selectedRow()?.item;
            if (selected) loadSelectedPreview({ resetOffset: true });
            if (selected?.kind === 'song') {
              await loadTranslationCandidates(selected, { force: true });
            }
            setNotice(
              'error',
              `${message} The newest saved version is open now; review it and try again.`,
              { global: true }
            );
            return;
          } catch (reloadError) {
            state.undoStack = [];
            state.redoStack = [];
            setNotice(
              'error',
              `${message} SyncShow could not reload the newest version: ${errorMessage(reloadError, 'unknown error')}`,
              { global: true }
            );
            return;
          }
        }
        setNotice('error', message, { global: true });
      } finally {
        state.mutationBusy = false;
        renderAll();
      }
    }

    function toggleSelectedGroupCollapse() {
      const row = selectedRow();
      if (row?.item?.kind !== 'group') return;
      if (state.collapsedGroupIds.has(row.item.id)) state.collapsedGroupIds.delete(row.item.id);
      else state.collapsedGroupIds.add(row.item.id);
      renderAll();
    }

    async function duplicateSelected() {
      const row = selectedRow();
      if (!row) return;
      const existingIds = new Set(Object.keys(state.currentProject.items || {}));
      const result = await mutateProject(
        `Duplicating ${row.item.title}…`,
        () => api.duplicateServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id
        }),
        `${row.item.title} was duplicated.`
      );
      if (!result) return;
      const addedItems = Object.values(result.project.items || {}).filter(item => !existingIds.has(item.id));
      const duplicate = addedItems.find(item => item.title === `${row.item.title} copy`) || addedItems[0];
      if (duplicate) state.selectedItemId = duplicate.id;
      renderAll();
      loadSelectedPreview({ resetOffset: true });
    }

    async function moveItemById(itemId, direction) {
      const row = currentRows().find(candidate => candidate.item.id === itemId);
      if (!row) return;
      const targetIndex = row.index + direction;
      if (targetIndex < 0 || targetIndex >= row.siblingCount) return;
      await mutateProject(
        'Moving the service item…',
        () => api.moveServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id,
          targetParentId: row.parentId,
          targetIndex
        }),
        `${row.item.title} was moved.`
      );
    }

    async function moveItemRelative(sourceItemId, targetItemId, placement) {
      const destination = reorderDestination(
        state.currentProject,
        sourceItemId,
        targetItemId,
        placement
      );
      const source = currentRows().find(row => row.item.id === sourceItemId);
      if (!destination || !source) return;
      await mutateProject(
        `Moving ${source.item.title}…`,
        () => api.moveServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: source.item.id,
          targetParentId: destination.targetParentId,
          targetIndex: destination.targetIndex
        }),
        `${source.item.title} was moved in the rundown.`
      );
    }

    async function moveSelected(direction) {
      const row = selectedRow();
      if (!row) return;
      await moveItemById(row.item.id, direction);
    }

    async function moveSelectedIntoPreviousGroup() {
      const row = selectedRow();
      const destination = indentDestination(state.currentProject, row);
      if (!row || !destination) return;
      await mutateProject(
        'Nesting the service item…',
        () => api.moveServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id,
          targetParentId: destination.targetParentId,
          targetIndex: destination.targetIndex
        }),
        `${row.item.title} was nested inside the section above.`
      );
    }

    async function moveSelectedOutOneLevel() {
      const row = selectedRow();
      const destination = outdentDestination(state.currentProject, row);
      if (!row || !destination) return;
      await mutateProject(
        'Moving the service item out one level…',
        () => api.moveServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId: row.item.id,
          targetParentId: destination.targetParentId,
          targetIndex: destination.targetIndex
        }),
        `${row.item.title} was moved out one level.`
      );
    }

    async function removeSelected() {
      const row = selectedRow();
      if (!row) return;
      const nestedCount = countDescendants(state.currentProject, row.item.id);
      const question = nestedCount > 0
        ? `Remove “${row.item.title}” and all ${nestedCount} ${nestedCount === 1 ? 'item' : 'items'} inside it from this service?`
        : `Remove “${row.item.title}” from this service?`;
      if (!window.confirm(question)) return;
      const itemId = row.item.id;
      const title = row.item.title;
      const result = await mutateProject(
        `Removing ${title}…`,
        () => api.removeServiceItem({
          projectId: state.currentProject.id,
          expectedRevisionId: state.revisionId,
          itemId
        }),
        `${title} was removed from the service.`
      );
      if (result) state.selectedItemId = null;
      renderAll();
    }

    async function publishProject() {
      if (!state.currentProject || !state.revisionId || state.publishBusy || state.mutationBusy) return;
      state.publishBusy = true;
      setNotice('busy', 'Building the finished slides for Load…', { global: true });
      updateControlStates();
      try {
        const result = checkedResult(await api.publishServiceProject({
          projectId: state.currentProject.id,
          revisionId: state.revisionId
        }));
        setNotice('success', `${state.currentProject.title} is ready in Load.`, { global: true });
        await onPublished(result, {
          project: state.currentProject,
          revisionId: state.revisionId
        });
      } catch (error) {
        const message = errorMessage(error, 'The service could not be prepared for Load.');
        if (isProjectConflict(error, message) && state.currentProject?.id) {
          try {
            applyProjectResult(await api.openServiceProject({ projectId: state.currentProject.id }));
            state.translationCandidates = [];
            state.translationFamilyId = null;
            state.translationRequest += 1;
            setNotice(
              'error',
              `${message} The newest saved version is open now; review it before preparing Load.`,
              { global: true }
            );
            await loadProjects();
          } catch (reloadError) {
            setNotice(
              'error',
              `${message} SyncShow could not reload the newest version: ${errorMessage(reloadError, 'unknown error')}`,
              { global: true }
            );
          }
        } else {
          setNotice('error', message, { global: true });
        }
      } finally {
        state.publishBusy = false;
        renderAll();
      }
    }

    function handlePublishProgress(progress = {}) {
      if (!state.publishBusy) return;
      const completed = Number(progress.completed);
      const total = Number(progress.total);
      if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1) return;
      setNotice('busy', `Preparing offline Show… ${Math.min(completed, total)} of ${total}`);
    }

    function scheduleProjectSearch() {
      window.clearTimeout(state.projectTimer);
      state.projectTimer = window.setTimeout(() => {
        state.projectQuery = elements.projectSearch.value.trim();
        loadProjects();
      }, SEARCH_DELAY_MS);
    }

    function scheduleSongSearch() {
      window.clearTimeout(state.songTimer);
      const nextQuery = elements.songSearch.value.trim();
      if (nextQuery !== state.songQuery) {
        state.songQuery = nextQuery;
        state.songRequest += 1;
        state.songNextOffset = null;
        state.songsBusy = true;
        state.songsLoadingMore = false;
        renderSongList();
        updateControlStates();
      }
      state.songTimer = window.setTimeout(() => {
        loadSongs();
      }, SEARCH_DELAY_MS);
    }

    function closeDialog(dialog, focusTarget) {
      if (dialog.open) dialog.close();
      focusTarget?.focus();
    }

    function bindDialogCancel(dialog, focusTarget) {
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeDialog(dialog, focusTarget);
      });
    }

    function bindEvents() {
      elements.btnNewProject.addEventListener('click', openNewProjectDialog);
      elements.btnImportProject.addEventListener('click', importProject);
      elements.btnExportProject.addEventListener('click', exportProject);
      elements.btnUndo.addEventListener('click', () => restoreHistory('undo'));
      elements.btnRedo.addEventListener('click', () => restoreHistory('redo'));
      elements.projectSearch.addEventListener('input', scheduleProjectSearch);
      elements.songSearch.addEventListener('input', scheduleSongSearch);
      elements.btnLoadMoreSongs.addEventListener('click', () => loadSongs({ append: true }));
      elements.btnNewSong.addEventListener('click', () => openSongEditor());
      elements.btnImportSong.addEventListener('click', importSong);
      elements.btnPublish.addEventListener('click', publishProject);
      elements.btnAddGroup.addEventListener('click', () => openGroupDialog());
      elements.btnAddText.addEventListener('click', openTextDialog);
      elements.textKind.addEventListener('change', () => {
        const blank = elements.textKind.value === 'blank';
        elements.textBodyField.hidden = blank;
        elements.textTitle.placeholder = blank ? 'Example: Pause / black screen' : 'Main point';
        if (blank) elements.textBody.value = '';
      });
      elements.btnAddPicture.addEventListener('click', openPictureDialog);
      elements.btnEdit.addEventListener('click', openEditItemDialog);
      elements.btnDuplicate.addEventListener('click', duplicateSelected);
      elements.btnAddInside.addEventListener('click', () => {
        const row = selectedRow();
        if (row?.item?.kind === 'group') openGroupDialog(row.item.id);
      });
      elements.btnCollapseGroup.addEventListener('click', toggleSelectedGroupCollapse);
      elements.btnMoveUp.addEventListener('click', () => moveSelected(-1));
      elements.btnMoveDown.addEventListener('click', () => moveSelected(1));
      elements.btnIndent.addEventListener('click', moveSelectedIntoPreviousGroup);
      elements.btnOutdent.addEventListener('click', moveSelectedOutOneLevel);
      elements.btnRemove.addEventListener('click', removeSelected);
      elements.previewChannel.addEventListener('change', () => {
        state.previewChannelId = elements.previewChannel.value;
        loadSelectedPreview({ resetOffset: true });
      });
      elements.btnPreviousPreview.addEventListener('click', () => shiftPreview(-1));
      elements.btnNextPreview.addEventListener('click', () => shiftPreview(1));
      elements.songArrangementSection.addEventListener('change', updateControlStates);
      elements.btnAddSongArrangementSection.addEventListener('click', addSongArrangementSection);
      elements.btnMoveSongArrangementUp.addEventListener('click', () => moveSongArrangementSelection(-1));
      elements.btnMoveSongArrangementDown.addEventListener('click', () => moveSongArrangementSelection(1));
      elements.btnRemoveSongArrangementItem.addEventListener('click', removeSongArrangementSelection);
      elements.songTranslationChannel.addEventListener('change', updateControlStates);
      elements.songTranslationSong.addEventListener('change', updateControlStates);
      elements.btnLinkSongTranslation.addEventListener('click', linkSelectedSongTranslation);

      elements.bibleReference.addEventListener('input', () => {
        if (state.preparedBible || !elements.bibleResult.hidden || !elements.bibleAmbiguity.hidden) {
          resetBibleLookup();
        } else {
          updateControlStates();
        }
      });
      elements.bibleTranslation.addEventListener('change', () => resetBibleLookup());
      elements.btnLookupBible.addEventListener('click', () => lookupPrepareBible());
      elements.btnAddBible.addEventListener('click', addPreparedBible);
      elements.bibleForm.addEventListener('submit', event => {
        event.preventDefault();
        lookupPrepareBible();
      });

      elements.newProjectForm.addEventListener('submit', createProject);
      elements.btnCancelNewProject.addEventListener('click', () => closeDialog(elements.newProjectDialog, elements.btnNewProject));
      bindDialogCancel(elements.newProjectDialog, elements.btnNewProject);

      elements.groupForm.addEventListener('submit', addGroup);
      const closeGroupDialog = () => {
        state.groupParentId = null;
        closeDialog(elements.groupDialog, elements.btnAddGroup);
      };
      elements.btnCancelGroup.addEventListener('click', closeGroupDialog);
      elements.groupDialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeGroupDialog();
      });

      elements.textForm.addEventListener('submit', addText);
      elements.btnCancelText.addEventListener('click', () => closeDialog(elements.textDialog, elements.btnAddText));
      bindDialogCancel(elements.textDialog, elements.btnAddText);

      elements.pictureForm.addEventListener('submit', addPicture);
      elements.btnCancelPicture.addEventListener('click', () => closeDialog(elements.pictureDialog, elements.btnAddPicture));
      bindDialogCancel(elements.pictureDialog, elements.btnAddPicture);

      elements.editItemForm.addEventListener('submit', saveEditedItem);
      elements.editItemForm.addEventListener('input', markEditItemDraftDirty);
      elements.editItemForm.addEventListener('change', markEditItemDraftDirty);
      elements.btnCancelEditItem.addEventListener('click', closeEditItemEditor);
      elements.editItemDialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeEditItemEditor();
      });

      elements.songForm.addEventListener('submit', saveSongDraft);
      elements.songForm.addEventListener('input', markSongDraftDirty);
      elements.songForm.addEventListener('change', markSongDraftDirty);
      elements.songCommunityVisibility.addEventListener('change', renderSongCommunityState);
      elements.songCommunityPublishAt.addEventListener('input', renderSongCommunityState);
      elements.btnReviewSongCommunityConflict.addEventListener('click', openSongCommunityConflict);
      elements.btnCloseSongCommunityConflict.addEventListener('click', closeSongCommunityConflict);
      elements.btnKeepLocalSongConflict.addEventListener(
        'click',
        () => resolveSongCommunityConflict('keep-local')
      );
      elements.btnKeepCommunitySongConflict.addEventListener(
        'click',
        () => resolveSongCommunityConflict('keep-remote')
      );
      elements.songCommunityConflictDialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeSongCommunityConflict();
      });
      elements.btnValidateSong.addEventListener('click', () => validateSongDraft({ announce: true }));
      elements.btnCancelSong.addEventListener('click', closeSongEditor);
      elements.songDialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeSongEditor();
      });
      window.addEventListener('beforeunload', guardSongDraftBeforeUnload);
      window.addEventListener('beforeunload', guardEditItemDraftBeforeUnload);

      document.addEventListener('keydown', event => {
        if (!document.body.classList.contains('prepare-stage')
          || isTextEditingTarget(event.target)
          || event.altKey) return;
        const command = event.metaKey || event.ctrlKey;
        if (!command || event.key.toLowerCase() !== 'z') return;
        event.preventDefault();
        restoreHistory(event.shiftKey ? 'redo' : 'undo');
      });
      document.addEventListener('keydown', event => {
        if (!document.body.classList.contains('prepare-stage')
          || isTextEditingTarget(event.target)
          || event.altKey
          || event.metaKey) return;
        if (!event.ctrlKey || event.key.toLowerCase() !== 'y') return;
        event.preventDefault();
        restoreHistory('redo');
      });
    }

    async function activate() {
      if (!state.available) {
        setNotice(
          'error',
          'Prepare is not available in this build yet. Load and Show still work normally.',
          { global: true }
        );
        return;
      }
      if (!state.activated) {
        state.activated = true;
        setNotice('busy', 'Loading service projects and songs…');
        const [projectsLoaded, songsLoaded, presetsLoaded] = await Promise.all([
          loadProjects({ openFirst: true }),
          loadSongs(),
          api.listNativePresets()
            .then(result => {
              const payload = checkedResult(result);
              state.presets = collectionItems(payload, ['items', 'presets']);
              return true;
            })
            .catch(error => {
              state.presets = [];
              setNotice('error', errorMessage(error, 'Slide presets could not be loaded.'), { global: true });
              return false;
            })
        ]);
        if (!projectsLoaded || !songsLoaded || !presetsLoaded) {
          state.activated = false;
          setNotice(
            'error',
            'Prepare could not load all local projects and songs. Leave Prepare and open it again to retry.',
            { global: true }
          );
        } else if (state.currentProject && elements.notice.dataset.kind !== 'error') {
          setNotice('success', `${state.currentProject.title} is open.`);
        } else {
          setNotice('', 'Create a service project to begin.');
        }
        renderAll();
      }
      window.setTimeout(() => elements.heading.focus(), 0);
    }

    function initialize() {
      state.available = requiredApi.every(method => typeof api[method] === 'function');
      bindEvents();
      if (typeof api.onPreparePublishProgress === 'function') {
        api.onPreparePublishProgress(handlePublishProgress);
      }
      elements.newProjectDate.value = localIsoDate();
      if (!state.available) {
        const missing = requiredApi.filter(method => typeof api[method] !== 'function');
        console.warn('[Prepare] APIs not available:', missing.join(', '));
      }
      renderAll();
      return controller;
    }

    const controller = Object.freeze({
      activate,
      initialize,
      refreshProjects: () => loadProjects(),
      refreshSongs: () => loadSongs(),
      isBusy: () => state.mutationBusy || state.publishBusy,
      getCurrent: () => ({
        project: state.currentProject,
        revisionId: state.revisionId
      })
    });
    return controller;
  }

  window.SyncShowPrepare = Object.freeze({
    addGoldEmphasisRange,
    applySongLibraryPage,
    authoritativeSongForItem,
    canApplySongLibraryPage,
    createController,
    editItemDraftSnapshot,
    emphasisSnippet,
    groupSongSummaries,
    songFamilyRelationship,
    mergeSongSummaries,
    normalizeEditableEmphasisRanges,
    reorderDestination,
    songCreditSummary,
    summarizeSongImport
  });
})();
