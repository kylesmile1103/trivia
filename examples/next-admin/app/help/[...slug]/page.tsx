export default async function HelpPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params
  return <main className="p-8"><h1>Help</h1><p>{slug.join(' / ')}</p></main>
}
