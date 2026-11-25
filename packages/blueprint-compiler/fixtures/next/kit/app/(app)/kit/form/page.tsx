import { CustomerFormView } from "./view"

export default function KitForm() {
  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>New customer</h1>
      <CustomerFormView />
    </main>
  )
}
