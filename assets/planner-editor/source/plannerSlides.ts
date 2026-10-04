import readingLabels from '../../packages/service-core/node/services/project/ReadingLabels.js'
import sermonContext from '../../packages/service-core/node/services/project/SermonContext.js'
import { isScripturePageGroup } from './plannerScriptureGroups'
import { isSermonGroup } from './plannerSermonSections'
import { isReadingGroup, isSongGroup } from './plannerReadingGroups'
import songPresentation from '../../packages/service-core/node/services/project/SongPresentation.js'
import serviceCore from '../../packages/service-core/index.js'
import { sermonTextSpans } from './plannerSermonStyle'
import formatting from '../../packages/service-core/node/services/project/SlideFormatting.js'

type RecordValue = Record<string, any>
export type PlannerSlide = {
  id: string
  itemId: string
  parentId: string | null
  depth: number
  index: number
  number: number
  title: string
  kind: string
  readingTitle?: boolean
  sectionItemId?: string
  scripturePageCount?: number
  sermonTitle?: boolean
  cue?: RecordValue
}

export function isSongTitleSlide(slide: PlannerSlide) {
  return slide.kind === 'song' && slide.cue?.sourceReference?.sectionId === null
}

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

/** The same compiler used by SyncShow is the only source of slide order. */
export function plannerSlides(project: RecordValue, channelId?: string): PlannerSlide[] {
  const timeline = serviceCore.compileServiceProject(project, { allowEmpty: true })
  const cues = timeline.cueIds.map((id: string) => timeline.cues[id])
  const result: PlannerSlide[] = []
  let number = 0
  const visit = (itemId: string, parentId: string | null, depth: number) => {
    const item = project.items[itemId]
    if (item.kind === 'group') {
      if (isReadingGroup(project, item) || isSongGroup(project, item) || isSermonGroup(project, item) || isScripturePageGroup(project, item)) {
        item.childIds.forEach((id: string, index: number) => {
          const start = result.length
          visit(id, itemId, depth + (index > 0 ? 1 : 0))
          if (index === 0 && result[start]) {
            result[start].sectionItemId = itemId
            if (isScripturePageGroup(project, item) && item.childIds.length > 1) result[start].scripturePageCount = item.childIds.length
            if (isReadingGroup(project, item)) result[start].readingTitle = true
            if (isSermonGroup(project, item)) result[start].sermonTitle = true
          }
        })
        return
      }
      result.push({ id: itemId, itemId, parentId, depth, index: -1, number: 0, title: item.title, kind: 'group' })
      item.childIds.forEach((id: string) => visit(id, itemId, depth + 1))
      return
    }
    cues.filter((cue: RecordValue) => cue.itemId === itemId).forEach((cue: RecordValue, index: number) => {
      const orderedOutputs = channelId ? [cue.channels[channelId], ...Object.entries(cue.channels).filter(([id])=>id!==channelId).map(([,output])=>output)].filter(Boolean) : Object.values(cue.channels)
      const blocks = orderedOutputs.flatMap((output: any) => output.blocks || [])
      const firstLine = blocks
        .find((block: any) => block.type === 'text') as RecordValue | undefined
      const songTitle = item.kind === 'song' && channelId ? localizedSongTitle(project, item, index, channelId) : undefined
      result.push({
        id: cue.id, itemId, parentId, depth: depth + (item.kind === 'song' && index > 0 ? 1 : 0),
        index, number: ++number, kind: item.kind, cue,
        title: songTitle ? songTitle
          : item.kind === 'song' && (item.showTitle === false || index > 0)
          ? firstLine?.text?.split('\n').find(Boolean) || cue.title
          : sermonContext.isPoint(item) ? blocks.filter(block=>block.type==='text' && block.role==='body').map(block=>sermonContext.outlineRows(block.text).at(-1)?.text.trim()).find(Boolean) || item.title : channelId ? localizedSlideTitle(item, blocks, channelId, project.channels[channelId]?.language) : item.title,
      })
    })
  }
  project.rootItemIds.forEach((id: string) => visit(id, null, 0))
  return result
}

