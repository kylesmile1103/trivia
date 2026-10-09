'use strict'
// Nx's default changelog renderer, with one change: commit types that share a changelog title
// share one section. Commit prefixes here name an area ("engine: …", "MCP: …"), and several
// spellings map to one area (MCP/mcp, Plugin/plugin), so nx.json gives them the same title.
// The default renderer would print one heading per type, so a title could appear twice.
const DefaultChangelogRenderer = require('nx/release/changelog-renderer').default

/** Maps each type to the first type declared with the same title (types keep their order). */
function canonicalTypes(types) {
  const firstByTitle = new Map()
  const canonical = {}
  for (const [type, config] of Object.entries(types)) {
    const title = config.changelog?.title ?? type
    if (!firstByTitle.has(title)) firstByTitle.set(title, type)
    canonical[type] = firstByTitle.get(title)
  }
  return canonical
}

class TriviaChangelogRenderer extends DefaultChangelogRenderer {
  groupChangesByType() {
    const canonical = canonicalTypes(this.conventionalCommitsConfig.types)
    const groups = {}
    for (const change of this.relevantChanges) {
      const type = canonical[change.type] ?? change.type
      ;(groups[type] ??= []).push(change)
    }
    return groups
  }
}

module.exports = TriviaChangelogRenderer
module.exports.default = TriviaChangelogRenderer
module.exports.canonicalTypes = canonicalTypes
