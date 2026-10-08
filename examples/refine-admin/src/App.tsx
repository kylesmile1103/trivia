import { Refine } from "@refinedev/core";
import routerProvider, {
  DocumentTitleHandler,
  NavigateToResource,
  UnsavedChangesNotifier,
} from "@refinedev/react-router";
import { ArrowLeftRightIcon, LandmarkIcon, UsersIcon } from "lucide-react";
import { BrowserRouter, Outlet, Route, Routes } from "react-router";
import { OpenApiShowInferencer } from "@trivia/openapi-inferencer";

import { ErrorComponent } from "@/components/refine-ui/layout/error-component";
import { Layout } from "@/components/refine-ui/layout/layout";
import { Toaster } from "@/components/refine-ui/notification/toaster";
import { useNotificationProvider } from "@/components/refine-ui/notification/use-notification-provider";
import { AccountList } from "@/pages/accounts/list";
import { CustomerCreate } from "@/pages/customers/create";
import { CustomerEdit } from "@/pages/customers/edit";
import { CustomerList } from "@/pages/customers/list";
import { TransactionList } from "@/pages/transactions/list";
import { dataProvider } from "@/providers/data-provider";

export default function App() {
  return (
    <BrowserRouter>
      <Refine
        dataProvider={dataProvider}
        routerProvider={routerProvider}
        notificationProvider={useNotificationProvider}
        resources={[
          {
            name: "customers",
            list: "/customers",
            create: "/customers/create",
            edit: "/customers/edit/:id",
            meta: { icon: <UsersIcon /> },
          },
          {
            name: "accounts",
            list: "/accounts",
            meta: { icon: <LandmarkIcon /> },
          },
          {
            name: "transactions",
            list: "/transactions",
            show: "/transactions/show/:id",
            meta: { icon: <ArrowLeftRightIcon /> },
          },
        ]}
        options={{
          title: { text: "Back office", icon: <LandmarkIcon /> },
          syncWithLocation: true,
          warnWhenUnsavedChanges: true,
          disableTelemetry: true,
        }}
      >
        <Routes>
          <Route
            element={
              <Layout>
                <Outlet />
              </Layout>
            }
          >
            <Route index element={<NavigateToResource resource="customers" />} />
            <Route path="/customers" element={<CustomerList />} />
            <Route path="/customers/create" element={<CustomerCreate />} />
            <Route path="/customers/edit/:id" element={<CustomerEdit />} />
            <Route path="/accounts" element={<AccountList />} />
            <Route path="/transactions" element={<TransactionList />} />
            <Route path="/transactions/show/:id" element={<OpenApiShowInferencer />} />
            <Route path="*" element={<ErrorComponent />} />
          </Route>
        </Routes>
        <Toaster />
        <UnsavedChangesNotifier />
        <DocumentTitleHandler />
      </Refine>
    </BrowserRouter>
  );
}
