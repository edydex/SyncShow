'use client'
import { useWorkspaceText } from './useWorkspaceText'
import type { WorkspaceTextVariables } from '../lib/workspaceText'
import { applyDeviceWorkspaceLanguage } from '../lib/deviceWorkspaceLanguage'
import './workspace-editor.css'
import VersionHistoryDialog from './VersionHistoryDialog'
import SaveConflictDialog from './SaveConflictDialog'
import { conflictDraftSignature, type ConflictSavedVersion } from './serviceSaveConflict'
import { plannerNavigator } from './plannerNavigator'
import readingLabels from '../../packages/service-core/node/services/project/ReadingLabels.js'
import songPresentation from '../../packages/service-core/node/services/project/SongPresentation.js'
import SongAudienceLanguages from './SongAudienceLanguages'
import { applySongSectionLanguages, setSongAudienceLanguage, songDocumentSectionLanguages } from './plannerSongLanguages'
import sermonContext from '../../packages/service-core/node/services/project/SermonContext.js'
import NumberDraftInput from './NumberDraftInput'
import { groupSermonSections, withinSermon } from './plannerSermonSections'
import { reflowScripture } from './plannerScriptureReflow'
import { scriptureTranslationScope, scriptureTranslationRequest, hasScriptureEdits, replaceScriptureTranslation } from './plannerScriptureTranslations'
import BibleSourceNotice from './BibleSourceNotice'
import OnlineBibleNotice from './OnlineBibleNotice'
import { bibleTranslationOptionLabel } from '../lib/bible/OnlineBibleSources'
import {typographyItemIds} from './plannerTypography'
import { setReadingTemplate } from './readingTemplates'
import { appendBlankSlide, readingOwner } from './plannerReadingGroups'

import TranslationCueDialog from './TranslationCueDialog'
import translationSettings from '../../packages/service-core/node/services/project/TranslationCueSettings.js'
import { PresentationAccessibility, PresentationAccessibilityControl } from './PresentationAccessibility'
import { insertReusableSlide, extractReusableSlide } from './plannerReusableSlides'
import { importSermonPresentation } from './importSermonPresentation'
import { churchWorkspaceLinks } from '@/lib/churchWorkspaceLinks'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ComponentType } from 'react'
import PassageReferenceInput from './PassageReferenceInput'
import { workspaceSignInHref } from '../lib/workspaceNavigation'
import { rememberWorkspaceService, type WorkspaceIdentity } from '../lib/workspaceHome'
import type { PlannerSongCreatorProps } from './PlannerSongCreator'
import PlannerSongFrame from './PlannerSongFrame'
import serviceCore from '../../packages/service-core/index.js'
import { plannerPreview } from './plannerPreview'
import CanvasSlide, { newCanvasObject } from './CanvasSlide'
import TemplateSlideEditor from './TemplateSlideEditor'
import MoveSlidesDialog from './MoveSlidesDialog'
import DeleteSlidesDialog from './DeleteSlidesDialog'
import ScriptureEditionDialog from './ScriptureEditionDialog'
import SlideSettingsDialog from './SlideSettingsDialog'
import SlideText from './SlideText'
import PreviewCanvas from './PreviewCanvas'
import PalettePresetPreview from './PalettePresetPreview'
import ServicePreview from './ServicePreview'
import formatting from '../../packages/service-core/node/services/project/SlideFormatting.js'
import typography from '../../packages/service-core/node/services/project/SlideTypography.js'
import { SERMON_TEMPLATES, createTemplateDraft, editTemplateField, editCanvasObjects, insertionPoint, type SermonTemplateId } from './plannerTemplates'
import { addReadingTitle, preparePlannerPresentation } from './plannerPresentation'
import { editablePreviewBlock, editPlannerSlide, isSongTitleSlide, plannerSlides, setSlideTranslationCue, translationActionForSlide, type PlannerSlide } from './plannerSlides'
import { changePlannerSelection, plannerClickSelection, selectedPlannerSlides, type SelectionResult } from './plannerSelection'
import {
  parsePlannerLibrarySongDocument,
  projectFromServiceEnvelope,
} from './serviceDocumentPlannerModel'

const ENDPOINT = '/api/community/service-documents'
const CHANNEL_IDS = ['english', 'russian', 'media'] as const

type ChannelId = typeof CHANNEL_IDS[number]
type ProjectItem = Record<string, any> & {
  id: string
  kind: string
  title: string
  operatorNotes: string
}
type ServiceProject = Record<string, any> & {
  id: string
  title: string
  serviceDate: string
  revision: number
  channelIds: string[]
  channels: Record<string, { id: string; label: string; language: string }>
  rootItemIds: string[]
  items: Record<string, ProjectItem>
}
type ServiceEnvelope = {
  syncId: string
  syncVersion: number
  revision: string
  documentSource: string
  status: 'planning' | 'ready' | 'archived' | 'cancelled'
  changedAt: string
  project: ServiceProject
}
type ServiceEnvelopeInput = Omit<ServiceEnvelope, 'project'> & {
  project?: ServiceProject
  document?: { project?: ServiceProject }
}
type ServiceSummary = {
  syncId: string
  syncVersion: number
  revision: string
  status: ServiceEnvelope['status']
  title: string
  serviceDate: string
  changedAt: string
}
type SongLibraryOption = {
  syncId: string
  syncVersion: number
  title: string
  russianTitle: string
  rightsStatus: string
  visibility: string
  documentCount: number
  previewSections?: { language: string; label: string; lines: string[] }[]
}
type BibleBookOption = {
  id: string
  name: string
  chapters: number
}
type PictureUploadTarget = 'new' | 'all' | 'background' | 'canvas' | ChannelId
type ResourceTab = 'songs' | 'media' | 'scripture' | 'templates'

function uuid() {
  return globalThis.crypto.randomUUID()
}

function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Heritage Community could not complete that service change.'
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  let value: any = null
  try {
    value = await response.json()
  } catch {
    // A successful response must still be valid JSON.
  }
  if (!response.ok) {
    const error = new Error(
      typeof value?.error === 'string'
        ? value.error
        : `Service request failed (${response.status}).`,
    ) as Error & { code?: string; status?: number }
    error.code = value?.code
    error.status = response.status
    throw error
  }
  return value
}

async function uploadServiceMedia(file: File) {
  const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
  const isVideo = ['video/mp4', 'video/webm'].includes(file.type)
  if (!isImage && !isVideo) {
    throw new Error('Choose a PNG, JPEG, WebP, MP4, or WebM file.')
  }
  const maximumBytes = isVideo ? 250 * 1024 * 1024 : 75 * 1024 * 1024
  if (file.size < 1 || file.size > maximumBytes) {
    throw new Error(isVideo
      ? 'Choose a video no larger than 250 MB.'
      : 'Choose a picture no larger than 75 MB.')
  }
  const sha256 = [...new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  ))].map(value => value.toString(16).padStart(2, '0')).join('')
  const assetId = `sha256:${sha256}`
  const response = await fetch(
    `${ENDPOINT}/assets/${encodeURIComponent(assetId)}`,
    {
      method: 'PUT',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': file.type },
      body: file,
    },
  )
  let value: any = null
  try { value = await response.json() } catch { /* handled below */ }
  if (!response.ok || !value?.asset) {
    throw new Error(
      typeof value?.error === 'string'
        ? value.error
        : `Media upload failed (${response.status}).`,
    )
  }
  return { assetId, sha256, metadata: value.asset as Record<string, any> }
}

function safeImageFileName(value: string, mediaType: string) {
  const extension = mediaType === 'image/png'
    ? 'png'
    : mediaType === 'image/webp'
      ? 'webp'
      : 'jpg'
  const base = value.normalize('NFC').replace(/[\\/\p{Cc}]/gu, '-').trim().slice(0, 180)
  return { fileName: base || `service-picture.${extension}`, extension }
}

function safeVideoFileName(value: string, mediaType: string) {
  const extension = mediaType === 'video/webm' ? 'webm' : 'mp4'
  const base = value.normalize('NFC').replace(/[\/\p{Cc}]/gu, '-').trim().slice(0, 180)
  return { fileName: base || `service-video.${extension}`, extension }
}

function cloneProject(project: ServiceProject): ServiceProject {
  return JSON.parse(JSON.stringify(project)) as ServiceProject
}

function itemPreset(item: ProjectItem) {
  return item.kind === 'song' ? item.lyricsPresetId : item.presetId
}

function presetChoices(item: ProjectItem) {
  if (item.kind === 'song') return ['wotbc-song-stacked', 'wotbc-song-lyrics', 'song-lyrics']
  if (item.kind === 'bible') return ['wotbc-reading', 'wotbc-sermon-scripture', 'wotbc-sermon-verse', 'scripture-large', 'scripture-text']
  if (item.kind === 'sermon') return ['wotbc-sermon-title', 'wotbc-sermon', 'wotbc-sermon-quote', 'sermon-point', 'sermon-notes']
  if (item.kind === 'notice') return ['notice-text', 'sermon-point']
  if (item.kind === 'picture') return ['picture-fullscreen']
  if (item.kind === 'video') return ['video-fullscreen']
  if (item.kind === 'blank') return ['blank-black']
  return []
}

function previewBlockText(block: Record<string, any>) {
  if (typeof block.text === 'string') return block.text
  if (Array.isArray(block.verses)) {
    return [block.reference, ...block.verses.map((verse: any) => `${verse.number} ${verse.text}`)].filter(Boolean).join('\n')
  }
  if (block.type === 'image') return block.altText || 'Picture'
  if (block.type === 'video') return 'Video'
  return ''
}



function descendantIds(project: ServiceProject, itemId: string, found = new Set<string>()) {
  if (found.has(itemId)) return found
  found.add(itemId)
  const item = project.items[itemId]
  if (item?.kind === 'group') item.childIds.forEach((childId: string) => descendantIds(project, childId, found))
  return found
}

function sermonDocumentIdForItem(project: ServiceProject | null, item: ProjectItem | null) {
  if (!project || !item) return null
  let resourceId = item.sermonResourceId || item.sermonReading?.sermonResourceId
  if (!resourceId) {
    const owner = Object.values(project.items).find(candidate => (
      candidate.kind === 'group'
      && candidate.sermonResourceId
      && descendantIds(project, candidate.id).has(item.id)
    ))
    resourceId = owner?.sermonResourceId
  }
  const resource = resourceId ? project.resources?.[resourceId] : null
  return resource?.kind === 'sermon' ? String(resource.document?.id || '') || null : null
}

function today() {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

function NewService({ onCreated, onCopy }: { onCreated: (value: ServiceEnvelopeInput) => void; onCopy?: () => void }) {
  const t = useWorkspaceText()
  const [title, setTitle] = useState('Sunday Morning Service')
  const [serviceDate, setServiceDate] = useState(today)
  const newServiceDetails = useRef<HTMLDetailsElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const serviceDateInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (new URL(window.location.href).searchParams.get('new') === '1') {
      if (newServiceDetails.current) newServiceDetails.current.open = true
      titleInput.current?.focus()
    }
  }, [])

  async function create() {
    const visibleTitle = titleInput.current?.value.trim() || title.trim()
    const visibleServiceDate = serviceDateInput.current?.value || serviceDate
    setBusy(true)
    setError(null)
    try {
      const response = await jsonRequest(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({
          schemaVersion: 1,
          requestId: uuid(),
          syncId: `service-${visibleServiceDate}`,
          title: visibleTitle,
          serviceDate: visibleServiceDate,
        }),
      })
      onCreated(response.serviceDocument)
      if (newServiceDetails.current) newServiceDetails.current.open = false
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details ref={newServiceDetails} className="heritage-service-planner__new">
      <summary>{t("+ New service")}</summary>
      <div>
        <label>
          <span>{t("Service title")}</span>
          <input ref={titleInput} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} />
        </label>
        <label>
          <span>{t("Service date")}</span>
          <input ref={serviceDateInput} type="date" value={serviceDate} onChange={event => setServiceDate(event.target.value)} />
        </label>
        <button className="btn btn--style-primary" type="button" disabled={busy || !title.trim() || !serviceDate} onClick={create}>
          {busy ? t("Creating…") : t("Create service")}
        </button>
        {onCopy ? <button type="button" onClick={onCopy}>{t("Make a copy of the current service")}</button> : null}
        {error ? <p className="heritage-service-planner__error" role="alert">{t(error)}</p> : null}
      </div>
    </details>
  )
}

