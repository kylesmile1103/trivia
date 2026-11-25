// @trivia/blueprint: blueprint documents and the one way they change (LLD-01).
export { BLUEPRINT_VERSION, EXPRESSION_META, SCHEMA_URL } from './types/common.js'
export { appSchema, navEntrySchema, type AppDoc, type NavEntry } from './types/app.js'
export {
  actionStepSchema, contractPageSchema, controlSchema, customPageSchema, nodeSchema, pageSchema, querySchema, stateSchema,
  CONTRACT_KINDS, PAGE_KINDS,
  type ActionStep, type BlueprintNode, type ContractOptions, type ContractPage, type Control, type CustomPage, type PageDoc,
  type PageKind, type Query, type StateEntry,
} from './types/page.js'
export {
  customOperationSchema, entityApiSchema, entitySchema, enumSchema, fieldSchema, keySchema, modelIndexSchema, modelSchema, relationSchema,
  type ModelDoc, type ModelEntity, type ModelField, type ModelFieldType, type ModelKey, type ModelRelation,
} from './model/types.js'
export { modelOpSchema, type ModelOp } from './model/apply.js'
export { MODEL_MAPPING, modelMappingJson } from './model/mapping.js'
export { modelFieldTypes, validateModel } from './model/validate.js'
export {
  APP_DOC, MODEL_DOC, OP_NAMES, blueprintOpSchema, pageDocPath,
  type BlueprintOp, type BlueprintOpInput, type OpName, type OpOf,
} from './types/ops.js'
export {
  DIAGNOSTIC_CODES, ERROR_STATUS, hasErrors, toPointer,
  type ApplyError, type Diagnostic, type DiagnosticCode, type ErrorCode, type Severity,
} from './types/diagnostics.js'

export { rev, revOfText, serialize, type BlueprintDoc } from './serialize.js'
export { encodeUlid, newId, sequenceSource, ulidSource, type IdPrefix, type IdSource } from './ids.js'
export { isOrderKey, keyBetween, keysBetween } from './order.js'
export { expressionsOf, rewriteExpressions, type ExpressionSite } from './expressions.js'

export {
  apply,
  type ApplyOptions, type ApplyOutcome, type ApplyResult, type ExpressionTools, type FileWrite,
} from './apply/index.js'
export {
  createStore, loadBlueprint, loadDocument, readBlueprintFiles,
  type Blueprint, type BlueprintStore, type DocEntry, type LoadOptions, type StoreApplyOutcome, type StoreOptions,
} from './store.js'
export { validate, validateStructure, type LayerCheck, type ValidationContext } from './validate/index.js'
export { checkSchema } from './validate/schema.js'
export { MIGRATIONS, migrate, type MigrateResult, type Migration, type MigrationTable } from './migrate/index.js'
export { project } from './project.js'
export {
  expressionCheck, expressionRequest,
  type ExpressionBinding, type ExpressionInput, type ExpressionRequest, type ExpressionTier, type UiExpressionScope,
} from './validate/expressions.js'
export { jsonSchemas } from './schemas.js'

export {
  componentManifestSchema, manifestJsonSchema,
  type ComponentManifest, type ComponentSchema, type ExposedValue, type ManifestEvent, type ManifestSlot, type PropSchema,
} from './manifest/types.js'
export {
  resolveManifests,
  type ManifestAliases, type ManifestInputs, type ManifestResolution, type ResolvedManifest, type ResolvedManifests,
} from './manifest/resolve.js'
export { exposedScope, manifestCheck, type ExposedScope } from './manifest/check.js'
export { manifestsToJsonSchema, type ManifestIndexEntry, type ManifestJsonSchemas } from './manifest/json-schema.js'