/** A bilingual slide can put Russian first on both screens. Labels still follow the selected language. */
function localizedSongTitle(project: RecordValue, item: RecordValue, index: number, channelId: string): string | undefined {
  if (item.songPresentation?.audienceLanguage && item.songPresentation.audienceLanguage !== 'both') channelId = item.songPresentation.audienceLanguage
  const seen = new Set<string>()
  let variant = item.variants?.[channelId]
  while (variant && variant.mode !== 'content' && variant.from && !seen.has(variant.from)) {
    seen.add(variant.from)
    variant = item.variants[variant.from]
  }
  const document = variant?.mode === 'content' ? project.resources[variant.resourceId]?.document : null
  if (!document) return undefined
  if (index === 0 && item.showTitle !== false) return document.title?.trim() || undefined
  const pages = item.arrangement.flatMap((entry: RecordValue) => document.sections.find((section: RecordValue) => section.id === entry.sectionId)?.slides || [])
  return pages[index - (item.showTitle === false ? 0 : 1)]?.lines.find((line: string) => line.trim())
}

function localizedSlideTitle(item: RecordValue, blocks: RecordValue[], channelId: string, language: string) {
  if (item.kind === 'bible') {
    const passage = blocks.find(block=>block.type==='bible')
    return readingLabels.localizedReference(passage?.displayReference || passage?.reference || item.title, language)
  }
  if(item.sermonTemplate==='title') return item.titlesByChannel?.[channelId]?.trim() || Object.values(item.titlesByChannel || {}).find((text:any)=>text?.trim()) || item.title
  if (item.kind === 'blank') return item.title
  // Compiled channels already resolve display-only fallback without changing authored text.
  const text = item.sermonTemplate === 'quote' || item.sermonTemplate === 'other'
    ? blocks.find(block=>block.type==='text' && block.role==='body')?.text
      || blocks.find(block=>block.type==='canvas')?.objects?.find((object:any)=>object.type==='text' && object.text?.trim())?.text
    : blocks.find(block=>block.type==='text' && block.role==='title')?.text
  return text?.split('\n').find((line:string)=>line.trim()) || blocks.find(block=>block.type==='bible')?.reference || item.title
}

function contentChannel(item: RecordValue, channelId: string): string {
  const variant = item.variants[channelId]
  if (!variant || variant.mode === 'hidden') throw new Error('This output is hidden.')
  return variant.mode === 'content' ? channelId : contentChannel(item, variant.from)
}

function songOccurrence(project: RecordValue, itemId: string, lyricIndex: number) {
  const item = project.items[itemId]
  const primaryId = item.primaryChannelId || Object.keys(item.variants).find(id => item.variants[id].mode === 'content')
  const document = project.resources[item.variants[primaryId].resourceId].document
  let remaining = lyricIndex
  for (const [entryIndex, entry] of item.arrangement.entries()) {
    const section = document.sections.find((value: RecordValue) => value.id === entry.sectionId)
    if (remaining >= 0 && remaining < section.slides.length) return { entryIndex, slideIndex: remaining }
    remaining -= section.slides.length
  }
  throw new Error('This lyric slide is no longer in the song.')
}

/** A correction retains every live cue. Only a reused section needs a private
 * occurrence; its arrangement identity stays fixed while the content is cloned. */
