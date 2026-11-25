import { Refine } from "@refinedev/core"
import routerProvider from "@refinedev/react-router"
import { BrowserRouter, Outlet, Route, Routes } from "react-router"

import { dataProvider } from "@/providers/data-provider"
import { Layout } from "@/components/refine-ui/layout/layout"

export default function App() {
  return (
    <BrowserRouter>
      <Refine routerProvider={routerProvider} resources={[]} dataProvider={dataProvider} options={{ disableTelemetry: true }}>
        <style id="trivia-theme" />
        <Routes>
          <Route element={<Layout><Outlet /></Layout>}>
            <Route index element={<p>Welcome</p>} />
            <Route path="*" element={<p>Page not found</p>} />
          </Route>
        </Routes>
      </Refine>
    </BrowserRouter>
  )
}
