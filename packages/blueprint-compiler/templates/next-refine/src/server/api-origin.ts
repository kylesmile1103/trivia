export function apiOrigin(): string | undefined {
  const value = process.env.services__api__http__0 ?? process.env.services__api__https__0 ??
    process.env.API_HTTP ?? process.env.API_HTTPS ?? process.env.TRIVIA_API_ORIGIN
  if (!value) return undefined
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('The API address must be an HTTP origin.')
  }
  return url.origin
}
