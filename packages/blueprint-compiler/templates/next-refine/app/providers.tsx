'use client'

import { Refine, type ResourceProps } from '@refinedev/core'
import routerProvider from '@refinedev/nextjs-router/app'
import type { ReactNode } from 'react'

import { useNotificationProvider } from '@/components/refine-ui/notification/use-notification-provider'
import { dataProvider } from '@/providers/data-provider'

const resources: ResourceProps[] = []

export function Providers({ children }: { children: ReactNode }) {
  return (
    <Refine
      dataProvider={dataProvider}
      routerProvider={routerProvider}
      resources={resources}
      notificationProvider={useNotificationProvider}
      options={{ disableTelemetry: true, syncWithLocation: true }}
    >
      <style id="trivia-theme" />
      {children}
    </Refine>
  )
}
