import Link from 'next/link'

import { EditDemo } from '@/components/edit-demo'

export default function Home() {
  return (
    <main className="mx-auto grid max-w-2xl gap-6 p-10">
      <h1 className="text-3xl font-semibold">Next.js back office</h1>
      <EditDemo />
      <Link className="underline" href="/customers">Customers</Link>
    </main>
  )
}
