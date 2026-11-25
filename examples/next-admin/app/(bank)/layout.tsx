import { Suspense, type ReactNode } from 'react'

import { BankProviders } from '@/providers/bank-providers'

export default function BankLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="p-6">Loading bank pages…</p>}>
      <BankProviders>{children}</BankProviders>
    </Suspense>
  )
}
