# Report for vitejs/vite (not filed yet)

**Title:** A module transformed while a newer update for it is sent imports itself at the newer
`?t=`, so the browser runs the older source last (React components keep the older render)

**Environment**
- `vite` 8.3.3, `@vitejs/plugin-react` 6.1.2, Chromium (Playwright 1.63), Linux and macOS
- Any component module: plugin-react's refresh footer imports the module itself
  (`import * as __vite_react_currentExports from "/src/pages/Dashboard.tsx"`).

**What happens**

Two writes to one component file, a few tens of milliseconds apart (in our case an edit and its
undo, each written by renaming a temporary file over the target):

1. Write 1 is heard and its update is sent with `t=T1`. The browser asks for
   `/src/pages/Dashboard.tsx?t=T1`, and Vite starts transforming it from write 1's text.
2. Write 2 lands and is heard while that transform is still running. `handleHMRUpdate` runs
   `updateModules`, which sets the module's `lastHMRTimestamp` to `T2` and sends the update
   with `t=T2`.
3. The transform of step 1 reaches import analysis after that, so it reads `T2`: the self-import
   in the `T1` module is rewritten to `/src/pages/Dashboard.tsx?t=T2`
   (`vite/dist/node/chunks/node.js` 20227, `if (importedMod.lastHMRTimestamp > 0)`).
4. The browser imports the `T1` module, which first imports its dependency `?t=T2`, a fresh
   transform of write 2's text. That runs first, then the `T1` body (write 1's source) runs, and
   its `$RefreshReg$` registration is the last one. React Refresh renders write 1.
5. The update for `T2` arrives. Its module is already in the browser's module map, so nothing
   runs again. The page stays on write 1 although the file and every later request have write 2.

From the trace (monotonic ms): the `?t=T1` request started at 210650.2 and took 59.7 ms, and write 2
landed between 210667.9 and 210694.4. The `?t=T2` request had `Referer: …/Dashboard.tsx?t=T1`
and finished at 210867.5, and both "hot updated" logs came after it (210868.3, 210898.9). The DOM
kept write 1.

**Reproduction**

A dev server with a plugin that holds one module's transform open (standing in for a busy
server), and a module that imports itself the way plugin-react's footer does:

```ts
// src/Hot.tsx
import * as self from "/src/Hot.tsx"
export function Hot() { return <p title="b">hot</p> }
export const own = self
if (import.meta.hot) import.meta.hot.accept()
```

1. Request `/src/Hot.tsx` and hold its transform open.
2. Write the file again and emit `change` on `server.watcher`; let the update go out.
3. Release the transform. The response contains `import * as self from "/src/Hot.tsx?t=<T2>"`,
   where T2 is the second update's timestamp. Expected: no `?t`, or the request's own.

Trivia's test is `packages/vite-plugin-ast-locator/test/hmr-order.test.ts`. Without the
workaround below it fails with `Expected: "/src/Hot.tsx"`, `Received: "/src/Hot.tsx?t=…"`.

**Expected**

A module's import of itself should not carry a timestamp newer than the one it was requested
with. Alternatively, a transform still running when its module receives an HMR update could be
redone, or have its result discarded: the `lastInvalidationTimestamp` check in
`transformRequest` already does this for caching, but not for the timestamps import analysis
writes.

**Workaround in Trivia**

The plugin's `hotUpdate` hook (`order: 'pre'`) waits, at most 5 s, until the in-flight
transforms of the update's modules have finished. Vite awaits the hook before `updateModules`
sets the new timestamp (`handleHMRUpdate`), so the running transform reads the old one. It
finds those transforms through `DevEnvironment._pendingRequests`, which is not public API
(`packages/vite-plugin-ast-locator/src/hmr-order.ts`).
