// @trivia/openapi-inferencer: a drop-in, contract-driven replacement for Refine's inferencer
// (docs/product.md, slice 6). Pages come from the OpenAPI contract through Trivia's dev server,
// run live in the app, and are ejected to disk with one click.

export { OpenApiCreateInferencer } from './components/OpenApiCreateInferencer'
export { OpenApiEditInferencer } from './components/OpenApiEditInferencer'
export { OpenApiListInferencer } from './components/OpenApiListInferencer'
export { OpenApiShowInferencer } from './components/OpenApiShowInferencer'
export { type EjectRequest, type EjectResult, type EjectStatus, ejectPayload, ejectToDisk, useEjectToDisk } from './hooks/useEjectToDisk'
export { type ResourceContract, previewRequest, projectPath, useResourceContract } from './hooks/useResourceContract'
export { API, TriviaApiError } from './api'
export type { InferredPage, OpenApiInferencerProps, PageKind, Plan } from './types'
