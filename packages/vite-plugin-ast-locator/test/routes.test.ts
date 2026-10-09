// Route discovery over small apps on disk, with the real engine: React Router's JSX and object
// routes (descendant <Routes>/useRoutes joined onto their splat parent), and TanStack Router's
// file-based and code-based routes. fileResolver maps `@/` to src/, as the apps' bundler would.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { type EngineBinding, loadEngine, unwrap } from '../src/engine.js'
import { type RouteEntry, discoverRoutes, fileResolver } from '../src/routes/index.js'

let engine: EngineBinding
let root: string

beforeAll(async () => {
  engine = await loadEngine()
})

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-routes-'))
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}

function routes(dir: string): Promise<RouteEntry[]> {
  return discoverRoutes({
    root: dir,
    outline: (file) => unwrap(engine.outline(dir, file)),
    inspect: (locator) => unwrap(engine.inspect(dir, locator)),
    describeValues: (file) => unwrap(engine.describeValues(dir, file)),
    resolve: fileResolver(dir),
  })
}

/** The fields a reader checks first: URL, page component, its module. */
const brief = (list: RouteEntry[]) => list.map((r) => [r.path, r.component, r.file])

const component = (name: string) => `export function ${name}() {\n  return <div>${name}</div>;\n}\n`

describe('React Router JSX routes', () => {
  const app = {
    'src/App.tsx': `import { BrowserRouter, Outlet, Route, Routes } from "react-router";
import { Layout } from "@/components/layout";
import { CustomerList } from "@/pages/customers/list";
import { CustomerEdit } from "./pages/customers/edit";
import Settings from "./pages/settings";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout><Outlet /></Layout>}>
          <Route index element={<Home />} />
          <Route path="/customers" element={<CustomerList />} />
          <Route path="/customers/edit/:id" element={<CustomerEdit />} />
          <Route path="settings/*" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function Home() {
  return <h1>Home</h1>;
}

function NotFound() {
  return <p>Not found</p>;
}
`,
    'src/components/layout.tsx': component('Layout'),
    'src/pages/customers/list.tsx': component('CustomerList'),
    'src/pages/customers/edit.tsx': component('CustomerEdit'),
    'src/pages/settings.tsx': `import { Route, Routes } from "react-router";

export default function Settings() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path="profile" element={<Profile />} />
    </Routes>
  );
}

function Overview() {
  return <h2>Overview</h2>;
}

function Profile() {
  return <h2>Profile</h2>;
}
`,
  }

  it('lists every page with its component and module, the descendant <Routes> joined on', async () => {
    const found = await routes(project(app))
    expect(brief(found)).toEqual([
      ['/', 'Home', 'src/App.tsx'],
      ['/customers', 'CustomerList', 'src/pages/customers/list.tsx'],
      ['/customers/edit/:id', 'CustomerEdit', 'src/pages/customers/edit.tsx'],
      ['/settings', 'Overview', 'src/pages/settings.tsx'],
      ['/settings/profile', 'Profile', 'src/pages/settings.tsx'],
      ['/*', 'NotFound', 'src/App.tsx'],
    ])
    const edit = found.find((r) => r.path === '/customers/edit/:id')!
    expect(edit).toMatchObject({ params: ['id'], index: false, catchAll: false, router: 'react-router', declared: { file: 'src/App.tsx', line: 14 } })
    expect(edit.locator).toMatch(/^src\/App\.tsx#App#[\d.]+$/)
    expect(found[0]).toMatchObject({ index: true, params: [] })
    expect(found.at(-1)).toMatchObject({ catchAll: true, params: ['*'] })
    expect(found.find((r) => r.path === '/settings/profile')!.declared.file).toBe('src/pages/settings.tsx')
  })

  it('finds nothing in an app without a router', async () => {
    expect(await routes(project({ 'src/App.tsx': component('App') }))).toEqual([])
  })
})

describe('React Router route objects', () => {
  it('reads createBrowserRouter, Component and lazy routes, and a useRoutes page under a splat', async () => {
    const found = await routes(
      project({
        'src/router.tsx': `import { createBrowserRouter } from "react-router";
import { lazy } from "react";
import { Root } from "./root";
import { Settings } from "./pages/settings";

const Reports = lazy(() => import("./pages/reports"));

const routes = [
  {
    path: "/",
    element: <Root />,
    children: [
      { index: true, element: <Home /> },
      { path: "settings/*", Component: Settings },
      { path: "reports/:year", element: <Reports /> },
      { path: "archive", lazy: () => import("./pages/archive") },
    ],
  },
];

export const router = createBrowserRouter(routes);

function Home() {
  return <h1>Home</h1>;
}
`,
        'src/root.tsx': component('Root'),
        'src/pages/reports.tsx': 'export default function Reports() {\n  return <div />;\n}\n',
        'src/pages/archive.tsx': 'export function Component() {\n  return <div />;\n}\n',
        'src/pages/settings.tsx': `import { useRoutes } from "react-router";

export function Settings() {
  return useRoutes([
    { index: true, element: <General /> },
    { path: "billing", element: <Billing /> },
  ]);
}

function General() {
  return <h2>General</h2>;
}

function Billing() {
  return <h2>Billing</h2>;
}
`,
      }),
    )
    expect(brief(found)).toEqual([
      ['/', 'Home', 'src/router.tsx'],
      ['/settings', 'General', 'src/pages/settings.tsx'],
      ['/settings/billing', 'Billing', 'src/pages/settings.tsx'],
      ['/reports/:year', 'Reports', 'src/pages/reports.tsx'],
      ['/archive', null, 'src/pages/archive.tsx'],
    ])
    expect(found.every((r) => r.router === 'react-router' && r.locator === null)).toBe(true)
  })
})

describe('TanStack Router', () => {
  const fileRoute = (id: string, name: string) =>
    `import { createFileRoute } from "@tanstack/react-router";\n\nexport const Route = createFileRoute("${id}")({\n  component: ${name},\n});\n\n${component(name).replace('export ', '')}`

  it('reads file-based routes: pathless layouts and the layout beside its index add no page', async () => {
    const found = await routes(
      project({
        'src/routes/__root.tsx': 'import { createRootRoute } from "@tanstack/react-router";\n\nexport const Route = createRootRoute({});\n',
        'src/routes/index.tsx': fileRoute('/', 'Home'),
        'src/routes/posts.tsx': fileRoute('/posts', 'PostsLayout'),
        'src/routes/posts.index.tsx': fileRoute('/posts/', 'PostsIndex'),
        'src/routes/posts.$postId.tsx': fileRoute('/posts/$postId', 'Post'),
        'src/routes/_auth.tsx': fileRoute('/_auth', 'AuthLayout'),
        'src/routes/_auth.dashboard.tsx': fileRoute('/_auth/dashboard', 'Dashboard'),
      }),
    )
    expect(brief(found)).toEqual([
      ['/', 'Home', 'src/routes/index.tsx'],
      ['/dashboard', 'Dashboard', 'src/routes/_auth.dashboard.tsx'],
      ['/posts', 'PostsIndex', 'src/routes/posts.index.tsx'],
      ['/posts/$postId', 'Post', 'src/routes/posts.$postId.tsx'],
    ])
    expect(found.find((r) => r.path === '/posts/$postId')).toMatchObject({ params: ['postId'], router: 'tanstack-router' })
  })

  it('reads code-based routes through getParentRoute', async () => {
    const found = await routes(
      project({
        'src/router.tsx': `import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { User } from "./user";

const rootRoute = createRootRoute({ component: Root });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const authRoute = createRoute({ getParentRoute: () => rootRoute, id: "_auth", component: AuthLayout });
const dashboardRoute = createRoute({ getParentRoute: () => authRoute, path: "dashboard", component: Dashboard });
const userRoute = createRoute({ getParentRoute: () => rootRoute, path: "users/$userId", component: User });

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, authRoute.addChildren([dashboardRoute]), userRoute]),
});

function Root() {
  return null;
}
function Home() {
  return null;
}
function AuthLayout() {
  return null;
}
function Dashboard() {
  return null;
}
`,
        'src/user.tsx': component('User'),
      }),
    )
    expect(brief(found)).toEqual([
      ['/', 'Home', 'src/router.tsx'],
      ['/dashboard', 'Dashboard', 'src/router.tsx'],
      ['/users/$userId', 'User', 'src/user.tsx'],
    ])
  })
})
