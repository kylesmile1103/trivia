// Inline styles: the inferencer lives in node_modules, which the app's Tailwind doesn't scan.

import type { CSSProperties } from 'react'

const font = 'ui-sans-serif, system-ui, sans-serif'
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace'

export const styles = {
  banner: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    margin: '0 0 16px',
    padding: '8px 12px',
    border: '1px dashed #8b5cf6',
    borderRadius: 8,
    background: '#f5f3ff',
    color: '#2e1065',
    font: `13px/1.4 ${font}`,
  },
  tag: { fontWeight: 600 },
  spacer: { flex: 1 },
  button: {
    padding: '4px 10px',
    border: '1px solid #c4b5fd',
    borderRadius: 6,
    background: '#ffffff',
    color: '#2e1065',
    font: `13px ${font}`,
    cursor: 'pointer',
  },
  primary: { padding: '4px 10px', border: '1px solid #6d28d9', borderRadius: 6, background: '#6d28d9', color: '#ffffff', font: `13px ${font}`, cursor: 'pointer' },
  input: { minWidth: 260, padding: '3px 6px', border: '1px solid #c4b5fd', borderRadius: 6, font: `12px ${mono}` },
  note: { margin: 0, color: '#4c1d95', font: `13px/1.4 ${font}` },
  error: { padding: '8px 12px', border: '1px solid #fca5a5', borderRadius: 8, background: '#fef2f2', color: '#7f1d1d', font: `13px/1.4 ${font}`, whiteSpace: 'pre-wrap' },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    width: 'min(720px, 100vw)',
    borderLeft: '1px solid #c4b5fd',
    background: '#ffffff',
    color: '#111827',
    boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.12)',
    font: `13px ${font}`,
  },
  drawerHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #ede9fe' },
  code: { flex: 1, margin: 0, padding: 12, overflow: 'auto', background: '#faf5ff', font: `12px/1.5 ${mono}`, whiteSpace: 'pre' },
} satisfies Record<string, CSSProperties>
