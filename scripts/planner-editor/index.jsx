import React from 'react'
import {createRoot} from 'react-dom/client'
import PlanServiceClient from '@community/components/PlanServiceClient'
import styles from '@community/app/(payload)/custom.scss?raw'
const style=document.createElement('style')
style.textContent=`:root{color-scheme:dark;font:14px system-ui;--theme-text:#eef0f3;--theme-elevation-0:#1c1e21;--theme-elevation-50:#222429;--theme-elevation-100:#2b2e34;--theme-elevation-150:#3e424a;--theme-elevation-200:#484d55;--theme-elevation-250:#535962;--theme-elevation-300:#636a75;--theme-elevation-350:#737c89;--theme-elevation-400:#8d96a3;--theme-elevation-500:#a7afbc;--theme-elevation-600:#bcc3ce;--theme-elevation-700:#d0d5df;--theme-elevation-800:#e0e5ef;--theme-elevation-900:#f1f4fa;--theme-elevation-1000:#fff;--theme-success-100:#1b3026;--theme-success-500:#7abf98;--theme-success-700:#a9dfbf;--theme-success-800:#c8ebd6;--theme-error-100:#381d22;--theme-error-500:#ffb2bd}body{margin:0;background:var(--theme-elevation-0);color:var(--theme-text)}*{box-sizing:border-box}button,input,select,textarea{font:inherit;color:inherit}${styles.replace(/^\s*\/\/.*$/gm,'')}`
document.head.append(style)
const activeServiceId=new URL(location.href).searchParams.get('service')
createRoot(document.getElementById('root')).render(<div className="heritage-planner-frame"><PlanServiceClient activeServiceId={activeServiceId} /></div>)
