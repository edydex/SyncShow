import React, {useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {parseSongLyrics} from '@community/../packages/song-text/index.js'
import {useWorkspaceText} from '@community/components/useWorkspaceText'

function Lyrics({value, onChange, label}) {
  const input = useRef(null)
  useLayoutEffect(() => {
    const field = input.current
    const resize = () => {if (!field.clientWidth) return; field.style.height = 'auto'; field.style.height = `${field.scrollHeight + 2}px`}
    resize()
    const observer = new ResizeObserver(resize); observer.observe(field.parentElement)
    return () => observer.disconnect()
  }, [value])
  return <label>{label}<textarea ref={input} rows={7} value={value} onChange={event => onChange(event.target.value)} /></label>
}

function SongDialog({children, onClose}) {
  const dialog = useRef(null)
  useLayoutEffect(() => {dialog.current.showModal()}, [])
  return createPortal(<dialog ref={dialog} className="local-song-editor" aria-labelledby="localSongTitle" onCancel={event => {event.preventDefault(); onClose()}}>{children}</dialog>, document.body)
}

export default function LocalSongCreator({query, onCreated}) {
  const t = useWorkspaceText(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [englishTitle, setEnglishTitle] = useState(''), [russianTitle, setRussianTitle] = useState('')
  const [english, setEnglish] = useState(''), [russian, setRussian] = useState(''), [authors, setAuthors] = useState('')
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/syncshow-local/songs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
        english: {title: englishTitle.trim(), sections: parseSongLyrics(english, {language: 'en'})},
        russian: {title: russianTitle.trim(), sections: parseSongLyrics(russian, {language: 'ru'})},
        authors: authors.split(';').map(value => value.trim()).filter(Boolean)
      })})
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save song.')
      setOpen(false); await onCreated(result.item.syncId)
    } catch (caught) {setError(caught.message)} finally {setBusy(false)}
  }
  return <div className="heritage-add-create-song">
    <button type="button" onClick={() => {setEnglishTitle(/[а-яё]/i.test(query) ? '' : query); setRussianTitle(/[а-яё]/i.test(query) ? query : ''); setOpen(true)}}><span aria-hidden="true">＋</span><span><strong>{t('Create a song')}</strong><small>{t('Save on this computer, then add to the presentation.')}</small></span></button>
    {open && <SongDialog onClose={() => !busy && setOpen(false)}>
      <form onSubmit={save}>
        <h3 id="localSongTitle">{t('Create a song')}</h3><p>{t('Saved on this computer. Blank lines separate slides.')}</p>
        <div className="local-song-columns">
          <label>{t('Russian title')}<input maxLength={200} value={russianTitle} onChange={event => setRussianTitle(event.target.value)}/></label>
          <label>{t('English title')}<input autoFocus maxLength={200} value={englishTitle} onChange={event => setEnglishTitle(event.target.value)}/></label>
          <Lyrics label={t('Russian lyrics')} value={russian} onChange={setRussian}/>
          <Lyrics label={t('English lyrics')} value={english} onChange={setEnglish}/>
        </div>
        <label>{t('Authors')}<input value={authors} onChange={event => setAuthors(event.target.value)} placeholder={t('Separate authors with a semicolon.')}/></label>
        {error && <p role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={() => setOpen(false)}>{t('Cancel')}</button><button type="submit" disabled={busy || (!englishTitle.trim() && !russianTitle.trim()) || (!english.trim() && !russian.trim())}>{busy ? t('Saving…') : t('Save song')}</button></footer>
      </form>
    </SongDialog>}
  </div>
}
