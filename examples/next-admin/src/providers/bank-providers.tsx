'use client'

import { Refine } from '@refinedev/core'
import routerProvider from '@refinedev/nextjs-router'
import { ArrowLeftRightIcon, LandmarkIcon, UsersIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Layout } from '@/components/refine-ui/layout/layout'
import { Toaster } from '@/components/refine-ui/notification/toaster'
import { useNotificationProvider } from '@/components/refine-ui/notification/use-notification-provider'
import { dataProvider } from '@/providers/data-provider'

export function BankProviders({ children }: { children: ReactNode }) {
  return (
    <Refine
      dataProvider={dataProvider}
      routerProvider={routerProvider}
      notificationProvider={useNotificationProvider}
      resources={[
        { name: 'customers', list: '/customers', create: '/customers/create', edit: '/customers/edit/:id', meta: { icon: <UsersIcon /> } },
        { name: 'accounts', list: '/accounts', meta: { icon: <LandmarkIcon /> } },
        { name: 'transactions', list: '/transactions', show: '/transactions/show/:id', meta: { icon: <ArrowLeftRightIcon /> } },
      ]}
      options={{
        title: { text: 'Back office', icon: <LandmarkIcon /> },
        syncWithLocation: true,
        disableTelemetry: true,
      }}
    >
      <Layout>{children}</Layout>
      <Toaster />
    </Refine>
  )
}
