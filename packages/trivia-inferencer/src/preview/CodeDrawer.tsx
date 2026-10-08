// The generated code, to read before ejecting it (and copy, for those who prefer to paste).

import { useState } from 'react'

import { styles } from './styles'

export function CodeDrawer({ code, file, onClose }: { code: string; file: string; onClose(): void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <aside role="dialog" aria-label={`Generated code for ${file}`} style={styles.drawer}>
      <div style={styles.drawerHead}>
        <code style={{ flex: 1 }}>{file}</code>
        <button type="button" style={styles.button} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" style={styles.button} onClick={onClose}>
          Close
        </button>
      </div>
      <pre style={styles.code}>
        <code>{code}</code>
      </pre>
    </aside>
  )
}
