export { projectFacts, type FactInputs, type PrintStyle, type ProjectFacts } from './facts.js'
export type { AttributeIR, HandlerIR, HookIR, ImportIR, JsxIR, PageIR, QueryIR, StateIR, StepIR } from './ir.js'
export {
  compilePage, CompileError, pageDiagnostics,
  type CompileContext, type EmittedModule, type RegistryItem,
} from './compile.js'
export type { ContractPageGenerator, ContractPageInput } from './contract-pages.js'
export { refineName } from './targets/vite-refine/files.js'
export { restyleModule } from './print/style.js'
export { emptyLock, readLock, serializeLock, LOCK_FILE, type Lock, type LockedPage } from './lock.js'
export {
  planEject, planCompiledEject, prepareEject, routePattern,
  type EjectContext, type EjectPage, type EjectPlan, type EjectRoute, type EjectSnapshot, type SourceOp,
} from './eject.js'
