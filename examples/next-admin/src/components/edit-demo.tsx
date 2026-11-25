'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'

export function EditDemo() {
  const [count, setCount] = useState(0)
  return (
    <section id="edit-demo" className="grid justify-items-start gap-3 rounded-lg border p-4">
      <h2 className="font-medium">Client tools</h2>
      <Button onClick={() => setCount(count + 1)}>Count {count}</Button>
      <p id="demo-note">Client component</p>
    </section>
  )
}
