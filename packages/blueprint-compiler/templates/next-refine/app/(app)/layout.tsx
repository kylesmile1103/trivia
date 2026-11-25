import type { ReactNode } from 'react'

import { Layout } from '@/components/refine-ui/layout/layout'
import { Toaster } from '@/components/refine-ui/notification/toaster'

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Layout>
      {children}
      <Toaster />
    </Layout>
  )
}