function editableSongOccurrence(project: RecordValue, itemId: string, lyricIndex: number) {
  const { entryIndex } = songOccurrence(project, itemId, lyricIndex)
  const item = project.items[itemId], entry = item.arrangement[entryIndex]
  if (item.arrangement.filter((value: RecordValue) => value.sectionId === entry.sectionId).length < 2) return project
  const sectionIds = new Set<string>()
  for (const variant of Object.values(item.variants) as RecordValue[]) {
    if (variant.mode === 'content') {
      for (const section of project.resources[variant.resourceId].document.sections) sectionIds.add(section.id)
    }
  }
  let suffix = entryIndex + 1, sectionId = `local-occurrence-${suffix}`
  while (sectionIds.has(sectionId)) sectionId = `local-occurrence-${++suffix}`
  let next = copy(project)
  for (const [channelId, variant] of Object.entries(item.variants) as [string, RecordValue][]) {
    if (variant.mode !== 'content') continue
    const original = project.resources[variant.resourceId], document = copy(original.document)
    const section = document.sections.find((value: RecordValue) => value.id === entry.sectionId)
    document.sections.push({ ...copy(section), id: sectionId, marker: sectionId })
    const added = (serviceCore.addSongResource as any)(next, document, { provider: 'local', itemId, revision: original.sha256 })
    next = copy(added.project)
    next.items[itemId].variants[channelId].resourceId = added.resourceId
  }
  next.items[itemId].arrangement[entryIndex] = { ...entry, sectionId, cueSectionId: entry.cueSectionId || entry.sectionId }
  delete next.items[itemId].sourceRangeReplacement
  return copy(serviceCore.normalizeServiceProject(next))
}

/** Copy-on-write: expand occurrences to single-slide sections in service-local
 * resources. Repeated choruses and other uses of the library song stay intact. */
export function editableSong(project: RecordValue, itemId: string) {
  let next = copy(project)
  const item = next.items[itemId]
  const previousCues = plannerSlides(project).filter(row => row.itemId === itemId)
  const lyricCues = previousCues.filter(row => !isSongTitleSlide(row))
  const primaryId = item.primaryChannelId || Object.keys(item.variants).find(id => item.variants[id].mode === 'content')
  const primary = project.resources[item.variants[primaryId].resourceId].document
  const occurrences = item.arrangement.flatMap((entry: RecordValue) => {
    const section = primary.sections.find((value: RecordValue) => value.id === entry.sectionId)
    return section.slides.map((slide: RecordValue, index: number) => ({ entry, section, slide, index }))
  })
  const usedIds = new Set<string>(item.arrangement.map((entry: RecordValue) => entry.id))
  let suffix = 0
  const arrangement = occurrences.map((occurrence: any, index: number) => {
    let id = occurrence.entry.id
    if (occurrence.index > 0) {
      do { id = `local-page-${++suffix}` } while (usedIds.has(id))
      usedIds.add(id)
    }
    return { id, sectionId: `slide-${index + 1}`, cueSourceLeafKey: lyricCues[index].cue!.sourceLeafKey }
  })
  const resourceByChannel: Record<string, string> = {}
  for (const channelId of Object.keys(item.variants)) {
    const variant = item.variants[channelId]
    if (variant.mode !== 'content') continue
    const original = project.resources[variant.resourceId]
    const document = copy(original.document)
    document.sections = occurrences.map((occurrence: any, index: number) => {
      const section = document.sections.find((value: RecordValue) => value.id === occurrence.entry.sectionId)
      return { ...section, id: arrangement[index].sectionId, marker: arrangement[index].sectionId,
        slides: [{ ...section.slides[occurrence.index], id: 'slide-1' }] }
    })
    document.arrangement = document.sections.map((section: RecordValue) => section.id)
    const added = (serviceCore.addSongResource as any)(next, document, { provider: 'local', itemId, revision: original.sha256 })
    next = copy(added.project)
    resourceByChannel[channelId] = added.resourceId
  }
  const target = next.items[itemId]
  target.arrangement = arrangement
  delete target.sourceRangeReplacement
  for (const [channelId, resourceId] of Object.entries(resourceByChannel)) target.variants[channelId].resourceId = resourceId
  // Source keys stay fixed, so per-slide languages and translation controls
  // remain attached to their exact pages without any ordinal remapping.
  return copy(serviceCore.normalizeServiceProject(next))
}

export function editablePreviewBlock(project: RecordValue, slide: PlannerSlide, channelId: string, block: RecordValue) {
  const item = project.items[slide.itemId]
  if (item.kind === 'notice' || item.kind === 'sermon') return block.type === 'text'
  if (item.kind !== 'song' || item.variants[channelId]?.mode === 'derive') return false
  return ['lyrics', 'title', 'subtitle', 'credit'].includes(block.role)
}

