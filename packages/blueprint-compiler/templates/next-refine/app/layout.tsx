import type { Metadata } from 'next'
import { connection } from 'next/server'
import type { ReactNode } from 'react'

import { Providers } from './providers'

import '@/index.css'

export const metadata: Metadata = { title: 'Back office' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Refine's App Router binding reads the request's search parameters.
  await connection()
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
