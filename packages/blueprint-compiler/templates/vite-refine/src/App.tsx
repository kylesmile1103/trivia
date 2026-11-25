import { Refine, type NotificationProvider } from "@refinedev/core"
import routerProvider from "@refinedev/react-router"
import { BrowserRouter, Outlet, Route, Routes } from "react-router"
import { Toaster, toast } from "sonner"

import { dataProvider } from "@/providers/data-provider"
import { Layout } from "@/components/refine-ui/layout/layout"

const notificationProvider: NotificationProvider = {
  open({ key, message, description, type }) {
    const notify = type === "progress" ? toast.loading : toast[type]
    notify(message, { id: key, description })
  },
  close: (key) => { toast.dismiss(key) },
}

export default function App() {
  return (
    <BrowserRouter>
      <Refine routerProvider={routerProvider} resources={[]} dataProvider={dataProvider} notificationProvider={notificationProvider} options={{ disableTelemetry: true }}>
        <style id="trivia-theme" />
        <Routes>
          <Route element={<Layout><Outlet /></Layout>}>
            <Route index element={<p>Welcome</p>} />
            <Route path="*" element={<p>Page not found</p>} />
          </Route>
        </Routes>
        <Toaster richColors />
      </Refine>
    </BrowserRouter>
  )
}