export function editPlannerSlide(project: RecordValue, slide: PlannerSlide, channelId: string, blockIndex: number, text: string, spans?: RecordValue[]) {
  const block = slide.cue?.channels[channelId]?.blocks[blockIndex]
  if (block?.type === 'bible' && spans !== undefined) {
    const display = formatting.scriptureDisplay(block, slide.cue?.presetId)
    const next = copy(project), item = next.items[slide.itemId]
    const outputs = channelId === 'russian' && item.passagesByChannel.media ? [channelId, 'media'] : [channelId]
    for (const output of outputs) {
      const passage = item.passagesByChannel[output]
      if (text !== display.text || passage.displayText !== undefined) { passage.displayText = text; passage.displaySpans = spans }
      else passage.spans = spans.filter(span=>span.end>display.bodyStart).map(span=>({...span,start:Math.max(display.sourceStart,span.start-display.prefixLength),end:span.end-display.prefixLength}))
    }
    item.updatedAt = new Date().toISOString()
    return copy(serviceCore.normalizeServiceProject(next))
  }
  if (!text.trim() && block?.role !== 'credit') throw new Error('Slide text cannot be empty. Use Delete in the slide menu instead.')
  if (!block || !editablePreviewBlock(project, slide, channelId, block)) throw new Error('This content is generated from its source.')
  let next = copy(project)
  let item = next.items[slide.itemId]
  if (item.kind === 'song') {
    if (block.role === 'credit' && item.songPresentation) {
      item.songPresentation.credits = text
      return copy(serviceCore.normalizeServiceProject(next))
    }
    const titleSlide = isSongTitleSlide(slide)
    const lyricIndex = slide.index - (item.showTitle === false ? 0 : 1)
    if (!titleSlide) next = editableSongOccurrence(next, item.id, lyricIndex)
    item = next.items[slide.itemId]
    let sourceChannel = contentChannel(item, channelId)
    if (item.songPresentation && !titleSlide) {
      const updatedSlide = plannerSlides(next).find(row=>row.itemId===item.id && row.index===slide.index)!
      if (item.songPresentation.audienceLanguage || item.songPresentation.stackedTranslation || item.songPresentation.slidePrimaryChannelIds?.[updatedSlide.cue!.sourceLeafKey]) {
        const primary = songPresentation.presentationPrimaryChannelId(item, updatedSlide.cue!.sourceLeafKey)
        sourceChannel = blockIndex === 0 ? primary : songPresentation.presentationSecondaryChannelId(item, primary)
      }
    }
    // Full title cards can display the other language's title as well.
    if (titleSlide) {
      sourceChannel = Object.keys(item.variants).find(id => item.variants[id].mode === 'content'
        && next.resources[item.variants[id].resourceId].document.title === block.text) || sourceChannel
    }
    const original = next.resources[item.variants[sourceChannel].resourceId]
    const document = copy(original.document)
    if (titleSlide) document.title = text
    else {
      const { entryIndex, slideIndex } = songOccurrence(next, item.id, lyricIndex)
      document.sections.find((section: RecordValue) => section.id === item.arrangement[entryIndex].sectionId).slides[slideIndex].lines = text.split('\n')
      delete item.sourceRangeReplacement
    }
    const added = (serviceCore.addSongResource as any)(next, document, { provider: 'local', itemId: item.id, revision: original.sha256 })
    next = copy(added.project)
    next.items[item.id].variants[sourceChannel].resourceId = added.resourceId
  } else {
    const field = block.role === 'title' ? 'titlesByChannel' : 'textByChannel'
    item[field] = { ...item[field], [channelId]: text }
    // Character offsets and sermon projections refer to the previous text.
    if (field === 'textByChannel') {
      delete item.spansByChannel?.[channelId]
      delete item.sourceBodyProjection
      if (item.presetId === 'wotbc-sermon') item.spansByChannel = { ...item.spansByChannel, [channelId]: sermonTextSpans(text) }
    }
    if (spans !== undefined) {
      const styles = field === 'titlesByChannel' ? 'titleSpansByChannel' : 'spansByChannel'
      item[styles] = { ...item[styles], [channelId]: spans }
    } else if (field === 'titlesByChannel') delete item.titleSpansByChannel?.[channelId]
  }
  next.items[slide.itemId].updatedAt = new Date().toISOString()
  return copy(serviceCore.normalizeServiceProject(next))
}

