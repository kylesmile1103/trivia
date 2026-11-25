import { Refine } from '@refinedev/core'
import routerProvider from '@refinedev/react-router'
import { BrowserRouter, Outlet, Route, Routes } from 'react-router'

import { ErrorComponent } from '@/components/refine-ui/layout/error-component'
import { Layout } from '@/components/refine-ui/layout/layout'
import { dataProvider } from '@/providers/data-provider'

export default function App() {
  return (
    <BrowserRouter>
      <Refine dataProvider={dataProvider} routerProvider={routerProvider} resources={[]} options={{ disableTelemetry: true }}>
        <Routes>
          <Route element={<Layout><Outlet /></Layout>}>
            <Route index element={<h1>Blueprint fixture</h1>} />
            <Route path="*" element={<ErrorComponent />} />
          </Route>
        </Routes>
      </Refine>
    </BrowserRouter>
  )
}
