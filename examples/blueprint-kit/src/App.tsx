import { Refine } from "@refinedev/core"
import routerProvider from "@refinedev/react-router"
import { BrowserRouter, Outlet, Route, Routes } from "react-router"

import { TooltipProvider } from "@/components/ui/tooltip"
import { dataProvider } from "@/providers/data-provider"
import { Layout } from "@/components/refine-ui/layout/layout"

export default function App() {
  return (
    <BrowserRouter>
      <Refine dataProvider={dataProvider} routerProvider={routerProvider} resources={[]} options={{ disableTelemetry: true }}>
        <style id="trivia-theme" />
        <TooltipProvider>
          <Routes>
            <Route element={<Layout><Outlet /></Layout>}>
              <Route index element={<p>Welcome</p>} />
              <Route path="*" element={<p>Page not found</p>} />
            </Route>
          </Routes>
        </TooltipProvider>
      </Refine>
    </BrowserRouter>
  )
}