export function movePlannerSlide(project: RecordValue, from: PlannerSlide, to: PlannerSlide, after = false) {
  if (from.id === to.id) return project
  if (from.readingTitle || to.readingTitle) {
    const asGroup=(row:PlannerSlide):PlannerSlide=>row.readingTitle ? {...row,id:row.parentId!,itemId:row.parentId!,readingTitle:false,kind:'group',parentId:(Object.values(project.items) as any[]).find(item=>item.kind==='group' && item.childIds.includes(row.parentId))?.id || null} : row
    return movePlannerSlide(project,asGroup(from),asGroup(to),after)
  }
  if (from.kind === 'song' && from.index > 0) {
    if (to.itemId !== from.itemId) throw new Error('Move lyrics within their song. Drag the song title to move the whole song.')
    const next = editableSong(project, from.itemId)
    const ordered = next.items[from.itemId].arrangement
    let target = Math.max(0, to.index - 1 + Number(after))
    const [entry] = ordered.splice(from.index - 1, 1)
    if (target > from.index - 1) target--
    ordered.splice(target, 0, entry)
    return copy(serviceCore.normalizeServiceProject(next))
  }
  if (from.itemId === to.itemId) return project
  const siblings: string[] = to.parentId === null ? project.rootItemIds : project.items[to.parentId].childIds
  const ordered = siblings.filter(id => id !== from.itemId)
  return serviceCore.moveProjectItem(project, {
    itemId: from.itemId, targetParentId: to.parentId,
    targetIndex: ordered.indexOf(to.itemId) + Number(after),
  })
}

export function deletePlannerSlide(project: RecordValue, slide: PlannerSlide) {
  if (slide.kind === 'song' && slide.index > 0) {
    const next = editableSong(project, slide.itemId)
    if (next.items[slide.itemId].arrangement.length === 1) throw new Error('This is the last lyric slide. Delete the song using its title row instead.')
    next.items[slide.itemId].arrangement.splice(slide.index - 1, 1)
    return copy(serviceCore.normalizeServiceProject(next))
  }
  return serviceCore.removeProjectItemAndDescendants(project, slide.readingTitle ? slide.parentId! : slide.itemId)
}

/** A cue belongs to its concrete compiled slide, including a song occurrence. */
export function translationActionForSlide(rows: PlannerSlide[], slide: PlannerSlide): 'start' | 'stop' {
  let active = false
  for (const row of rows) {
    if (row.id === slide.id) break
    if (row.cue?.translationAction) active = row.cue.translationAction === 'start'
  }
  return active ? 'stop' : 'start'
}
export function setSlideTranslationCue(project: RecordValue, slide: PlannerSlide, action: 'start' | 'stop' | null, settings?: RecordValue) {
  if (!slide.cue?.sourceLeafKey) throw new Error('Choose a numbered slide.')
  const next = copy(project), item = next.items[slide.itemId]
  item.translationCues ||= {}
  if (action) item.translationCues[slide.cue.sourceLeafKey] = action
  else delete item.translationCues[slide.cue.sourceLeafKey]
  if (action==='start' && settings) { item.translationCueSettings ||= {}; item.translationCueSettings[slide.cue.sourceLeafKey] = settings }
  else if (item.translationCueSettings) { delete item.translationCueSettings[slide.cue.sourceLeafKey]; if(!Object.keys(item.translationCueSettings).length)delete item.translationCueSettings }
  if (!Object.keys(item.translationCues).length) delete item.translationCues
  return copy(serviceCore.normalizeServiceProject(next))
}
