const remap = require('@jridgewell/remapping')
const { annotate } = require('@trivia/engine')
const { annotateModule, isSyntaxError } = require('@trivia/dev-service/stamp')
const { stampFile } = require('../dist/paths.js')

module.exports = function triviaLoader(source, inputMap) {
  const callback = this.async()
  const file = stampFile(this.resourcePath, this.getOptions().root ?? this.rootContext)
  if (file === null) return callback(null, source, inputMap)
  try {
    const output = annotateModule(source, file, this.resourcePath, annotate)
    if (!output) return callback(null, source, inputMap)
    const map = JSON.parse(output.map.toString())
    callback(null, output.code, inputMap ? remap([map, inputMap], () => null) : map)
  } catch (error) {
    if (isSyntaxError(error)) return callback(null, source, inputMap)
    callback(error)
  }
}
