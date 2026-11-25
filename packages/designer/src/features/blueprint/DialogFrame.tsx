import { Dialog } from 'radix-ui'
import { useRef, type ReactNode } from 'react'

export function DialogFrame({ title, description, busy = false, onClose, children }: {
  title: string
  description: string
  busy?: boolean
  onClose(): void
  children: ReactNode
}) {
  const opener = useRef<HTMLElement | null>(null)
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-1/2 space-y-3 overflow-auto rounded-lg border bg-background p-4 text-sm text-foreground shadow-lg"
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) {
              event.preventDefault()
              opener.current.focus()
            }
          }}
        >
          <header className="space-y-1">
            <Dialog.Title className="text-base font-semibold [overflow-wrap:anywhere]">{title}</Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground">{description}</Dialog.Description>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
