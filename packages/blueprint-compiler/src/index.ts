export { projectFacts, type FactInputs, type PrintStyle, type ProjectFacts } from './facts.js'
export type { AttributeIR, HandlerIR, HookIR, ImportIR, JsxIR, PageIR, QueryIR, StateIR, StepIR } from './ir.js'
export {
  compilePage, CompileError, pageDiagnostics,
  type CompileContext, type EmittedModule, type PageSource, type RegistryItem,
} from './compile.js'
export type { ContractPageGenerator, ContractPageInput, RefineSnippetGenerator, RefineSnippetImport } from './contract-pages.js'
export { checkDataTable } from './composites/data-table.js'
export { checkForm } from './composites/form.js'
export { refineName } from './targets/paths.js'
export { restyleModule } from './print/style.js'
export { emptyLock, readLock, serializeLock, LOCK_FILE, type Lock, type LockedPage } from './lock.js'
export {
  planEject, planCompiledEject, prepareEject, routePattern, lockedSources,
  type EjectContext, type EjectPage, type EjectPlan, type EjectRoute, type EjectSnapshot, type SourceOp,
} from './eject.js'
export { relativeModule } from './targets/paths.js'
export { resourceOps, routeOps, type RouteRegistration } from './targets/vite-refine/routes.js'
export { targetFor, type Target, type RefineHookMap, type ResourceRegistration } from './targets/target.js'
export { checkedWebDirectory, DEFAULT_WEB_DIRECTORY, solutionFromWeb } from './solution.js'
