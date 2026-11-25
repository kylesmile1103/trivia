'use client'

export default function RouteError({ reset }: { reset: () => void }) {
  return (
    <main role="alert" className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Could not load this page</h1>
      <button type="button" onClick={reset} className="underline">Try again</button>
    </main>
  )
}