export default function PlanServiceClient({ sermonSyncId, activeServiceId, onDirtyChange, onFlushReady, sidebarHeader, SongCreator }: { sermonSyncId?: string; activeServiceId?: string; onDirtyChange?: (dirty: boolean) => void; onFlushReady?: (flush: (() => Promise<boolean>) | null) => void; sidebarHeader?: ReactNode; SongCreator?: ComponentType<PlannerSongCreatorProps> } = {}) {
  const t = useWorkspaceText()
  const workspaceIdentity = useRef<WorkspaceIdentity>({})
  const [summaries, setSummaries] = useState<ServiceSummary[]>([])
  const [envelope, setEnvelope] = useState<ServiceEnvelope | null>(null)
  const [editionChange, setEditionChange] = useState<{channel:'english'|'russian';translationId:string} | null>(null)
  const [draft, setDraft] = useState<ServiceProject | null>(null)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [desiredStatus, setDesiredStatus] = useState<ServiceEnvelope['status']>('planning')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [autosaveBlocked, setAutosaveBlocked] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saveConflict, setSaveConflict] = useState(false)
  const [saveConflictOpen, setSaveConflictOpen] = useState(false)
  const saveConflictRef = useRef(false)
  const [recoveryConflict, setRecoveryConflict] = useState<ServiceProject | null>(null)
  const [localRecoveryAvailable, setLocalRecoveryAvailable] = useState(true)
  const envelopeRef = useRef(envelope); envelopeRef.current = envelope
  const statusRef = useRef(desiredStatus); statusRef.current = desiredStatus
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const saveInFlight = useRef<Promise<boolean> | null>(null)
  const pendingSave = useRef<{ draft: ServiceProject; status: string; body: Record<string, any> } | null>(null)
  const saveHandler = useRef<(kind?: 'automatic' | 'manual' | 'restore') => Promise<boolean>>(async () => false)
  const [error, setError] = useState<string | null>(null)
  const [reusableSlides,setReusableSlides] = useState<any[]>([])
  const [templateName,setTemplateName] = useState('')
  const [templateAutoStart,setTemplateAutoStart] = useState(false)
  const [uploadingPicture, setUploadingPicture] = useState(false)
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [songLibrary, setSongLibrary] = useState<SongLibraryOption[]>([])
  const [songChoice, setSongChoice] = useState('')
  const [songQuery, setSongQuery] = useState('')
  const [sermonLibrary, setSermonLibrary] = useState<any[]>([])
  const [sermonChoice, setSermonChoice] = useState('')
  const [bibleBooks, setBibleBooks] = useState<BibleBookOption[]>([])
  const [bibleTranslations, setBibleTranslations] = useState<{ id: string; name: string; language: string; online?: boolean }[]>([{ id: 'BSB', name: 'Berean Standard Bible', language: 'en' }, { id: 'SYNO-W', name: 'Russian Synodal Bible', language: 'ru' }])
  const [bibleEnglish, setBibleEnglish] = useState('BSB')
  const [bibleRussian, setBibleRussian] = useState('SYNO-W')
  const [bibleBookId, setBibleBookId] = useState('Eph')
  const [bibleChapter, setBibleChapter] = useState(3)
  const [bibleStartVerse, setBibleStartVerse] = useState(14)
  const [bibleEndVerse, setBibleEndVerse] = useState(21)
  const [referenceKey, setReferenceKey] = useState(0)
  const [referenceValid, setReferenceValid] = useState(true)
  const [bibleVerseNumbers, setBibleVerseNumbers] = useState<number[] | undefined>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [resourceTab, setResourceTab] = useState<ResourceTab>(sermonSyncId ? 'templates' : 'songs')
  const paletteRef = useRef<HTMLElement>(null)
  const addSlideRef = useRef<HTMLButtonElement>(null)
  const createdSongRef = useRef<HTMLButtonElement>(null)
  const [createdSongId, setCreatedSongId] = useState('')
  const [songCreationNotice, setSongCreationNotice] = useState('')
  useEffect(() => {
    if (paletteOpen) paletteRef.current?.querySelector<HTMLElement>(resourceTab === 'songs' ? 'input[type=search]' : '[role=tab][aria-selected=true]')?.focus()
  }, [paletteOpen, resourceTab])
  useEffect(() => {
    if (createdSongId && createdSongRef.current) {
      createdSongRef.current.focus()
      createdSongRef.current.scrollIntoView({block:'nearest'})
      setCreatedSongId('')
    }
  }, [createdSongId])
  const closePalette = () => { setPaletteOpen(false); addSlideRef.current?.focus() }
  function openPalette() {
    if (activeServiceId) void loadLibraries()
    setResourceTab(sermonSyncId || (draft && withinSermon(draft,selectedId)) ? 'templates' : 'songs')
    setPaletteOpen(true)
  }
  const [readingTemplate, setReadingTemplateChoice] = useState('centered')
  const [alignmentRole, setAlignmentRole] = useState('bodyAlign')
  const [paletteChannel,setPaletteChannel]=useState<ChannelId>('english')
  const [songLanguage,setSongLanguage]=useState('all')
  const [sermonPassage, setSermonPassage] = useState(false)
  const [mediaPreviews, setMediaPreviews] = useState<Record<string, string>>({})
  const localUrls = useRef<string[]>([])
  useEffect(() => () => localUrls.current.forEach(url => URL.revokeObjectURL(url)), [])
  const [translationCueSlide,setTranslationCueSlide]=useState<PlannerSlide | null>(null)
  const [previewChannel, setPreviewChannel] = useState<ChannelId>('english')
  const [servicePreviewOpen, setServicePreviewOpen] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<'slides' | 'edit'>('slides')
  const [showDocumentId, setShowDocumentId] = useState<string | null>(null)
  const showDocumentRef = useRef<string | null>(null)
  const liveCueRef = useRef<string | null>(null)
  const [liveCueId, setLiveCueId] = useState<string | null>(null)
  const [showTakeError, setShowTakeError] = useState<string | null>(null)
  useEffect(() => {
    // SyncShow enables this only for its active Adjust surface. Ordinary web
    // Prepare clicks remain previews; the native host authorizes every take.
    const receiveShowMode = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      if (event.data?.type === 'heritage-editor:taken') {
        if (!showDocumentRef.current || event.data.syncId !== showDocumentRef.current) return
        if (event.data.ok === true) setShowTakeError(null)
        else if (event.data.ok === false) setShowTakeError(typeof event.data.error === 'string' ? event.data.error.slice(0,2000) : 'The slide could not be shown. The current screen is unchanged.')
        return
      }
      if (event.data?.type !== 'heritage-editor:show-mode') return
      if (event.data.enabled === false) {liveCueRef.current=null;showDocumentRef.current=null;setShowDocumentId(null);setLiveCueId(null);setShowTakeError(null)}
      else if (event.data.enabled === true && typeof event.data.syncId === 'string' && event.data.syncId.length <= 200) {
        const firstActivation=showDocumentRef.current!==event.data.syncId
        showDocumentRef.current=event.data.syncId;setShowDocumentId(event.data.syncId)
        liveCueRef.current=typeof event.data.currentCueId === 'string' ? event.data.currentCueId : null
        setLiveCueId(liveCueRef.current)
        if(firstActivation) {setWorkspaceView('edit');setPaletteOpen(false);setPreviewChannel(channel => channel === 'media' ? 'russian' : channel)}
        if (typeof event.data.currentCueId === 'string') {
          const currentDraft=latestDraft.current
          if(firstActivation && currentDraft && currentDraft.id===event.data.syncId) {
            const row=plannerSlides(currentDraft).find(row=>row.id===event.data.currentCueId)
            if(row){setSelectedId(row.itemId);setPreviewSlideIndex(row.index);setSelectedRowIds([row.id])}
          }
        }
        if(firstActivation)setShowTakeError(null)
      }
    }
    window.addEventListener('message', receiveShowMode)
    return () => window.removeEventListener('message', receiveShowMode)
  }, [])
  function selectThumbnail(row: PlannerSlide) {
    selectSlide(row, {ctrlKey: true})
    if (showDocumentId === envelope?.syncId && row.cue) {setShowTakeError(null);window.postMessage({type:'heritage-editor:take',syncId:envelope.syncId,cueId:row.id},window.location.origin)}
  }
  function chooseWorkspaceView(view: 'slides' | 'edit') {
    if (view === workspaceView) return
    // Commit a focused contenteditable before hiding its editing surface.
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('[contenteditable],textarea,input')) document.activeElement.blur()
    document.querySelectorAll<HTMLMediaElement>('.heritage-service-planner video,.heritage-service-planner audio').forEach(media => media.pause())
    setWorkspaceView(view); setPaletteOpen(false)
  }
  const [previewSlideIndex, setPreviewSlideIndex] = useState(0)
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([])
  const rangeAnchor = useRef<string | null>(null)
  const [menu, setMenu] = useState<{ row: PlannerSlide; ids: string[]; x: number; y: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moveDialog, setMoveDialog] = useState<string[] | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<string[] | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null)
  const dragged = useRef<string[] | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const workspaceMenuRef = useRef<HTMLDetailsElement>(null)
  const fontEdit = useRef<{project:ServiceProject;itemId:string;changed:boolean} | null>(null)
  const [undoStack, setUndoStack] = useState<ServiceProject[]>([])
  const bibleBookInput = useRef<HTMLSelectElement>(null)
  const bibleChapterInput = useRef<HTMLInputElement>(null)
  const bibleStartVerseInput = useRef<HTMLInputElement>(null)
  const bibleEndVerseInput = useRef<HTMLInputElement>(null)
  const pictureInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)
  const pictureTarget = useRef<PictureUploadTarget>('new')
  const canvasPictureTarget = useRef<{itemId:string;channelId:string} | null>(null)
  const [notice, setNotice] = useState<string | {key:string;variables:WorkspaceTextVariables}>('Choose a service or create the next one.')
  const noticeText = typeof notice === 'string' ? t(notice) : t(notice.key, notice.variables)
  const selected = selectedId && draft ? draft.items[selectedId] || null : null
  const slideList = useMemo<{ rows: PlannerSlide[]; error: string }>(() => {
    if (!draft) return { rows: [], error: '' }
    try {
      return { rows: plannerSlides(draft, previewChannel), error: '' }
    } catch (caught) {
      return { rows: [], error: errorText(caught) }
    }
  }, [draft, previewChannel])
  const scriptureScope = draft && selectedId ? scriptureTranslationScope(draft, selectedId) : null
  const selectedSlides = slideList.rows.filter(row => row.itemId === selectedId && row.cue)
  const activePreviewIndex = Math.min(previewSlideIndex, Math.max(0, selectedSlides.length - 1))
  const activeSlide = selectedSlides[activePreviewIndex]
  const navigatorRows = draft ? plannerNavigator(draft, slideList.rows, activeSlide?.id || selectedId) : []
  const activeSongPrimary = selected?.kind === 'song' ? songPresentation.presentationPrimaryChannelId(selected, activeSlide?.cue?.sourceLeafKey) : null
  const activePreviewCue = activeSlide?.cue
  const preview = plannerPreview(slideList.rows, activeSlide, previewChannel)
  const activePreviewOutput = preview.output
  const authoredSermon = useMemo(() => draft && selected?.sermonTemplate ? sermonContext.resolveSermonContext(draft)[selected.id]?.item : null, [draft, selected])
  const selectionIds = selectedRowIds.filter(id => slideList.rows.some(row => row.id === id))
  if (!selectionIds.length && (activeSlide || selected?.kind === 'group')) selectionIds.push(activeSlide?.id || selected!.id)
  const batchSlides = selectedPlannerSlides(slideList.rows, selectionIds)
  useEffect(() => {
    const handleUndo = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z' || event.isComposing || event.defaultPrevented) return
      const target = event.target instanceof HTMLElement ? event.target : null
      // Native editing owns its undo history until the edit is committed.
      if (target?.isContentEditable || target?.closest('input,textarea,[contenteditable="true"],[role="textbox"]')) return
      if (!undoStack.length || busy || servicePreviewOpen) return
      event.preventDefault(); undo()
    }
    document.addEventListener('keydown', handleUndo)
    return () => document.removeEventListener('keydown', handleUndo)
  }, [undoStack, busy, servicePreviewOpen, activeSlide?.id])
  const selectedKeys = new Set([...selectionIds, ...batchSlides.map(row => row.id)])
  const dialogSlides = selectedPlannerSlides(slideList.rows, moveDialog || [])
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(event.target as Node)) workspaceMenuRef.current.open = false
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const element = menuRef.current
    const position = () => {
      const bounds = element.getBoundingClientRect()
      element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`
      element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`
    }
    position()
    element.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true})
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', position)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); window.removeEventListener('resize', position) }
  }, [menu])
  const selectedSermonDocumentId = sermonDocumentIdForItem(draft, selected)
  const selectedSongContentChannels = selected?.kind === 'song'
    ? CHANNEL_IDS.filter(channelId => selected.variants?.[channelId]?.mode === 'content')
    : []

  async function loadList(initial = false) {
    if (sermonSyncId || activeServiceId) return
    setBusy(true)
    setError(null)
    try {
      const result = await jsonRequest(ENDPOINT)
      applyDeviceWorkspaceLanguage(result)
      setSummaries(result.items || [])
      workspaceIdentity.current = result
      try { if (latestDraft.current) rememberWorkspaceService(localStorage,result,latestDraft.current.id) } catch { /* Browser storage can be disabled. */ }
      if (initial) {
        const requested = new URL(window.location.href).searchParams.get('service')
        if (requested && result.items?.some((item:ServiceSummary) => item.syncId === requested)) await openService(requested)
      }
    } catch (caught) {
      setError(errorText(caught))
      // Only initial entry may navigate away. An expired session while editing
      // must leave the unsaved service on screen for the operator to recover.
      if (initial && (caught as { status?: number })?.status === 401) {
        window.location.replace(workspaceSignInHref('/admin/plan-service'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function loadLibraries() {
    try {
      const [songs, bible, sermons, slides] = await Promise.all([
        jsonRequest(`${ENDPOINT}/library/songs`),
        jsonRequest(`${ENDPOINT}/library/bible-passage`),
        jsonRequest('/api/community/sermon-presentations'),
        jsonRequest(`${ENDPOINT}/library/slides`),
      ])
      const nextSongs = songs.items || []
      setSongLibrary(nextSongs)
      setSongChoice(current => current || nextSongs[0]?.syncId || '')
      setBibleBooks(bible.books || [])
      if (bible.translations?.length) setBibleTranslations(bible.translations)
      setSermonLibrary(sermons.items || [])
      setReusableSlides(slides.items || [])
      setSermonChoice(current => current || sermons.items?.[0]?.syncId || '')
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  async function songCreated(syncId: string) {
    try {
      const result = await jsonRequest(`${ENDPOINT}/library/songs`)
      const songs: SongLibraryOption[] = result.items || []
      setSongLibrary(songs)
      const created = songs.find(song => song.syncId === syncId)
      if (created) { setSongQuery(''); setSongLanguage('all'); setSongChoice(created.syncId); setCreatedSongId(created.syncId); setSongCreationNotice('Song saved to the library. Review it, then add it to the service.') }
      else setSongCreationNotice('Song saved. Add lyrics and keep it active to use it in a service.')
    } catch (caught) { setError(errorText(caught)) }
  }

  function useEnvelope(next: ServiceEnvelopeInput, keepSelection = false, skipRecovery = false) {
    const project = projectFromServiceEnvelope(next) as ServiceProject
    const prepared = preparePlannerPresentation(project, {paginateItemIds: new Set()})
    const normalized = { ...next, project } as ServiceEnvelope
    envelopeRef.current = normalized; pendingSave.current = null; setAutosaveBlocked(false); setRecoveryConflict(null)
    saveConflictRef.current = false; setSaveConflict(false); setSaveConflictOpen(false)
    let recovered: ServiceProject | null = null
    let recoveredStatus = next.status
    try {
      const raw = skipRecovery ? null : localStorage.getItem(`heritage-planner-draft:${next.syncId}`)
      if (raw) {
        const saved = JSON.parse(raw)
        const safe = serviceCore.createHeritageServiceDocument(saved.project).project as ServiceProject
        if (safe.id === project.id) {
          if (saved.baseRevision === next.revision) { recovered = safe; if (['planning','ready','archived','cancelled'].includes(saved.desiredStatus)) recoveredStatus = saved.desiredStatus }
          else setRecoveryConflict(safe)
        }
      }
    } catch { /* Ignore invalid recovery content rather than replacing a service. */ }
    const opened = cloneProject(recovered || prepared.project as ServiceProject)
    latestDraft.current = opened; dirtyRef.current = Boolean(recovered) || prepared.changed
    setEnvelope(normalized)
    setDraft(opened)
    try { if (!sermonSyncId) rememberWorkspaceService(localStorage,workspaceIdentity.current,normalized.syncId) } catch { /* Browser storage can be disabled. */ }
    const retained = keepSelection && selectedId && prepared.project.items[selectedId]
    const liveRow = showDocumentRef.current === next.syncId && liveCueRef.current
      ? plannerSlides(opened).find(row => row.id === liveCueRef.current) : null
    setSelectedId(liveRow?.itemId || (retained ? selectedId : plannerSlides(prepared.project).find(row => row.cue)?.itemId || null))
    setPreviewSlideIndex(liveRow?.index ?? (retained ? previewSlideIndex : 0))
    setUndoStack([])
    setMenu(null)
    setSelectedRowIds([])
    rangeAnchor.current = null
    setMoveDialog(null)
    setDeleteDialog(null)
    statusRef.current = recoveredStatus; setDesiredStatus(recoveredStatus)
    setDirty(Boolean(recovered) || prepared.changed)
    setError(null)
    setNotice(recovered ? 'Recovered your unsaved local draft. Saving will resume.' : prepared.changed
      ? 'Section grouping and presentation layout updated. Save service to keep these changes.'
      : typeof next.syncVersion === 'number' ? {key:'{title} is open at Community version {version}.',variables:{title:project.title,version:next.syncVersion}}
        : {key:'{title} is open from this computer.',variables:{title:project.title}})
    loadList()
  }

  async function openService(syncId: string) {
    if (latestDraft.current && !await flushEditor('automatic')) return
    setBusy(true)
    setError(null)
    try {
      const result = await jsonRequest(`${ENDPOINT}/${encodeURIComponent(syncId)}`)
      useEnvelope(result.serviceDocument)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function copyService() {
    if (!draft || busy) return
    setBusy(true)
    setError(null)
    try {
      const syncId = `service-${draft.serviceDate}-${uuid().slice(0, 8)}`
      const title = `${draft.title.slice(0, 190)} — copy`
      const created = await jsonRequest(ENDPOINT, { method: 'POST', body: JSON.stringify({
        schemaVersion: 1, requestId: uuid(), syncId, title, serviceDate: draft.serviceDate,
      }) })
      const project = cloneProject(draft)
      project.id = syncId
      project.title = title
      project.revision = 2
      project.createdAt = new Date().toISOString()
      project.updatedAt = project.createdAt
      delete project.planning
      const result = await jsonRequest(`${ENDPOINT}/${encodeURIComponent(syncId)}`, { method: 'PUT', body: JSON.stringify({
        schemaVersion: 1, requestId: uuid(), syncId,
        baseSyncVersion: created.serviceDocument.syncVersion, baseRevision: created.serviceDocument.revision,
        documentSource: serviceCore.serializeHeritageServiceDocument(serviceCore.createHeritageServiceDocument(project)), status: 'planning',
      }) })
      useEnvelope(result.serviceDocument)
      setNotice('Service copied. The original service is unchanged.')
    } catch (caught) { setError(errorText(caught)) }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (activeServiceId) void openService(activeServiceId)
    else if (sermonSyncId) {
      setBusy(true)
      jsonRequest(`/api/community/sermon-presentations/${encodeURIComponent(sermonSyncId)}`, { method: 'POST' })
        .then(result => useEnvelope(result.serviceDocument))
        .catch(error => setError(errorText(error))).finally(() => setBusy(false))
    } else loadList(true)
    if (!activeServiceId) loadLibraries()
  }, [])

  useEffect(() => { onDirtyChange?.(dirty || desiredStatus !== envelope?.status) }, [dirty, desiredStatus, envelope?.status, onDirtyChange])

  function addReusable(template:any) {
    if(!draft)return
    try {
      const result=insertReusableSlide(draft,template.documentSource,selectedId)
      const deck=serviceCore.parseHeritageServiceDocumentSource(template.documentSource).project
      setMediaPreviews(value=>({...value,...Object.fromEntries(Object.keys(deck.assets).map(id=>[id,`${ENDPOINT}/library/slides/${template.id}/assets/${encodeURIComponent(id)}`]))}))
      acceptCoreProject(result.project,result.selectedId,'Slide copied into this service. Save when ready.')
    } catch(error) {setError(errorText(error))}
  }
  async function saveReusable() {
    if(!draft || !selected)return
    try {
      const result=await jsonRequest(`${ENDPOINT}/library/slides/slide-${crypto.randomUUID()}`,{method:'PUT',body:JSON.stringify({title:templateName || selected.title,autoStart:templateAutoStart,documentSource:extractReusableSlide(draft,selected.id)})})
      setReusableSlides(result.items);setTemplateName('');setTemplateAutoStart(false);setNotice('Saved in Media for future services.')
    } catch(error) {setError(errorText(error))}
  }
  async function removeReusable(id:string) {
    try { const result=await jsonRequest(`${ENDPOINT}/library/slides/${id}`,{method:'PUT',body:JSON.stringify({remove:true})});setReusableSlides(result.items) } catch(error) {setError(errorText(error))}
  }

  async function addWholeSermon() {
    if (!draft || !sermonChoice || busy) return
    setBusy(true); setError(null)
    try {
      const result = await jsonRequest(`/api/community/sermon-presentations/${encodeURIComponent(sermonChoice)}`)
      if (!result.serviceDocument) throw new Error('This sermon has no saved slides yet. Open Prepare a sermon first.')
      const imported = importSermonPresentation(draft, projectFromServiceEnvelope(result.serviceDocument), result.sermonDocument, selectedId)
      change(project => Object.assign(project, imported.project))
      setSelectedId(plannerSlides(imported.project).find(row => row.cue && !draft.items[row.itemId])?.itemId || imported.selectedId)
      setSelectedRowIds([])
      setNotice('Whole sermon added, including its saved slides and media. Save the service to keep it.')
      setPaletteOpen(false)
    } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }

  useEffect(() => {
    if (!envelope || (!dirty && desiredStatus === envelope.status)) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty, desiredStatus, envelope?.status])

  function change(mutator: (project: ServiceProject) => void) {
    const current = latestDraft.current
    if (!current) return
    const next = cloneProject(current)
    mutator(next)
    groupSermonSections(next)
    latestDraft.current = next
    setUndoStack(stack => [...stack.slice(-29), current])
    setDraft(next)
    setDesiredStatus('planning')
    setDirty(true)
    setNotice('Unsaved changes — output previews update immediately.')
  }

  function updateSelected(patch: Record<string, unknown>) {
    if (!selectedId) return
    change(project => {
      project.items[selectedId] = {
        ...project.items[selectedId],
        ...patch,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function changeFontSize(bodySize:number) {
    const current=latestDraft.current
    if(!current || !selectedId)return
    if(current.items[selectedId]?.kind!=='bible') {
      change(project=>{project.items[selectedId!].textStyle={...project.items[selectedId!].textStyle,bodySize}})
      return
    }
    try {
      // Always reflow from the beginning of this edit, so intermediate sizes
      // cannot gradually change source breaks, cues or the selected verse.
      const edit=fontEdit.current
      const result=reflowScripture(edit?.project || current,edit?.itemId || selectedId,bodySize)
      const next=cloneProject(result.project as ServiceProject)
      if(!edit || !edit.changed)setUndoStack(stack=>[...stack.slice(-29),edit?.project || current])
      if(edit)edit.changed=true
      latestDraft.current=next;setDraft(next)
      setSelectedId(result.selectedId);setSelectedRowIds([]);setPreviewSlideIndex(0)
      setDirty(true);setDesiredStatus('planning');setError(null)
      setNotice(result.protectedPages ? 'Size updated. Pages with edited wording keep their breaks so your excerpts stay intact.'
        : 'Passage pages reflowed at this size. Both languages keep matching verse breaks. Undo restores the old layout.')
    } catch(caught){setError(errorText(caught))}
  }

  function selectSlide(row: PlannerSlide, modifiers: {shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean} = {}) {
    setPaletteOpen(false)
    setSelectedId(row.itemId)
    setPreviewSlideIndex(Math.max(0, row.index))
    setSelectedRowIds(plannerClickSelection(slideList.rows, row, selectionIds, modifiers,
      rangeAnchor.current || activeSlide?.id || row.id))
    if (!modifiers.shiftKey) rangeAnchor.current = row.id
  }

  function slideMutation(operation: () => any, index = activePreviewIndex) {
    if (!draft) return
    try {
      const next = cloneProject(operation() as ServiceProject)
      groupSermonSections(next)
      if (JSON.stringify(next) === JSON.stringify(draft)) return
      latestDraft.current = next; dirtyRef.current = true; statusRef.current = 'planning'
      setUndoStack(stack => [...stack.slice(-29), draft])
      setDraft(cloneProject(next))
      setPreviewSlideIndex(index)
      setDirty(true)
      setDesiredStatus('planning')
      setError(null)
      setNotice('Unsaved changes · Library originals are unchanged.')
    } catch (caught) { setError(errorText(caught)) }
  }

  function applySelection(result: SelectionResult) {
    if (!draft) return
    setUndoStack(stack => [...stack.slice(-29), draft])
    groupSermonSections(result.project)
    setDraft(result.project as ServiceProject)
    setSelectedRowIds(result.selectedIds)
    rangeAnchor.current = result.activeId
    const active = plannerSlides(result.project).find(row => row.id === result.activeId)
    setSelectedId(active?.itemId || null)
    setPreviewSlideIndex(Math.max(0, active?.index || 0))
    setDirty(true); setDesiredStatus('planning'); setError(null)
    setNotice('Unsaved changes · Undo restores the whole operation.')
    setMenu(null); setDropTarget(null); dragged.current = null
  }

  function runSelection(ids: string[], operation: 'move' | 'duplicate' | 'delete', destination?: number) {
    try { applySelection(changePlannerSelection(draft!, ids, operation, destination)) }
    catch (caught) { setError(errorText(caught)); setMenu(null) }
  }

  function removeSelection(ids: string[]) {
    setMenu(null)
    setDeleteDialog(ids)
  }

  function dropSelection(ids: string[], target: PlannerSlide, after: boolean) {
    const chosen = new Set(selectedPlannerSlides(slideList.rows, ids).map(row => row.id))
    if (chosen.has(target.id) || ids.includes(target.id)) return
    const all = slideList.rows.filter(row => row.cue)
    const children = selectedPlannerSlides(slideList.rows, plannerClickSelection(slideList.rows, target))
    const boundary = children.length ? (after ? children.at(-1)!.number : children[0].number - 1)
      : slideList.rows.slice(0, slideList.rows.indexOf(target)).filter(row => row.cue).length
    runSelection(ids, 'move', all.slice(0, boundary).filter(row => !chosen.has(row.id)).length + 1)
  }

  function undo() {
    const previous = undoStack.at(-1)
    if (!previous) return
    setDraft(previous)
    const rows = plannerSlides(previous).filter(row => row.cue)
    const focus = rows[Math.min(Math.max(0, (activeSlide?.number || 1) - 1), rows.length - 1)]
    setSelectedRowIds(focus ? [focus.id] : [])
    setSelectedId(focus?.itemId || null)
    setPreviewSlideIndex(focus?.index || 0)
    rangeAnchor.current = focus?.id || null
    setUndoStack(stack => stack.slice(0, -1))
    setDirty(true)
    setDesiredStatus('planning')
    setError(null)
    setNotice('Change undone. Save when ready.')
  }

  function add(kind: 'group' | 'blank') {
    if (!draft) return
    setSelectedRowIds([])
    const now = new Date().toISOString()
    const id = `${kind}-${uuid()}`
    const { parentId, index } = insertionPoint(draft, selectedId, kind === 'blank')
    change(project => {
      const common = {
        id,
        kind,
        title: kind === 'group' ? 'Section' : 'Blank',
        operatorNotes: '',
        createdAt: now,
        updatedAt: now,
      }
      project.items[id] = kind === 'group'
        ? { ...common, groupKind: 'section', childIds: [] }
        : { ...common, channelIds: [...project.channelIds], presetId: 'blank-black' }
      if (parentId) project.items[parentId].childIds.splice(index, 0, id)
      else project.rootItemIds.splice(index, 0, id)
    })
    setPaletteOpen(false)
    setSelectedId(id)
    setPreviewSlideIndex(0)
  }

  function acceptCoreProject(project: ServiceProject, itemId: string, message: string) {
    setPaletteOpen(false)
    setSelectedRowIds([])
    if (draft) setUndoStack(stack => [...stack.slice(-29), draft])
    const prepared = preparePlannerPresentation(project, {paginateItemIds: new Set(Object.keys(project.items).filter(id => !draft?.items[id]))}).project as ServiceProject
    setDraft(cloneProject(prepared))
    setSelectedId(prepared.items[itemId]?.kind === 'group' ? prepared.items[itemId].childIds[0] || itemId : itemId)
    setPreviewSlideIndex(0)
    setDesiredStatus('planning')
    setDirty(true)
    setError(null)
    setNotice(message)
  }

  function addTemplate(template: Exclude<SermonTemplateId, 'passage'>) {
    if (!draft) return
    try {
      const id = `sermon-${uuid()}`
      const next = createTemplateDraft(draft, { id, template, selectedId })
      acceptCoreProject(next as ServiceProject, id, 'Slide added. Click the placeholders on the slide to edit; guides are never projected.')
      if (previewChannel === 'media') setPreviewChannel('english')
    } catch (caught) { setError(errorText(caught)) }
  }

  async function rememberSongLayout() {
    if(!selected || !draft || selected.kind!=='song')return
    const resourceId=Object.values(selected.variants as Record<string,any>).find((value:any)=>value.mode==='content')?.resourceId
    const syncId=draft.resources[resourceId]?.origin?.itemId
    if(!syncId){setError('This song is not linked to a Community library record.');return}
    setBusy(true)
    try {
      const lyric=slideList.rows.find(row=>row.itemId===selected.id && row.cue?.presetId?.includes('lyrics') || row.itemId===selected.id && row.cue?.presetId==='wotbc-song-stacked')
      const style={...selected.textStyle,...(lyric?.cue?.textStyle?.bodySize ? {bodySize:lyric.cue.textStyle.bodySize} : {})}
      await jsonRequest(`${ENDPOINT}/library/songs/${encodeURIComponent(syncId)}/layout`,{method:'POST',body:JSON.stringify(style)})
      setNotice('Song layout saved. New services will reuse this size and alignment.')
    } catch(caught){setError(errorText(caught))} finally{setBusy(false)}
  }

  async function addLibrarySong() {
    if (!draft || !songChoice || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await jsonRequest(
        `${ENDPOINT}/library/songs/${encodeURIComponent(songChoice)}`,
      )
      const librarySong = response.item
      const documents = (librarySong.syncDocuments || []).map((value: any) => ({
        ...value,
        ...parsePlannerLibrarySongDocument(value.source, {
          fileName: `${value.id}.md`,
        }),
      }))
      if (!documents.length) throw new Error('This song has no reviewed document to pin.')

      let project = cloneProject(draft)
      const pinned = documents.map((value: any) => {
        const result = (serviceCore.addSongResource as any)(project, value.document, {
          provider: 'heritage-community',
          providerId: 'song-library',
          itemId: librarySong.syncId,
          revision: value.revision,
        })
        project = result.project
        return { ...value, resourceId: result.resourceId }
      })
      const english = pinned.find((value: any) => value.document.language === 'en')
      const russian = pinned.find((value: any) => value.document.language === 'ru')
      const primary = (librarySong.defaultSongLanguage === 'en' ? english : russian) || english || russian || pinned[0]
      const compatible = (candidate: any) => (
        !candidate
        || candidate.resourceId === primary.resourceId
        || serviceCore.compareSongTranslations(primary.document, candidate.document).compatible
      )
      const alignedEnglish = compatible(english) ? english : null
      const alignedRussian = compatible(russian) ? russian : null
      const resourceByChannel = {
        english: alignedEnglish?.resourceId || primary.resourceId,
        russian: alignedRussian?.resourceId || primary.resourceId,
        media: alignedRussian?.resourceId || alignedEnglish?.resourceId || primary.resourceId,
      }
      const primaryChannelId = resourceByChannel.english === primary.resourceId
        ? 'english'
        : resourceByChannel.russian === primary.resourceId
          ? 'russian'
          : 'media'
      const arrangementSource = [primary, alignedEnglish, alignedRussian]
        .filter(Boolean)
        .sort((left: any, right: any) => (
          right.arrangementSectionIds.length - left.arrangementSectionIds.length
        ))[0]
      const itemId = `song-${uuid()}`
      project = serviceCore.addProjectItem(project, {
        id: itemId,
        kind: 'song',
        ...(librarySong.projectionStyle ? {textStyle:librarySong.projectionStyle} : {}),
        title: [librarySong.title, librarySong.russianTitle]
          .filter(Boolean)
          .filter((value: string, index: number, values: string[]) => values.indexOf(value) === index)
          .join(' / '),
        operatorNotes: `From Community song ${librarySong.syncId} v${librarySong.syncVersion}.`,
        variants: Object.fromEntries(CHANNEL_IDS.map(channelId => [channelId, {
          mode: 'content',
          resourceId: resourceByChannel[channelId],
          titleCardMode: 'simple',
        }])),
        arrangement: arrangementSource.arrangementSectionIds.map((sectionId: string) => ({
          id: `arr-${uuid()}`,
          sectionId,
        })),
        primaryChannelId,
        songPresentation: { stackedTranslation: Boolean(alignedEnglish && alignedRussian && alignedEnglish.resourceId !== alignedRussian.resourceId), primaryChannelId,
          secondaryChannelId: alignedEnglish && alignedRussian ? (primaryChannelId === 'english' ? 'russian' : 'english') : null,
          credits: [...new Set(pinned.flatMap((value:any) => [...(value.document.authors || []), ...(value.document.composers || []), ...(value.document.translators || [])]))].join(' / ').slice(0,500) },
        titlePresetId: 'wotbc-song-title',
        lyricsPresetId: alignedEnglish && alignedRussian ? 'wotbc-song-stacked' : 'wotbc-song-lyrics',
      }, {
        ...insertionPoint(draft, selectedId, false, true),
        now: new Date().toISOString(),
      })
      const singersSourceChannelId = primaryChannelId
      project = serviceCore.setSongChannelTreatment(project, {
        itemId,
        channelId: 'media',
        mode: 'derive-next-text',
        sourceChannelId: singersSourceChannelId,
        now: new Date().toISOString(),
      })
      project = applySongSectionLanguages(project, itemId, librarySong.sectionPrimaryLanguages || songDocumentSectionLanguages(documents))
      project = appendBlankSlide(project, itemId)
      const unaligned = Boolean((english && !alignedEnglish) || (russian && !alignedRussian))
      acceptCoreProject(
        project,
        itemId,
        unaligned
          ? 'Song pinned. One translation was not structurally aligned, so the reviewed primary version is used on that output until its arrangement is reviewed.'
          : 'Song pinned from Community with exact reviewed revisions. Save the shared service when the order is ready.',
      )
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function changeScriptureTranslation(channel: 'english' | 'russian', translationId: string, replaceEdits = false) {
    if (!draft || !scriptureScope || busy || !translationId) return
    if (!replaceEdits && hasScriptureEdits(draft, scriptureScope, channel)) {
      setEditionChange({channel,translationId}); return
    }
    const original = draft, scope = scriptureScope
    setBusy(true); setError(null); setNotice('Fetching the selected Bible translation…')
    try {
      const response = await jsonRequest(`${ENDPOINT}/library/bible-passage`, {
        method:'POST', body:JSON.stringify(scriptureTranslationRequest(original, scope, translationId)),
      })
      if (latestDraft.current !== original) throw new Error('The service changed while the translation was loading. Please choose the translation again.')
      const next = replaceScriptureTranslation(original, scope, {channel, translationId,
        translationName:bibleTranslations.find(value=>value.id===translationId)?.name || translationId,
        passage:response.passage.passagesByChannel.english, sourceUrl:response.passage.sources.english})
      slideMutation(() => next)
      setNotice('Translation updated for this passage. Verse selection and slide breaks are preserved. Save when ready; Undo restores the previous text.')
    } catch (caught) { setError(errorText(caught)); setNotice('Translation unchanged.') }
    finally { setBusy(false) }
  }

  const scriptureTranslationControls = scriptureScope && draft ? <fieldset className="heritage-scripture-editions" disabled={busy}>
    <legend>{t("Bible translation")}</legend>
    {(['english','russian'] as const).map(channel => {
      const editions = [...new Set(scriptureScope.itemIds.map(id=>draft.items[id].passagesByChannel[channel]?.translationId))]
      const value = editions.length === 1 ? editions[0] || '' : ''
      return <label key={channel}>{channel === 'english' ? t("English screen") : t("Russian / stage screen")}
        <select aria-label={t('Change {channel} Scripture translation', { channel: t(channel === 'english' ? 'English' : 'Russian') })} value={value} onChange={event=>void changeScriptureTranslation(channel,event.target.value)}>
          {!value && <option value="" disabled>{t("Mixed translations")}</option>}
          {value && !bibleTranslations.some(translation=>translation.id===value) && <option value={value}>{value}</option>}
          {bibleTranslations.map(translation=><option key={translation.id} value={translation.id}>{bibleTranslationOptionLabel(translation)}</option>)}
        </select>
      </label>
    })}
    <OnlineBibleNotice translations={bibleTranslations} />
    <small>{scriptureScope.itemIds.length > 1 ? t("Changes every page of this passage.") : t("Changes this passage.")}  {t("Other passages stay unchanged.")}</small>
  </fieldset> : null

  async function addBiblePassage() {
    if (!draft || busy || !referenceValid) return
    const visibleBibleBookId = bibleBookInput.current?.value || bibleBookId
    const visibleBibleChapter = Number(bibleChapterInput.current?.value || bibleChapter)
    const visibleBibleStartVerse = Number(bibleStartVerseInput.current?.value || bibleStartVerse)
    const visibleBibleEndVerse = Number(bibleEndVerseInput.current?.value || bibleEndVerse)
    setBusy(true)
    setError(null)
    try {
      const response = await jsonRequest(`${ENDPOINT}/library/bible-passage`, {
        method: 'POST',
        body: JSON.stringify({
          schemaVersion: 1,
          bookId: visibleBibleBookId,
          chapter: visibleBibleChapter,
          startVerse: visibleBibleStartVerse,
          endVerse: visibleBibleEndVerse,
          ...(bibleVerseNumbers ? {verseNumbers: bibleVerseNumbers} : {}),
          translations: { english: bibleEnglish, russian: bibleRussian },
        }),
      })
      const passage = response.passage
      const itemId = `bible-${uuid()}`
      let project = serviceCore.addBibleItem(draft, {
        id: itemId,
        title: `${passage.title} · ${passage.passagesByChannel.english.translationId} / ${passage.passagesByChannel.russian.translationId}`,
        range: passage.range,
        ...(passage.verseNumbers ? {verseNumbers: passage.verseNumbers} : {}),
        passagesByChannel: passage.passagesByChannel,
        presetId: sermonPassage ? 'wotbc-sermon-scripture' : 'wotbc-reading',
        operatorNotes: `Exact Bible text and attribution pinned from the selected editions.\nEnglish source: ${passage.sources.english}\nRussian source: ${passage.sources.russian}`,
        ...insertionPoint(draft, selectedId, false, !sermonPassage),
        now: new Date().toISOString(),
      })
      if (!sermonPassage) project = addReadingTitle(project, itemId, { english: bibleTranslations.find(value=>value.id===bibleEnglish)?.name || bibleEnglish, russian: bibleTranslations.find(value=>value.id===bibleRussian)?.name || bibleRussian })
      if (!sermonPassage && readingTemplate === 'pre-sermon') project = setReadingTemplate(project, `${itemId}-title`, 'pre-sermon')
      if (!sermonPassage) project = appendBlankSlide(project, `${itemId}-reading`)
      acceptCoreProject(
        project,
        sermonPassage ? itemId : `${itemId}-title`,
        'Reading added as short, synchronized Scripture slides. Save service when ready.',
      )
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  function setSelectedSongTreatment(channelId: ChannelId, value: string) {
    // Audience language selection must never replace or prune pinned lyrics.
    if (!draft || selected?.kind !== 'song' || channelId !== 'media' || selected.variants.media?.mode === 'content') return
    try {
      const mode = value === 'derive' ? 'derive-next-text' : value
      const sourceChannelId = mode === 'hidden' ? null : selected.songPresentation?.primaryChannelId || selected.primaryChannelId || selectedSongContentChannels[0]
      const source = cloneProject(draft)
      const project = serviceCore.setSongChannelTreatment(source, {
        itemId: selected.id,
        channelId,
        mode,
        sourceChannelId: sourceChannelId || null,
        now: new Date().toISOString(),
      })
      acceptCoreProject(
        project,
        selected.id,
        'Song output treatment changed while retaining the exact pinned library revisions.',
      )
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  function chooseSongAudienceLanguage(value: string) {
    if (!draft || selected?.kind !== 'song') return
    slideMutation(() => setSongAudienceLanguage(draft, selected.id, value))
  }

  function choosePicture(target: PictureUploadTarget) {
    pictureTarget.current = target
    canvasPictureTarget.current = target === 'canvas' && selectedId ? {itemId:selectedId,channelId:previewChannel} : null
    if (pictureInput.current) {
      pictureInput.current.value = ''
      pictureInput.current.click()
    }
  }

  async function pictureChosen(file: File | undefined) {
    if (!file || !draft || uploadingPicture) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP picture.')
      return
    }
    const target = pictureTarget.current
    const canvasTarget = canvasPictureTarget.current
    setUploadingPicture(true)
    setError(null)
    setNotice('Uploading the exact picture privately…')
    try {
      const uploaded = await uploadServiceMedia(file)
      const now = new Date().toISOString()
      const safeName = safeImageFileName(file.name, uploaded.metadata.mediaType)
      const asset = {
        id: uploaded.assetId,
        kind: 'image',
        mediaType: uploaded.metadata.mediaType,
        fileName: safeName.fileName,
        storedName: `${uploaded.sha256}.${safeName.extension}`,
        size: uploaded.metadata.size,
        sha256: uploaded.sha256,
        createdAt: now,
        width: uploaded.metadata.width,
        height: uploaded.metadata.height,
        orientation: uploaded.metadata.orientation,
        altText: file.name,
        attribution: '',
      }
      const previewUrl = URL.createObjectURL(file); localUrls.current.push(previewUrl); setMediaPreviews(value => ({ ...value, [asset.id]: previewUrl }))
      if (target === 'canvas' && canvasTarget) {
        change(project => {
          const item = project.items[canvasTarget.itemId]
          if (item?.sermonTemplate !== 'other') throw new Error('The target slide is no longer available.')
          project.assets[asset.id] = asset
          const objects = [...(item.objectsByChannel[canvasTarget.channelId] || []), newCanvasObject('image', {assetId:asset.id,altText:file.name})]
          const updated = editCanvasObjects(project, canvasTarget.itemId, canvasTarget.channelId, objects)
          project.items[canvasTarget.itemId] = updated.items[canvasTarget.itemId]
        })
      } else if (target === 'new') {
        const id = `picture-${uuid()}`
        const { parentId, index } = insertionPoint(draft, selectedId)
        change(project => {
          project.assets[asset.id] = asset
          project.items[id] = {
            id,
            kind: 'picture',
            title: file.name.replace(/\.[^.]+$/u, '') || 'Picture',
            operatorNotes: '',
            createdAt: now,
            updatedAt: now,
            assetIdsByChannel: Object.fromEntries(
              project.channelIds.map(channelId => [channelId, asset.id]),
            ),
            fit: 'fit',
            focalPoint: { x: 0.5, y: 0.5 },
            altText: file.name,
            attribution: '',
            presetId: 'picture-fullscreen',
          }
          if (parentId) project.items[parentId].childIds.splice(index, 0, id)
          else project.rootItemIds.splice(index, 0, id)
        })
        setSelectedId(id)
        setSelectedRowIds([])
        rangeAnchor.current = null
      } else if (target === 'background' && selected?.kind === 'sermon') {
        change(project => { project.assets[asset.id] = asset; const item = project.items[selected.id]; item.backgroundAssetIdsByChannel = { ...item.backgroundAssetIdsByChannel, [previewChannel]: asset.id }; if (previewChannel === 'russian') item.backgroundAssetIdsByChannel.media = asset.id })
      } else if (selected?.kind === 'picture') {
        change(project => {
          project.assets[asset.id] = asset
          const item = project.items[selected.id]
          const current = item.assetIdsByChannel
            ? { ...item.assetIdsByChannel }
            : Object.fromEntries((item.channelIds || project.channelIds)
              .map((channelId: string) => [channelId, item.assetId]))
          if (target === 'all') {
            item.assetIdsByChannel = Object.fromEntries(
              project.channelIds.map(channelId => [channelId, asset.id]),
            )
          } else {
            current[target] = asset.id
            item.assetIdsByChannel = current
          }
          delete item.assetId
          delete item.channelIds
          item.altText = item.altText || file.name
          item.updatedAt = now
        })
      }
      setNotice('Picture uploaded privately. Save the shared service to attach it to this revision.')
    } catch (caught) {
      setError(errorText(caught))
      setNotice('The service itself was not changed.')
    } finally {
      setUploadingPicture(false)
    }
  }

  async function videoChosen(file: File | undefined) {
    if (!file || !draft || uploadingVideo) return
    if (!['video/mp4', 'video/webm'].includes(file.type)) {
      setError('Choose an MP4 or WebM video.')
      return
    }
    setUploadingVideo(true)
    setError(null)
    setNotice('Uploading the exact video privately…')
    try {
      const uploaded = await uploadServiceMedia(file)
      const now = new Date().toISOString()
      const safeName = safeVideoFileName(file.name, uploaded.metadata.mediaType)
      const asset = {
        id: uploaded.assetId,
        kind: 'video',
        mediaType: uploaded.metadata.mediaType,
        fileName: safeName.fileName,
        storedName: `${uploaded.sha256}.${safeName.extension}`,
        size: uploaded.metadata.size,
        sha256: uploaded.sha256,
        createdAt: now,
        altText: file.name,
        attribution: '',
      }
      const id = `video-${uuid()}`
      const { parentId, index } = insertionPoint(draft, selectedId)
      const previewUrl = URL.createObjectURL(file); localUrls.current.push(previewUrl); setMediaPreviews(value => ({ ...value, [asset.id]: previewUrl }))
      change(project => {
        project.assets[asset.id] = asset
        project.items[id] = {
          id,
          kind: 'video',
          title: file.name.replace(/\.[^.]+$/u, '') || 'Video',
          operatorNotes: 'First Right or Space starts playback. Space pauses or resumes; Right advances.',
          createdAt: now,
          updatedAt: now,
          assetId: asset.id,
          channelIds: [...project.channelIds],
          audioChannelId: project.channelIds[0],
          fit: 'fit',
          presetId: 'video-fullscreen',
        }
        if (parentId) project.items[parentId].childIds.splice(index, 0, id)
        else project.rootItemIds.splice(index, 0, id)
      })
      setSelectedId(id)
      setSelectedRowIds([])
      rangeAnchor.current = null
      setNotice('Video uploaded privately. Save the shared service to attach it to this revision.')
    } catch (caught) {
      setError(errorText(caught))
      setNotice('The service itself was not changed.')
    } finally {
      setUploadingVideo(false)
    }
  }

  async function save(kind: 'automatic' | 'manual' | 'restore' = 'manual'): Promise<boolean> {
    if (saveConflictRef.current) return false
    if (saveInFlight.current) {
      const okay = await saveInFlight.current
      if (!okay) return false
      if (kind === 'automatic' && !dirtyRef.current && statusRef.current === envelopeRef.current?.status) return true
    }
    if (!latestDraft.current || !envelopeRef.current) return false
    const task = (async () => {
      setSaving(true); setError(null)
      async function sendPending() {
        const pending = pendingSave.current!
        const response = await jsonRequest(`${ENDPOINT}/${encodeURIComponent(pending.body.syncId)}`, {
          method: 'PUT', body: JSON.stringify(pending.body),
        })
        const next = { ...response.serviceDocument, project: projectFromServiceEnvelope(response.serviceDocument) } as ServiceEnvelope
        envelopeRef.current = next; setEnvelope(next)
        if (latestDraft.current === pending.draft) {
          const project = cloneProject(next.project)
          latestDraft.current = project; setDraft(project); dirtyRef.current = false; setDirty(false)
          try { localStorage.removeItem(`heritage-planner-draft:${next.syncId}`) } catch { /* storage may be disabled */ }
        }
        if (statusRef.current === pending.status) { statusRef.current = next.status; setDesiredStatus(next.status) }
        pendingSave.current = null; setAutosaveBlocked(false)
        setSummaries(rows => rows.map(row => row.syncId === next.syncId ? { ...row, syncVersion: next.syncVersion, revision: next.revision, status: next.status, changedAt: next.changedAt } : row))
        setNotice((next as any).conflict ? 'Saved on this computer. Review the server conflict before syncing.' : (next as any).savedLocally && (next as any).pending ? 'Saved on this computer. Waiting to sync.' : kind === 'automatic' ? 'All changes saved.' : kind === 'restore' ? 'Previous version restored as a new version.' : 'Manual checkpoint saved.')
      }
      try {
        // A network timeout may have happened after the server committed. Retry
        // its original identity first before sending any newer edits.
        if (pendingSave.current) await sendPending()
        const current = envelopeRef.current!
        const captured = latestDraft.current!
        if (kind === 'automatic' && !dirtyRef.current && statusRef.current === current.status) return true
        const project = cloneProject(captured)
        if (dirtyRef.current) { project.revision = current.project.revision + 1; project.updatedAt = new Date().toISOString() }
        const documentSource = dirtyRef.current ? serviceCore.serializeHeritageServiceDocument(serviceCore.createHeritageServiceDocument(project)) : current.documentSource
        pendingSave.current = { draft: captured, status: statusRef.current, body: {
          schemaVersion: 1, requestId: uuid(), syncId: current.syncId,
          baseSyncVersion: current.syncVersion, baseRevision: current.revision,
          documentSource, status: statusRef.current, saveKind: kind,
        } }
        await sendPending(); return true
      } catch (caught: any) {
        setAutosaveBlocked(true)
        if (caught?.status === 412) { saveConflictRef.current = true; setSaveConflict(true) }
        setError(caught?.status === 412
          ? 'This document changed elsewhere. Your draft remains on this screen. Review the current server version before deciding what to keep.'
          : `Saving paused: ${errorText(caught)} Your draft remains on this screen. Use Save to retry.`)
        return false
      } finally { setSaving(false) }
    })()
    saveInFlight.current = task
    try { return await task } finally { if (saveInFlight.current === task) saveInFlight.current = null }
  }
  saveHandler.current = save

  useEffect(() => {
    if (!draft || !envelope || !(dirty || desiredStatus !== envelope.status)) return
    if (recoveryConflict) return
    try { localStorage.setItem(`heritage-planner-draft:${envelope.syncId}`, JSON.stringify({ baseRevision: envelope.revision, project: draft, desiredStatus, savedAt: new Date().toISOString() })); setLocalRecoveryAvailable(true) }
    catch { setLocalRecoveryAvailable(false) }
    if (busy || saving || autosaveBlocked || historyOpen || saveConflictOpen) return
    const timer = window.setTimeout(() => void saveHandler.current('automatic'), 1200)
    return () => window.clearTimeout(timer)
  }, [draft, dirty, desiredStatus, envelope, busy, saving, autosaveBlocked, historyOpen, recoveryConflict, saveConflictOpen])

  async function reviewSaveConflict() {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.closest('input,textarea,[contenteditable]')) focused.blur()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    if (saveInFlight.current) await saveInFlight.current
    if (!saveConflictRef.current || !latestDraft.current) return
    setHistoryOpen(false); setSaveConflictOpen(true)
  }

  async function resolveSaveConflict(choice: 'draft' | 'saved', saved: ConflictSavedVersion, signature: string) {
    const current = latestDraft.current
    if (!saveConflictRef.current || !current || saved.syncId !== envelopeRef.current?.syncId || saved.project.id !== current.id) {
      throw new Error(t('The document changed while you were reviewing it. Open the review again.'))
    }
    if (conflictDraftSignature({ project: current, status: statusRef.current }) !== signature) {
      throw new Error(t('Your draft changed while this review was open. Review its updated preview before choosing.'))
    }
    if (choice === 'saved') {
      try { localStorage.removeItem(`heritage-planner-draft:${saved.syncId}`) } catch { /* storage may be disabled */ }
      useEnvelope(saved as ServiceEnvelope, true, true)
      setNotice('Using the saved version. Previous saved versions remain in history.')
      return true
    }
    // Consent applies to the reviewed server base and current local draft. A
    // fresh request identity is allowed only after the original CAS conflict.
    envelopeRef.current = saved as ServiceEnvelope; setEnvelope(saved as ServiceEnvelope)
    pendingSave.current = null; saveConflictRef.current = false; setSaveConflict(false)
    dirtyRef.current = true; setDirty(true); setAutosaveBlocked(false)
    const okay = await saveHandler.current('manual')
    // An uncertain network result must retain its request for exact retry;
    // return to editing instead of rebasing that request a second time.
    return okay || !saveConflictRef.current
  }

  async function flushEditor(kind: 'manual' | 'automatic' = 'manual') {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.closest('input,textarea,[contenteditable]')) focused.blur()
    // Native Adjust may lose focus as its view hides. Commit pending text
    // directly rather than relying on a blur event or its typing debounce.
    if(activeServiceId)document.querySelectorAll('.heritage-service-planner__stage [contenteditable]').forEach(node => node.dispatchEvent(new Event('heritage-editor:commit')))
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const frame=requestAnimationFrame(() => { clearTimeout(timer); resolve() })
      if(activeServiceId)timer=setTimeout(() => { cancelAnimationFrame(frame); resolve() },50)
    })
    if (!latestDraft.current) return true
    if (saveConflictRef.current) { await reviewSaveConflict(); return false }
    if (!await saveHandler.current(kind)) return false
    for (let attempt = 0; attempt < 10 && (dirtyRef.current || statusRef.current !== envelopeRef.current?.status); attempt++) {
      if (!await saveHandler.current('automatic')) return false
    }
    return !dirtyRef.current && statusRef.current === envelopeRef.current?.status
  }
  useEffect(() => {
    onFlushReady?.(() => flushEditor('automatic'))
    return () => onFlushReady?.(null)
  }, [onFlushReady, historyOpen])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's' || event.isComposing) return
      event.preventDefault(); if (!historyOpen) void flushEditor('manual')
    }
    const bridge = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin || (event.source !== window && event.source !== window.parent)) return
      if (event.data?.type === 'heritage-editor:open') { if (typeof event.data.syncId === 'string') await openService(event.data.syncId); return }
      if (event.data?.type !== 'heritage-editor:flush') return
      const requestId = String(event.data.requestId || '').slice(0, 200)
      const okay = await flushEditor('automatic')
      const source = event.source as Window | null
      source?.postMessage({ type: 'heritage-editor:flushed', requestId, ok: okay, serviceDocument: okay ? envelopeRef.current : undefined, error: okay ? undefined : 'The current changes could not be saved.' }, event.origin)
    }
    document.addEventListener('keydown', shortcut); window.addEventListener('message', bridge)
    return () => { document.removeEventListener('keydown', shortcut); window.removeEventListener('message', bridge) }
  }, [historyOpen])

  async function restoreVersion(project: ServiceProject) {
    if (saveConflictRef.current) { await reviewSaveConflict(); return false }
    if (dirtyRef.current && !await flushEditor('manual')) return false
    const restored = cloneProject(project)
    latestDraft.current = restored; setDraft(restored); dirtyRef.current = true; setDirty(true)
    statusRef.current = 'planning'; setDesiredStatus('planning')
    setUndoStack(stack => [...stack, cloneProject(envelopeRef.current!.project)])
    return saveHandler.current('restore')
  }

  return (
    <PresentationAccessibility><section className="heritage-service-planner" data-active-service={activeServiceId && envelope?.syncId}>
      {saveConflictOpen && draft && envelope ? <SaveConflictDialog syncId={envelope.syncId} localProject={draft} localStatus={desiredStatus} initialSlideIndex={Math.max(0, (activeSlide?.number || 1) - 1)} initialChannel={previewChannel} language={t.language} request={jsonRequest}
        localMediaUrl={id => mediaPreviews[id] || `${ENDPOINT}/${encodeURIComponent(envelope.syncId)}/history/${envelope.syncVersion}/assets/${encodeURIComponent(id)}`}
        onResolve={resolveSaveConflict} onHistory={() => { setSaveConflictOpen(false); setHistoryOpen(true) }} onClose={() => setSaveConflictOpen(false)} /> : null}
      {historyOpen && envelope ? <VersionHistoryDialog readOnly={saveConflict}  syncId={envelope.syncId} currentVersion={envelope.syncVersion} request={jsonRequest} onClose={() => setHistoryOpen(false)} onRestore={restoreVersion} /> : null}
      {translationCueSlide && draft ? <TranslationCueDialog slide={translationCueSlide} onClose={()=>setTranslationCueSlide(null)} onSave={settings=>{slideMutation(()=>setSlideTranslationCue(draft,translationCueSlide,'start',settings),translationCueSlide.index);setTranslationCueSlide(null)}}/> : null}
      {servicePreviewOpen && draft ? <ServicePreview project={draft} rows={slideList.rows} initialSlideId={activeSlide?.id} initialChannel={previewChannel} dirty={dirty}
        mediaUrl={assetId=>mediaPreviews[assetId] || (envelope?.project.assets?.[assetId] ? `${ENDPOINT}/${encodeURIComponent(envelope.syncId)}/assets/${encodeURIComponent(assetId)}` : undefined)}
        onClose={row=>{setServicePreviewOpen(false);if(row) selectSlide(row)}} /> : null}
      {error && !saveConflict ? <p className="heritage-service-planner__error" role="alert">{t(error)}</p> : null}
      {showTakeError && !error && !saveConflict ? <p className="heritage-service-planner__error" role="alert">{t('Slide was not shown: {error}',{error:t(showTakeError)})}</p> : null}
      {saveConflict ? <p className="heritage-service-planner__error" role="alert">{t('Saving paused because this document changed elsewhere. Your latest draft is safe here.')} <button type="button" onClick={() => void reviewSaveConflict()}>{t('Review saved version')}</button></p> : null}
      {recoveryConflict ? <p className="heritage-service-planner__error" role="alert">{t("A recovered local draft differs from the server version.")} <button type="button" onClick={() => { latestDraft.current = recoveryConflict; setDraft(recoveryConflict); dirtyRef.current = true; setDirty(true); setRecoveryConflict(null); setAutosaveBlocked(true); setNotice('Recovered draft is open for review. Use Save to keep it as a new version.'); }}>{t("Review recovered draft")}</button> <button type="button" onClick={() => setHistoryOpen(true)}>{t("Review saved versions")}</button> <button type="button" onClick={() => { if (!globalThis.confirm(t('Discard the recovered local draft? The saved server versions will remain in Version history.'))) return; try { localStorage.removeItem(`heritage-planner-draft:${envelope?.syncId}`) } catch {} setRecoveryConflict(null) }}>{t("Discard recovered draft")}</button></p> : null}
      {!localRecoveryAvailable && dirty ? <p className="heritage-service-planner__error" role="alert">{t("Local recovery storage is full or unavailable. Keep this page open until the server confirms your changes are saved.")}</p> : null}

      <header className="heritage-workspace-toolbar">
        <div className="heritage-workspace-toolbar__identity">
            {!activeServiceId && <details ref={workspaceMenuRef} className="heritage-service-planner__app-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
              <summary aria-label={t("Workspace menu")} title={t("Workspace menu")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></summary>
              <nav aria-label={t("Church workspace")}>
                <strong>{t("Church workspace")}</strong>
                {churchWorkspaceLinks.filter(item => item.href !== (sermonSyncId ? '/admin/prepare-sermon' : '/admin/plan-service')).map(item =>
                <a key={item.href} href={item.href}>{t(item.label)}</a>)}
              <a href="/" target="_blank" rel="noreferrer">{t("Church website ↗")}</a>
                <a href="/admin/account">{t("My account")}</a>
                <a href="/admin/logout">{t("Log out")}</a>
                <small>{noticeText}</small>
              </nav>
            </details>}
          <div className="heritage-workspace-toolbar__title"><strong>{draft?.title || (sermonSyncId ? t('Prepare sermon') : t('Plan service'))}</strong><span>{draft?.serviceDate}</span></div>
        </div>
        <div className="heritage-workspace-toolbar__views" role="group" aria-label={t('Workspace view')}>
          <button type="button" aria-pressed={workspaceView === 'slides'} onClick={() => chooseWorkspaceView('slides')}>{t('Slides')}</button>
          <button type="button" aria-pressed={workspaceView === 'edit'} disabled={!draft} onClick={() => chooseWorkspaceView('edit')}>{t('Edit')}</button>
        </div>
          <div className="heritage-service-planner__toolbar">
            <button type="button" className="heritage-service-planner__service-preview-button" aria-haspopup="dialog" disabled={!draft || !slideList.rows.some(row=>row.cue) || Boolean(slideList.error)} onClick={()=>setServicePreviewOpen(true)}>▦ {sermonSyncId ? t("Sermon preview") : t("Service Preview")}</button>
            <label htmlFor="service-status">{t("Status")}</label>
            <select id="service-status" value={desiredStatus} disabled={!draft || busy} onChange={event => setDesiredStatus(event.target.value as ServiceEnvelope['status'])}>
              <option value="planning">{t("Planning")}</option><option value="ready">{t("Ready")}</option>
              <option value="archived">{t("Archived")}</option><option value="cancelled">{t("Cancelled")}</option>
            </select>
            <button type="button" aria-label={sermonSyncId ? t("Save sermon slides") : t("Save service")} title={!draft ? t("Open a service to save") : saving ? t("Saving…") : t("Save checkpoint · Ctrl/Cmd+S · Right-click for version history")}
              disabled={!draft || busy || saving} onClick={() => void flushEditor('manual')} onContextMenu={event => { event.preventDefault(); if (draft) setHistoryOpen(true) }} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setHistoryOpen(true) } }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12l4 4v14H3V3h2zm2 0v7h10V3M7 21v-7h10v7" /></svg>
            </button>
            <button type="button" className="heritage-service-planner__history-button" disabled={!envelope || busy} aria-haspopup="dialog" onClick={() => setHistoryOpen(true)}>{t('Version history')}</button>
          </div>
          <p className="heritage-service-planner__save-state" aria-live="polite" title={noticeText}>{draft ? `${t('{count} slides', { count: slideList.rows.filter(row => row.cue).length })} · ${saving ? t("Saving…") : busy ? t("Working…") : saveConflict ? t("Draft kept locally · review conflict") : autosaveBlocked ? localRecoveryAvailable ? t("Draft kept locally · retry Save") : t("Unsaved · retry Save") : dirty || desiredStatus !== envelope?.status ? t("Waiting to save…") : (envelope as any)?.conflict ? t("Saved on this computer · sync conflict") : (envelope as any)?.savedLocally && (envelope as any)?.pending ? t("Saved on this computer · waiting to sync") : typeof envelope?.syncVersion === 'number' ? t('All changes saved · v{version}', { version: envelope.syncVersion }) : t('Saved on this computer')} ` : noticeText}</p>
      </header>
      <div className="heritage-service-planner__shell">
        <aside className="heritage-service-planner__navigation">
          {sidebarHeader}
          {!sermonSyncId && !activeServiceId && <>
          <div className="heritage-service-planner__service-picker">
            <label>
              <span>{t("Current service")}</span>
              <select value={envelope?.syncId || ''} disabled={busy || Boolean(showDocumentId)} onChange={event => openService(event.target.value)}>
                <option value="" disabled>{t("Choose a service…")}</option>
                {summaries.map(summary => <option key={summary.syncId} value={summary.syncId}>{summary.serviceDate} · {summary.title}</option>)}
              </select>
            </label>
            <button type="button" aria-label={t("Refresh services")} disabled={busy} onClick={() => void loadList()}>↻</button>
          </div>
          {!showDocumentId ? <NewService onCreated={useEnvelope} onCopy={draft && !busy ? copyService : undefined} /> : null}
          {envelope && (dirty || busy || desiredStatus !== envelope.status
            ? <p className="heritage-service-planner__save-state">{t("Save this service to open translation settings.")}</p>
            : <p><a href={`/admin/live-translation?service=${encodeURIComponent(envelope.syncId)}`} target="_blank" rel="noopener noreferrer">{t("Translation settings ↗")}</a></p>)}

          </>}

          <PresentationAccessibilityControl item={selected} />
          <div className="heritage-service-planner__outline-heading">
            <h2>{sermonSyncId ? t("Sermon slides") : t("Service order")}</h2><button type="button" className="heritage-add-slide" ref={addSlideRef} disabled={!draft} aria-expanded={paletteOpen} onClick={openPalette}>{t("＋ Add slide")}</button>
            <small aria-live="polite">{batchSlides.length > 1 ? t('{count} selected', { count: batchSlides.length }) : slideList.rows.filter(row=>row.cue).length > 20 ? t("Select a section to open its slides · Ctrl/⌘: one slide") : t("Section start: selects all · Ctrl/⌘: one slide")}</small>
          </div>

          {draft ? <ol className="heritage-service-planner__rows">
            {navigatorRows.map(row => {
              const rowSelected = selectedKeys.has(row.id)
              const openMenu = (x: number, y: number) => {
                const ids = rowSelected ? selectionIds : plannerClickSelection(slideList.rows, row)
                if (!rowSelected) selectSlide(row)
                setMenu({ row, ids, x, y })
              }
              return <li key={row.id} style={{ '--service-depth': row.depth } as React.CSSProperties}
                data-drop={dropTarget?.id === row.id ? (dropTarget.after ? 'after' : 'before') : undefined}>
                <button className="heritage-service-planner__row" data-kind={row.kind}
                  data-slide-id={row.id} data-selected={rowSelected || undefined} aria-pressed={rowSelected}
                  data-active={activeSlide?.id === row.id || undefined} aria-expanded={row.sectionSize ? row.sectionExpanded : undefined}
                  type="button" draggable title={`${row.title} · ${t('Click section start to select all · Ctrl/⌘-click for one slide · Shift-click for range · Right-click for actions')}`}
                  onClick={event => selectSlide(row, event)}
                  onContextMenu={event => { event.preventDefault(); openMenu(event.clientX, event.clientY) }}
                  onKeyDown={event => {
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom)
                    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
                      event.preventDefault(); setSelectedRowIds(slideList.rows.filter(value => value.cue).map(value => value.id))
                    } else if (event.key === 'Delete' || event.key === 'Backspace') {
                      event.preventDefault(); removeSelection(rowSelected ? selectionIds : plannerClickSelection(slideList.rows, row))
                    } else if (event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                      const numbered = slideList.rows.filter(value => value.cue)
                      const target = numbered[numbered.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)]
                      if (target) {
                        event.preventDefault(); selectSlide(target, { shiftKey: true })
                        event.currentTarget.closest('ol')?.querySelector<HTMLButtonElement>(`[data-slide-id="${CSS.escape(target.id)}"]`)?.focus()
                      }
                    }
                  }}
                  onDragStart={event => { dragged.current = rowSelected ? selectionIds : plannerClickSelection(slideList.rows, row); if (!rowSelected) selectSlide(row); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.id); setMenu(null) }}
                  onDragEnd={() => { dragged.current = null; setDropTarget(null) }}
                  onDragOver={event => { if (!dragged.current) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const rect = event.currentTarget.getBoundingClientRect(); setDropTarget({ id: row.id, after: event.clientY > rect.top + rect.height / 2 }) }}
                  onDrop={event => { event.preventDefault(); if (dragged.current) dropSelection(dragged.current, row, Boolean(dropTarget?.after)) }}>
                  <span className="heritage-service-planner__kind" aria-hidden="true">{row.sectionSize && row.sectionSize > 1 ? (row.sectionExpanded ? '▾' : '▸') : row.kind === 'group' ? '▾' : row.number}</span>
                  <span><strong>{row.number && row.sectionSize && row.sectionSize > 1 ? `${row.number}. ` : ''}{row.title}</strong>{row.cue?.translationAction ? <small className="heritage-service-planner__translation-cue">{row.cue.translationAction === 'start' ? t("▶ Start Translate") : t("■ Stop Translate")}</small> : null}</span>
                </button>
              </li>
            })}
            {!slideList.rows.length ? <li className="heritage-service-planner__empty">{slideList.error ? t(slideList.error) : t("Add a section, song, reading, or slide.")}</li> : null}
          </ol> : <p className="heritage-service-planner__empty">{t("No service open.")}</p>}
          {menu ? <div ref={menuRef} className="heritage-service-planner__context-menu" role="menu" aria-label={t("Slide actions")} style={{ left: menu.x, top: menu.y }}
            onKeyDown={event => {
              if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
              event.preventDefault()
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
            }}>
            <small>{selectedPlannerSlides(slideList.rows, menu.ids).length > 1 ? t('{count} selected slides', { count: selectedPlannerSlides(slideList.rows, menu.ids).length }) : menu.row.kind === 'group' ? t("Section") : t('Slide {number}', { number: menu.row.number || 0 })}</small>
            <button type="button" role="menuitem" onClick={() => { selectSlide(menu.row); setMenu(null); chooseWorkspaceView('edit'); setSettingsOpen(true) }}>{t("Slide settings…")}</button>
            {menu.row.kind === 'bible' && draft && draft.items[menu.row.itemId]?.passagesByChannel?.[previewChannel]?.displayText !== undefined ? <button type="button" role="menuitem" onClick={() => {
              const next = cloneProject(draft), item = next.items[menu.row.itemId]
              for (const output of previewChannel === 'russian' && item.passagesByChannel.media ? ['russian','media'] : [previewChannel]) { delete item.passagesByChannel[output].displayText; delete item.passagesByChannel[output].displaySpans }
              slideMutation(() => serviceCore.normalizeServiceProject(next)); setMenu(null)
            }}>{t("Restore original passage text")}</button> : null}
            {menu.row.cue && draft ? <>
              <button type="button" role="menuitem" onClick={() => {
                const action = menu.row.cue?.translationAction || translationActionForSlide(slideList.rows, menu.row)
                if(action==='start')setTranslationCueSlide(menu.row)
                else slideMutation(() => setSlideTranslationCue(draft, menu.row, 'stop'), menu.row.index)
                setMenu(null)
              }}>{menu.row.cue.translationAction==='start' ? t("Edit Translation Settings…") : t('Add “{action}” cue', { action: translationActionForSlide(slideList.rows, menu.row)==='start' ? t('Start Translate') : t('Stop Translate') })}</button>
              {menu.row.cue.translationAction ? <button type="button" role="menuitem" onClick={() => { slideMutation(() => setSlideTranslationCue(draft, menu.row, null), menu.row.index); setMenu(null) }}>{t("Remove translation cue")}</button> : null}
            </> : null}
            <button type="button" role="menuitem" onClick={() => runSelection(menu.ids, 'duplicate')}>{t("Duplicate")}</button>
            <button type="button" role="menuitem" onClick={() => { setMoveDialog(menu.ids); setMenu(null) }}>{t("Move To…")}</button>
            {([-1, 1] as const).map(offset => {
              const chosen = selectedPlannerSlides(slideList.rows, menu.ids)
              const target = (chosen[0]?.number || 1) + offset
              const maximum = slideList.rows.filter(row => row.cue).length - chosen.length + 1
              return <button key={offset} type="button" role="menuitem" disabled={!chosen.length || target < 1 || target > maximum} onClick={() => runSelection(menu.ids, 'move', target)}>{offset < 0 ? t('Move up') : t('Move down')}</button>
            })}
            <button type="button" role="menuitem" onClick={() => removeSelection(menu.ids)}>{t("Delete")}</button>
          </div> : null}
        </aside>

        {draft && workspaceView === 'slides' && !paletteOpen ? <ServicePreview inline showMode={showDocumentId === envelope?.syncId} liveCueId={liveCueId || undefined} project={draft} rows={slideList.rows} initialSlideId={activeSlide?.id} initialChannel={previewChannel} dirty={dirty}
          mediaUrl={assetId => mediaPreviews[assetId] || (envelope?.project.assets?.[assetId] ? `${ENDPOINT}/${encodeURIComponent(envelope.syncId)}/assets/${encodeURIComponent(assetId)}` : undefined)}
          onSelect={selectThumbnail} onChannel={id => setPreviewChannel(id as ChannelId)}
          onSlideMenu={(row,x,y) => {selectSlide(row,{ctrlKey:true});setMenu({row,ids:[row.id],x,y})}}
          onClose={row => {if(row) selectSlide(row,{ctrlKey:true});chooseWorkspaceView('edit')}} /> : null}
        <main className="heritage-service-planner__editor" hidden={paletteOpen || workspaceView !== 'edit'}>
          {selected ? <>
            <section className="heritage-service-planner__preview">
              <header className="heritage-service-planner__preview-heading">
                <div className="heritage-service-planner__preview-context">
                  <strong>{activeSlide ? t("Slide {number}", { number: activeSlide.number }) : selected.title}</strong>
                  <span className="heritage-service-planner__preview-title" title={draft?.title}>{draft?.title}</span>
                  <time dateTime={draft?.serviceDate}>{draft?.serviceDate}</time>
                  <span className="heritage-service-planner__preview-divider" aria-hidden="true">|</span>
                  <div className="heritage-service-planner__output-tabs" role="tablist" aria-label={t("Preview output")}>
                    <span>{t("Screen:")}</span>
                    {CHANNEL_IDS.map(channelId => <button key={channelId} type="button" role="tab" aria-selected={previewChannel === channelId} onClick={() => setPreviewChannel(channelId)}>{channelId === 'media' ? t('Stage-Facing Screen') : t(draft?.channels[channelId]?.label || channelId)}</button>)}
                  </div>
                </div>
                <div className="heritage-service-planner__preview-actions">
                  <button type="button" title={t("Undo (Ctrl+Z / Command+Z)")} aria-keyshortcuts="Control+Z Meta+Z" disabled={!undoStack.length || busy} onClick={undo}>{t("Undo")}</button>
                </div>
              </header>
              {activePreviewOutput?.fallbackFromChannelId ? <p className="heritage-service-planner__language-warning" role="status">
                {t('{language} is not configured. Screens will show {fallback} content until you add text here.', { language: t(draft?.channels[previewChannel]?.label || previewChannel), fallback: t(draft?.channels[activePreviewOutput.fallbackFromChannelId]?.label || 'the filled language') })}
              </p> : null}
              {selected.kind === 'song' && selected.songPresentation && !preview.singer ? <div className="heritage-service-planner__song-layout">
                <SongAudienceLanguages item={selected} onChange={chooseSongAudienceLanguage} />
                <label>{t("Primary language for this slide")} <select aria-label={t("Primary language for this slide")} value={selected.songPresentation.audienceLanguage && selected.songPresentation.audienceLanguage !== 'both' ? selected.songPresentation.audienceLanguage : selected.songPresentation.slidePrimaryChannelIds?.[activeSlide?.cue?.sourceLeafKey] || ''}
                  disabled={Boolean(selected.songPresentation.audienceLanguage && selected.songPresentation.audienceLanguage !== 'both')}
                  onChange={event => { const choices = {...selected.songPresentation.slidePrimaryChannelIds}; const key=activeSlide?.cue?.sourceLeafKey
                    if (!key) return
                    if (event.target.value) choices[key]=event.target.value; else delete choices[key]
                    updateSelected({songPresentation:{...selected.songPresentation,slidePrimaryChannelIds:choices}})
                  }}>
                  <option value="">{t("Song default ·")} {t(draft?.channels[selected.songPresentation.primaryChannelId]?.label || selected.songPresentation.primaryChannelId)}</option>
                  {selectedSongContentChannels.map(id=><option key={id} value={id}>{t(draft?.channels[id]?.label || id)}</option>)}
                </select></label>
                {activeSlide && isSongTitleSlide(activeSlide) && (!selected.songPresentation.audienceLanguage || selected.songPresentation.audienceLanguage === 'both') ? <label><input type="checkbox" aria-label={t("Show translated song title")} checked={selected.songPresentation.showTitleTranslation ?? selected.songPresentation.stackedTranslation}
                  disabled={!selected.songPresentation.secondaryChannelId}
                  onChange={event => updateSelected({songPresentation:{...selected.songPresentation,showTitleTranslation:event.target.checked}})} />  {t("Show second language beneath title")}</label>
                  : null}
              </div> : null}
              {selected.kind === 'sermon' && (selected.sermonTemplate === 'title' || selected.presetId === 'wotbc-sermon-title') && !preview.singer ? <div className="heritage-service-planner__song-layout">
                <button type="button" disabled={uploadingPicture} onClick={() => choosePicture('background')}>{uploadingPicture ? t("Uploading…") : (selected.backgroundAssetIdsByChannel?.[previewChannel] || selected.backgroundAssetId) ? t('Replace {language} image', { language: t(previewChannel === 'russian' ? 'Russian' : 'English') }) : t('Choose {language} image', { language: t(previewChannel === 'russian' ? 'Russian' : 'English') })}</button>
                <label className="heritage-sermon-title-input">{t("Title")}<input aria-label={t('{language} title for following passages', { language: t(previewChannel === 'russian' ? 'Russian' : previewChannel === 'media' ? 'Stage-Facing Screen' : 'English') })} value={selected.titlesByChannel?.[previewChannel] || ''} onChange={event => slideMutation(() => editTemplateField(draft!, selected.id, previewChannel, 'heading', event.target.value, formatting.remapTextSpans(selected.titlesByChannel?.[previewChannel] || '', event.target.value, selected.titleSpansByChannel?.[previewChannel] || [])))} /></label>
                <label><input type="checkbox" checked={selected.sermonPresentation?.showText ?? true} onChange={event => updateSelected({ sermonPresentation: {darkenBackground: true, ...selected.sermonPresentation, showText: event.target.checked} })} />  {t("Show title text")}</label>
                <label><input type="checkbox" checked={selected.sermonPresentation?.darkenBackground ?? true} onChange={event => updateSelected({ sermonPresentation: {showText: true, ...selected.sermonPresentation, darkenBackground: event.target.checked} })} />  {t("Darken image")}</label>
              </div> : null}
              <div className="heritage-service-planner__slide-workspace" data-canvas={!preview.singer && selected.kind !== 'group' || undefined}>
              <PreviewCanvas captionReservation={translationSettings.reservation(activeSlide?.cue?.translationSettings,previewChannel)} textStyle={activeSlide?.cue?.textStyle} kind={selected.kind} presetId={preview.presetId} template={selected.sermonTemplate} titleCard={Boolean(activeSlide && isSongTitleSlide(activeSlide))} singer={preview.singer} next={preview.next} backgroundDimOpacity={selected.sermonPresentation?.darkenBackground === false ? 0 : 0.55} backgroundUrl={(selected.backgroundAssetIdsByChannel?.[previewChannel] || selected.backgroundAssetId) ? mediaPreviews[selected.backgroundAssetIdsByChannel?.[previewChannel] || selected.backgroundAssetId] || `${ENDPOINT}/${encodeURIComponent(envelope!.syncId)}/assets/${encodeURIComponent(selected.backgroundAssetIdsByChannel?.[previewChannel] || selected.backgroundAssetId)}` : undefined}>
                {selected.kind === 'group' ? <p className="heritage-service-planner__stage-status">{t("Choose a numbered slide on the left.")}<br />{t('“{title}” is a section, not a slide.', { title: selected.title })}</p>
                  : slideList.error ? <p className="heritage-service-planner__stage-status">{t("Preview unavailable:")} {slideList.error}</p>
                  : selected.sermonTemplate === 'other' && !preview.singer ? <CanvasSlide key={`${selected.id}:${previewChannel}`} objects={selected.objectsByChannel[previewChannel] || []} mediaUrl={id=>mediaPreviews[id] || `${ENDPOINT}/${encodeURIComponent(envelope!.syncId)}/assets/${encodeURIComponent(id)}`} uploading={uploadingPicture} onImage={()=>choosePicture('canvas')} onChange={objects=>slideMutation(()=>editCanvasObjects(draft!,selected.id,previewChannel,objects))} />
                  : selected.sermonTemplate && !preview.singer ? <TemplateSlideEditor key={`${selected.id}:${previewChannel}`} item={authoredSermon || selected} channelId={previewChannel} uploading={uploadingPicture} onImage={() => choosePicture('background')}
                      onEdit={(field, text, spans) => slideMutation(() => editTemplateField(draft!, selected.id, previewChannel, field, text, spans))} />
                  : activePreviewOutput?.mode === 'hide' ? <p className="heritage-service-planner__stage-status">{t("Hidden on this screen")}</p>
                    : selected.kind === 'blank' ? <p className="heritage-service-planner__stage-status">{t("Intentional blank screen")}</p>
                      : (activePreviewOutput?.blocks || []).map((block: any, index: number) => {
                        if (block.type === 'canvas') return <CanvasSlide key={index} objects={block.objects} mediaUrl={id=>mediaPreviews[id] || `${ENDPOINT}/${encodeURIComponent(envelope!.syncId)}/assets/${encodeURIComponent(id)}`} />
                        if (block.type === 'image' && block.role === 'background') return null
                        if (block.type === 'image' || block.type === 'video') {
                          if (!envelope?.project.assets?.[block.assetId] && !mediaPreviews[block.assetId]) return <p key={index} className="heritage-service-planner__stage-status">{t("Save the service to preview this new media file.")}</p>
                          const source = mediaPreviews[block.assetId] || `${ENDPOINT}/${encodeURIComponent(envelope!.syncId)}/assets/${encodeURIComponent(block.assetId)}`
                          return block.type === 'image'
                            ? <img key={index} src={source} alt={block.altText || selected.title} />
                            : <video key={index} src={source} controls preload="metadata" muted={block.muted} />
                        }
                        if (block.type === 'bible') return <div key={index} className="heritage-service-planner__scripture-page" data-fit-text>
                          {preview.presetId !== 'wotbc-sermon-scripture' && (block.displayReference ?? block.reference) ? <p className="heritage-service-planner__scripture-reference">{readingLabels.localizedReference(block.displayReference ?? block.reference, draft?.channels[previewChannel]?.language)}</p> : null}
                          <SlideText text={formatting.scriptureDisplay(block, preview.presetId).text} spans={formatting.scriptureDisplay(block, preview.presetId).spans} label={t('Slide {number} {language} Scripture — click to edit', { number: activeSlide?.number || 0, language: t(previewChannel === 'russian' ? 'Russian' : previewChannel === 'media' ? 'Stage-Facing Screen' : 'English') })} role="body" readOnly={preview.singer} canFormat={!preview.singer}
                            onCommit={(text, spans) => activeSlide && slideMutation(() => editPlannerSlide(draft!, activeSlide, previewChannel, index, text, spans))} />
                          {formatting.scriptureCredit(block) ? <p className="heritage-scripture-credit">{formatting.scriptureCredit(block)}</p> : null}
                        </div>
                        return activeSlide && block.type === 'text'
                          ? <SlideText key={`${activeSlide.id}:${previewChannel}:${index}`} text={previewBlockText(block)} role={block.role}
                              readOnly={preview.singer || !editablePreviewBlock(draft!, activeSlide, previewChannel, block)}
                              spans={block.spans}
                              canFormat={!preview.singer && ['sermon', 'notice'].includes(selected.kind)}
                              label={`Slide ${activeSlide.number} ${selected.kind === 'song' && selected.songPresentation?.stackedTranslation && block.role === 'lyrics'
                                ? (index === 0 ? activeSongPrimary : songPresentation.presentationSecondaryChannelId(selected, activeSongPrimary)) : previewChannel} ${block.role} — click to edit`}
                              onCommit={(text, spans) => slideMutation(() => editPlannerSlide(draft!, activeSlide, previewChannel, index, text, ['sermon','notice'].includes(selected.kind) ? spans : undefined))} />
                          : <p key={index} data-role={block.role || 'scripture'}>{previewBlockText(block)}</p>
                      })}
              </PreviewCanvas>
              {!preview.singer && selected.sermonTemplate !== 'other' && ['song','bible','sermon','notice'].includes(selected.kind) && <aside className="heritage-text-inspector" aria-label={t("Text layout")}>
                <h3>{t("Text layout")}</h3>
                {scriptureTranslationControls}
                {selected.presetId==='wotbc-reading-title' && <label>{t("Reading template")}<select value="centered" onChange={event=>slideMutation(()=>setReadingTemplate(draft,selected.id,event.target.value))}><option value="centered">{t("Centered title")}</option><option value="pre-sermon">{t("Pre-sermon")}</option></select></label>}
                <label>{t("Apply alignment to")}<select aria-label={t("Alignment field")} value={alignmentRole} onChange={event=>setAlignmentRole(event.target.value)}><option value="bodyAlign">{t("Text")}</option><option value="titleAlign">{t("Heading")}</option><option value="creditAlign">{t("Author / source")}</option></select></label>
                <div role="group" aria-label={t("Text alignment")}>{['left','center','right'].map(align=><button type="button" key={align} aria-label={t('Align {alignment}', { alignment: t(align) })} aria-pressed={(selected.textStyle?.[alignmentRole] || typography.textPreset(preview.presetId)[alignmentRole] || (alignmentRole==='creditAlign' && !(activeSlide && isSongTitleSlide(activeSlide)) ? t("right") : t("center")))===align} onClick={()=>change(project=>{
                  const ids=typographyItemIds(project,selected.id)
                  ids.forEach((id:string)=>{project.items[id].textStyle={...project.items[id].textStyle,[alignmentRole]:align}})
                })}>{t(align)}</button>)}</div>
                {!(activeSlide && isSongTitleSlide(activeSlide)) && <label>{selected.kind==='song' ? t("Song font size") : selected.kind==='bible' ? t("Reading font size") : t("Text size")}<NumberDraftInput value={selected.textStyle?.bodySize || activeSlide?.cue?.textStyle?.bodySize || typography.textPreset(preview.presetId).bodySize} min={32} max={160} live={selected.kind==='bible'}
                  onEditStart={()=>{if(selected.kind==='bible' && latestDraft.current)fontEdit.current={project:latestDraft.current,itemId:selected.id,changed:false}}}
                  onEditEnd={()=>{fontEdit.current=null}} onCommit={changeFontSize} /></label>}
                {selected.textStyle?.bodySize && activeSlide?.cue?.textStyle?.bodySize && selected.textStyle.bodySize !== activeSlide.cue.textStyle.bodySize && <small>{t("Fitted size:")} {activeSlide.cue.textStyle.bodySize}  {t("across all pages.")}</small>}
                {selected.kind==='song' && <><small>{t("One size for the whole song. Long lines can reduce it by up to 25%.")}</small><button type="button" disabled={busy} onClick={rememberSongLayout}>{t("Remember for this song")}</button></>}
                {selected.kind==='bible' && <><small>{t("Whole verses move between pages to fit this size. Both languages stay together.")}</small><button type="button" onClick={()=>changeFontSize(selected.textStyle?.bodySize || activeSlide?.cue?.textStyle?.bodySize || typography.textPreset(preview.presetId).bodySize)}>{t("Reflow pages")}</button><BibleSourceNotice translationIds={Object.values(selected.passagesByChannel || {}).map((p:any)=>p.translationId)} /></>}
              </aside>}
              {selected.sermonTemplate === 'other' && !preview.singer && <aside className="heritage-canvas-inspector" aria-label={t("Slide objects")}>
                {selected.presetId==='wotbc-reading-title' && <label>{t("Reading template")}<select value="pre-sermon" onChange={event=>slideMutation(()=>setReadingTemplate(draft,selected.id,event.target.value))}><option value="centered">{t("Centered title")}</option><option value="pre-sermon">{t("Pre-sermon")}</option></select></label>}
                {scriptureTranslationControls}
                <div id="heritage-canvas-tools" />
                <button type="button" className="heritage-canvas-copy" onClick={()=>{if(globalThis.confirm(t('Replace the objects on the other outputs with this slide layout?')))updateSelected({objectsByChannel:Object.fromEntries(draft!.channelIds.map(id=>[id,JSON.parse(JSON.stringify(selected.objectsByChannel[previewChannel] || []))]))})}}>{t("Copy layout to all outputs")}</button>
              </aside>}
              </div>
              <p className="heritage-service-planner__preview-note">{preview.singer
                ? t("Full primary-language slide · Same-size next line, fitted to the available width.")
                : selected.kind === 'bible' ? t("Click Scripture to edit this slide · Add omissions or [context] · Original Bible text is preserved.")
                  : selected.kind === 'song' && selected.songPresentation?.stackedTranslation ? t("Same stack on both audience screens · White primary language, orange translation · Click either to edit.")
                  : selected.kind === 'sermon' ? t("Click directly on the slide to edit · Select text for formatting · Empty guides are not projected.")
                  : selected.kind === 'picture' ? t("Picture slide. Open Add slide → Media to replace its image.")
                    : t("Click the slide text to edit · Click outside to apply · Save to keep changes")}</p>
            </section>
            {selected.objectsByChannel?.[previewChannel]?.some((object: any) => object.id === 'welcome-topic') ?
              <label className="heritage-service-planner__welcome-topic">{t("Service / sermon topic")}<input aria-label={t("Welcome slide topic")} value={selected.objectsByChannel[previewChannel].find((object: any) => object.id === 'welcome-topic')?.text || ''}
                  placeholder={previewChannel === 'english' ? 'Topic for this service' : 'Тема служения'}
                  onChange={event => slideMutation(() => editCanvasObjects(draft, selected.id, previewChannel, selected.objectsByChannel[previewChannel].map((object: any) => object.id === 'welcome-topic' ? { ...object, text: event.target.value, spans: [] } : object)))} />
              </label> : null}


            {settingsOpen && <SlideSettingsDialog onClose={() => { setSettingsOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.heritage-service-planner__rows [data-slide-id="${CSS.escape(activeSlide?.id || selected.id)}"]`)?.focus()) }}>
                <label><span>{t("Item name")}</span><input value={selected.title} maxLength={200} onChange={event => updateSelected({ title: event.target.value })} /></label>
                <label><span>{t("Notes for the operator")}</span><input value={selected.operatorNotes || ''} onChange={event => updateSelected({ operatorNotes: event.target.value })} /></label>
                {selected.kind === 'sermon' && (selected.sermonTemplate === 'title' || selected.presetId === 'wotbc-sermon-title') ? <label className="heritage-service-planner__check"><input type="checkbox" aria-label={t("Show next-slide hints for this sermon")} checked={selected.sermonPresentation?.showNextSlideHints ?? true}
                  onChange={event=>updateSelected({sermonPresentation:{showText:true,darkenBackground:true,...selected.sermonPresentation,showNextSlideHints:event.target.checked}})} /><span>{t("Show next-slide hints for this sermon")}</span><small>{t("Applies to the title, points, quotations, and passages in this sermon.")}</small></label> : null}
                {selected.kind === 'song' && selected.songPresentation ? <label><span>{t("Song credit · bottom right of title slide")}</span><input aria-label={t("Song credit")} value={selected.songPresentation.credits} maxLength={500}
                  onChange={event => updateSelected({ songPresentation: { ...selected.songPresentation, credits: event.target.value } })} /></label> : null}

            {(selected.backgroundAssetIdsByChannel?.[previewChannel] || selected.backgroundAssetId) ? <button type="button" disabled={uploadingPicture} onClick={() => choosePicture('background')}>{t("Replace title image")}</button> : null}
            {selected.kind === 'picture' ? <div className="heritage-service-planner__picture-editor">
              <button type="button" disabled={uploadingPicture} onClick={() => choosePicture('all')}>{uploadingPicture ? t("Uploading…") : t("Replace on every output")}</button>
              <label><span>{t("Image description")}</span><input value={selected.altText || ''} onChange={event => updateSelected({ altText: event.target.value })} /></label>
              <label><span>{t("Attribution")}</span><input value={selected.attribution || ''} onChange={event => updateSelected({ attribution: event.target.value })} /></label>
            </div> : null}

            {selected.kind === 'video' ? <div className="heritage-service-planner__picture-editor">
              <p className="heritage-service-planner__boundary">{t("The video opens paused. First Right or Space plays it; Space pauses or resumes; Right advances to the next service item.")}</p>
              <label><span>{t("Audio output")}</span><select value={selected.audioChannelId} onChange={event => updateSelected({ audioChannelId: event.target.value })}>{selected.channelIds.map((channelId: string) => <option key={channelId} value={channelId}>{t(draft?.channels[channelId]?.label || channelId)}</option>)}</select></label>
            </div> : null}

                {presetChoices(selected).length ? <label><span>{t("Visual preset")}</span><select value={itemPreset(selected)} onChange={event => updateSelected(selected.kind === 'song' ? { lyricsPresetId: event.target.value } : { presetId: event.target.value })}>{presetChoices(selected).map(preset => <option key={preset} value={preset}>{preset}</option>)}</select></label> : null}
                {selected.kind === 'group' ? <label><span>{t("Section type")}</span><select value={selected.groupKind} onChange={event => updateSelected({ groupKind: event.target.value })}>{['service', 'section', 'sermon', 'point', 'subpoint', 'custom'].map(kind => <option key={kind} value={kind}>{t(kind)}</option>)}</select></label> : null}
                {selected.kind === 'blank' ? CHANNEL_IDS.map(channelId => <label className="heritage-service-planner__check" key={channelId}><input type="checkbox" checked={selected.channelIds.includes(channelId)} onChange={event => updateSelected({ channelIds: event.target.checked ? [...new Set([...selected.channelIds, channelId])] : selected.channelIds.filter((id: string) => id !== channelId) })} /><span>{t("Clear")} {t(draft?.channels[channelId]?.label || channelId)}</span></label>) : null}
                {selected.kind === 'song' && selected.songPresentation ? <label><span>{t("Song default primary language")}</span><select aria-label={t("Song default primary language")} value={selected.songPresentation.primaryChannelId}
                  onChange={event=>updateSelected({songPresentation:{...selected.songPresentation,primaryChannelId:event.target.value,secondaryChannelId:songPresentation.presentationSecondaryChannelId(selected,event.target.value)}})}>
                  {selectedSongContentChannels.map(id=><option key={id} value={id}>{t(draft?.channels[id]?.label || id)}</option>)}
                </select><small>{t("Individual slide choices stay in place.")}</small></label> : null}
                {selected.kind === 'song' ? <div className="heritage-service-planner__treatments">
                  {selected.songPresentation && <SongAudienceLanguages item={selected} onChange={chooseSongAudienceLanguage} />}
                  <p className="heritage-service-planner__boundary">{t('Language choices keep both lyric sources. Individual slide choices return when you select Both languages.')}</p>
                  {(['media'] as const).map(channelId => {
                    const primaryChannelId = selected.primaryChannelId || selectedSongContentChannels[0]
                    return <label key={channelId}><span>{t('Stage-Facing Screen')}</span><select aria-label={t('Stage-Facing Screen treatment')} value={selected.variants?.[channelId]?.mode || 'hidden'} disabled={channelId === primaryChannelId || selected.variants?.[channelId]?.mode === 'content'} onChange={event => setSelectedSongTreatment(channelId, event.target.value)}>
                      {selected.variants?.[channelId]?.mode === 'content' ? <option value="content">{t("Pinned exact lyrics")}</option> : null}
                      {selected.variants?.[channelId]?.mode === 'inherit' ? <option value="inherit">{t('Song lyrics')}</option> : null}
                      <option value="derive">{t('Current + next · follows singing language')}</option>
                      <option value="hidden">{t("Hidden")}</option>
                    </select></label>
                  })}
                </div> : null}
                {selected.kind === 'picture' ? <label><span>{t("Fit")}</span><select value={selected.fit} onChange={event => updateSelected({ fit: event.target.value })}><option value="fit">{t("fit")}</option><option value="fill">{t("fill")}</option><option value="stretch">{t("stretch")}</option></select></label> : null}
                {selected.kind === 'video' ? <>
                  <label><span>{t("Fit")}</span><select value={selected.fit} onChange={event => updateSelected({ fit: event.target.value })}><option value="fit">{t("fit")}</option><option value="fill">{t("fill")}</option><option value="stretch">{t("stretch")}</option></select></label>
                  {CHANNEL_IDS.map(channelId => <label className="heritage-service-planner__check" key={channelId}><input type="checkbox" checked={selected.channelIds.includes(channelId)} disabled={channelId === selected.audioChannelId} onChange={event => updateSelected({ channelIds: event.target.checked ? [...new Set([...selected.channelIds, channelId])] : selected.channelIds.filter((id: string) => id !== channelId) })} /><span>{t("Show on")} {t(draft?.channels[channelId]?.label || channelId)}{channelId === selected.audioChannelId ? ` ${t('· audio')}` : ''}</span></label>)}
                </> : null}
                {selected.kind === 'bible' ? <p className="heritage-service-planner__boundary">{t("This reading keeps exact translation text and checksums. Use Add slide → Scripture if the passage changes.")}</p> : null}
                {selectedSermonDocumentId ? <a className="btn btn--style-secondary" href={`/admin/sermon-publications?sermon=${encodeURIComponent(selectedSermonDocumentId)}`}>{t("Open sermon publication review")}</a> : null}
</SlideSettingsDialog>}

          </> : <div className="heritage-service-planner__editor-empty"><h2>{draft ? t("Choose a slide on the left") : t("Choose a service to begin")}</h2>{undoStack.length ? <button type="button" onClick={undo}>{t("Undo")}</button> : null}</div>}
        </main>

        <section className="heritage-service-planner__resources heritage-add-workspace" ref={paletteRef} hidden={!paletteOpen} aria-label={t("Add slide palette")} onKeyDown={event=>{if(event.key==='Escape')closePalette()}}>
          <header className="heritage-add-header"><div><small>{t("Service planner")}</small><h2>{t("Add a slide")}</h2><p>{activeSlide ? t('Selected: slide {number} · {title}', { number: activeSlide.number, title: activeSlide.title }) : t("Build your service")}{draft && withinSermon(draft,selectedId) && <span>{t("Inside sermon")}</span>}</p></div><button type="button" aria-label={t("Close add slide palette")} onClick={closePalette}>×</button></header>
          <div className="heritage-add-workbench" data-category={resourceTab}>
          <nav className="heritage-add-categories" role="tablist" aria-label={t("Add slides")}>
            {(['templates','songs','scripture','media'] as ResourceTab[]).map(tab=><button key={tab} type="button" role="tab" aria-selected={resourceTab===tab} onClick={()=>{setResourceTab(tab);if(tab==='scripture')setSermonPassage(false)}}><span aria-hidden="true">{{templates:'¶',songs:'♫',scripture:'§',media:'▧'}[tab]}</span>{{templates:t("Sermon"),songs:t("Songs"),scripture:t("Scripture"),media:t("Media")}[tab]}</button>)}
            <div className="heritage-add-utilities"><button type="button" disabled={!draft} onClick={()=>add('blank')}>{t("□ Blank slide")}</button><button type="button" disabled={!draft} onClick={()=>add('group')}>{t("≡ Section divider")}</button></div>
          </nav>
          <div className="heritage-add-content" role="tabpanel" aria-label={{templates:t("Sermon slides"),songs:t("Song library"),scripture:sermonPassage?t("Sermon passage"):t("Scripture reading"),media:t("Media and reusable slides")}[resourceTab]}>
            <h3>{{templates:t("Build your sermon"),songs:t("Song library"),scripture:sermonPassage?t("Sermon passage"):t("Scripture reading"),media:t("Media & reusable slides")}[resourceTab]}</h3>
            <p className="heritage-add-description">{{templates:t("Choose a starting point, then edit the slide on the canvas."),songs:t("Search in either language. Select a song to see its first section."),scripture:sermonPassage?t("The current sermon heading stays above your passage."):t("Add a title, verse pages and a blank as one reading section."),media:t("Use a saved slide, or add a picture or video.")}[resourceTab]}</p>
            {resourceTab==='templates'&&<>
              <div className="heritage-add-template-grid">{SERMON_TEMPLATES.map(value=><button key={value.id} type="button" disabled={!draft} onClick={()=>{if(value.id==='passage'){setResourceTab('scripture');setSermonPassage(true)}else addTemplate(value.id)}}><PalettePresetPreview type={value.id}/><strong>{t(value.label)}</strong><small>{t(value.hint)}</small></button>)}</div>
              {!sermonSyncId&&<details className="heritage-add-prepared"><summary>{t("Or add a prepared sermon")}</summary><label>{t("Saved sermon · newest first")}<select aria-label={t("Prepared sermon")} value={sermonChoice} onChange={event=>setSermonChoice(event.target.value)}><option value="">{t("Choose a sermon…")}</option>{sermonLibrary.map(sermon=><option key={sermon.syncId} value={sermon.syncId}>{sermon.serviceDate} · {sermon.title}</option>)}</select></label><button className="heritage-add-primary" type="button" disabled={!draft||!sermonChoice||busy} onClick={addWholeSermon}>{t("Add whole sermon")}</button><small>{t("Copies all saved slides, media and notes into a new sermon section.")}</small><div><a href="/admin/prepare-sermon" target="_blank" rel="noopener noreferrer">{t("Prepare a sermon ↗")}</a><button type="button" onClick={loadLibraries} disabled={busy}>{t("Refresh sermons")}</button></div></details>}
            </>}
            {resourceTab==='songs'&&<div className="heritage-add-songs">
              <label>{t("Find a song")}<input type="search" value={songQuery} onChange={event=>setSongQuery(event.target.value)} placeholder={t("English or Russian title…")}/></label>
              <div className="heritage-add-language" role="group" aria-label={t("Song language filter")}>{[['all',t("All")],['ru','Русский'],['en',t("English")]].map(([id,label])=><button type="button" key={id} aria-pressed={songLanguage===id} onClick={()=>setSongLanguage(id)}>{label}</button>)}</div>
              <div className="heritage-add-song-list" role="group" aria-label={t("Community songs")}>
                {songLibrary.filter(song=>`${song.title} ${song.russianTitle}`.toLocaleLowerCase().includes(songQuery.trim().toLocaleLowerCase()) && (songLanguage==='all'||song.previewSections?.some(section=>section.language===songLanguage))).map(song=><button key={song.syncId} ref={createdSongId===song.syncId ? createdSongRef : undefined} type="button" aria-pressed={songChoice===song.syncId} onClick={()=>setSongChoice(song.syncId)}><span><strong>{song.title}</strong>{song.russianTitle&&song.russianTitle!==song.title&&<small>{song.russianTitle}</small>}</span><span className="heritage-add-language-badges">{[...new Set(song.previewSections?.map(section=>section.language))].map(language=><small key={language}>{language.toUpperCase()}</small>)}</span></button>)}
                {!songLibrary.some(song=>`${song.title} ${song.russianTitle}`.toLocaleLowerCase().includes(songQuery.trim().toLocaleLowerCase()) && (songLanguage==='all'||song.previewSections?.some(section=>section.language===songLanguage)))&&<p>{t('No matching songs. Create one below, or try another search.')}</p>}
                {SongCreator ? <SongCreator query={songQuery} onCreated={songCreated}/> : <PlannerSongFrame query={songQuery} onCreated={songCreated}/>}
              </div>
              {songCreationNotice && <p role="status">{t(songCreationNotice)}</p>}
              <button className="heritage-add-refresh" type="button" onClick={loadLibraries} disabled={busy}>{t("Refresh library")}</button>
            </div>}
            {resourceTab==='media'&&<div className="heritage-add-media">
              <button className="heritage-add-blank" type="button" disabled={!draft||busy} onClick={()=>add('blank')}><span aria-hidden="true">□</span><strong>{t("Blank screen")}</strong><small>{t("Stage keeps the next-slide cue")}</small></button>
              {reusableSlides.map(template=><div className="heritage-add-reusable" key={template.id}><button type="button" disabled={!draft} onClick={()=>addReusable(template)}>{template.title}</button>{template.autoStart && <small>{t("Starts every new service")}</small>}<button type="button" aria-label={t('Remove {title} from Media', { title: template.title })} onClick={()=>removeReusable(template.id)}>{t("Remove from Media")}</button></div>)}
              {selected && ['picture','blank','notice','sermon'].includes(selected.kind) && <details><summary>{t("Save selected slide in Media")}</summary><label>{t("Slide name")}<input value={templateName} placeholder={selected.title} onChange={event=>setTemplateName(event.target.value)} /></label><label><input type="checkbox" checked={templateAutoStart} onChange={event=>setTemplateAutoStart(event.target.checked)} />{t("Add at the beginning of every new service")}</label><button type="button" onClick={saveReusable}>{t("Save reusable slide")}</button></details>}
              <div><strong>{t("Pictures and videos")}</strong><small>{t("Media stays private inside this service until its exact revision is opened in SyncShow.")}</small></div>
              <button className="btn btn--style-primary" type="button" disabled={!draft || uploadingPicture} onClick={() => choosePicture('new')}>{uploadingPicture ? t("Uploading…") : t("Add picture")}</button>
              <button className="btn btn--style-primary" type="button" disabled={!draft || uploadingVideo} onClick={() => { if (videoInput.current) { videoInput.current.value = ''; videoInput.current.click() } }}>{uploadingVideo ? t("Uploading…") : t("Add video")}</button>
              {selected?.kind === 'picture' ? CHANNEL_IDS.map(channelId => <button key={channelId} type="button" disabled={uploadingPicture} onClick={() => choosePicture(channelId)}>{t("Replace")} {t(draft?.channels[channelId]?.label || channelId)}</button>) : null}

            </div>}
            {resourceTab==='scripture'&&<div className="heritage-add-scripture">
              {!sermonPassage && <label>{t("Reading title template")}<select aria-label={t("Reading title template")} value={readingTemplate} onChange={event=>setReadingTemplateChoice(event.target.value)}><option value="centered">{t("Centered reading title")}</option><option value="pre-sermon">{t("Pre-sermon · passage and service topic")}</option></select></label>}
              <label><span>{t("English screen translation")}</span><select aria-label={t("English screen translation")} value={bibleEnglish} onChange={event => setBibleEnglish(event.target.value)}>{bibleTranslations.map(translation => <option key={translation.id} value={translation.id}>{bibleTranslationOptionLabel(translation)}</option>)}</select></label>
              <label><span>{t("Russian / stage screen translation")}</span><select aria-label={t("Russian / stage screen translation")} value={bibleRussian} onChange={event => setBibleRussian(event.target.value)}>{bibleTranslations.map(translation => <option key={translation.id} value={translation.id}>{bibleTranslationOptionLabel(translation)}</option>)}</select></label>
              <OnlineBibleNotice translations={bibleTranslations} />
              <BibleSourceNotice translationIds={[bibleEnglish,bibleRussian]} />
              <PassageReferenceInput key={referenceKey} books={bibleBooks} singleChapter allowVerseList onValidityChange={setReferenceValid} onResolve={passage => { setBibleBookId(passage.bookId); setBibleChapter(passage.startChapter); setBibleStartVerse(passage.startVerse); setBibleEndVerse(passage.endVerse); setBibleVerseNumbers(passage.verseNumbers) }} />
              <details className="heritage-passage-manual"><summary>{t("Choose book and verses")}</summary><div>
              <label><span>{t("Book")}</span><select ref={bibleBookInput} value={bibleBookId} onChange={event => { setReferenceKey(key => key + 1); setReferenceValid(true); setBibleVerseNumbers(undefined); setBibleBookId(event.target.value); const chapters = bibleBooks.find(book => book.id === event.target.value)?.chapters || 1; setBibleChapter(current => Math.min(current, chapters)) }}>{bibleBooks.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>
              <label><span>{t("Chapter")}</span><input ref={bibleChapterInput} type="number" min={1} max={bibleBooks.find(book => book.id === bibleBookId)?.chapters || 200} value={bibleChapter} onChange={event => { setReferenceKey(key => key + 1); setReferenceValid(true); setBibleVerseNumbers(undefined); setBibleChapter(Number(event.target.value)) } } /></label>
              <label><span>{t("From")}</span><input ref={bibleStartVerseInput} type="number" min={1} max={999} value={bibleStartVerse} onChange={event => { setReferenceKey(key => key + 1); setReferenceValid(true); setBibleVerseNumbers(undefined); setBibleStartVerse(Number(event.target.value)) } } /></label>
              <label><span>{t("To")}</span><input ref={bibleEndVerseInput} type="number" min={1} max={999} value={bibleEndVerse} onChange={event => { setReferenceKey(key => key + 1); setReferenceValid(true); setBibleVerseNumbers(undefined); setBibleEndVerse(Number(event.target.value)) } } /></label>
              </div></details>
              <button className="heritage-add-primary" type="button" disabled={!draft||busy||!bibleBookId||!referenceValid} onClick={addBiblePassage}>{busy?t("Fetching passage…"):sermonPassage?t("Add sermon passage →"):t("Add reading →")}</button>
            </div>}
          </div>
          {resourceTab==='songs'&&<aside className="heritage-add-preview" aria-label={t("Selected song")}>
            <h3>{t("First section")}</h3>
            <div role="group" className="heritage-add-output" aria-label={t("Song preview output")}>{CHANNEL_IDS.map(id=><button key={id} type="button" aria-pressed={paletteChannel===id} onClick={()=>setPaletteChannel(id)}>{id==='media'?t('Stage'):t(draft?.channels[id]?.label||id)}</button>)}</div>
            <PalettePresetPreview type="song" channel={paletteChannel} songSections={songLibrary.find(song=>song.syncId===songChoice)?.previewSections}/>
            <h4>{songLibrary.find(song=>song.syncId===songChoice)?.title || t("Choose a song")}</h4>
            <p>{t("Uses the song’s saved language and arrangement, including repeats.")}</p>
            <footer><button className="heritage-add-primary" type="button" disabled={!draft||busy||!songChoice} onClick={addLibrarySong}>{busy?t("Adding…"):t("Add song to service →")}</button><small>{t("Adds the whole song and its ending blank.")}</small></footer>
          </aside>}

          </div>
        </section>
          <input ref={pictureInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => pictureChosen(event.target.files?.[0])} />
          <input ref={videoInput} type="file" accept="video/mp4,video/webm,.mp4,.webm" hidden onChange={event => videoChosen(event.target.files?.[0])} />
          {moveDialog && draft ? <MoveSlidesDialog count={dialogSlides.length} maximum={slideList.rows.filter(row => row.cue).length - dialogSlides.length + 1}
            initial={dialogSlides[0]?.number || 1} onCancel={() => setMoveDialog(null)}
            onMove={number => { applySelection(changePlannerSelection(draft, moveDialog, 'move', number)); setMoveDialog(null) }} /> : null}
          {editionChange && <ScriptureEditionDialog edition={editionChange.translationId}
            output={editionChange.channel === 'english' ? t("English") : t("Russian / stage")} onCancel={()=>setEditionChange(null)}
            onChange={()=>{ const choice=editionChange; setEditionChange(null); void changeScriptureTranslation(choice.channel,choice.translationId,true) }} />}
          {deleteDialog && draft ? <DeleteSlidesDialog count={selectedPlannerSlides(slideList.rows, deleteDialog).length}
            sections={deleteDialog.some(id => slideList.rows.find(row => row.id === id)?.kind === 'group')}
            onCancel={() => setDeleteDialog(null)} onDelete={() => { runSelection(deleteDialog, 'delete'); setDeleteDialog(null) }} /> : null}
      </div>
    </section></PresentationAccessibility>
  )
}
