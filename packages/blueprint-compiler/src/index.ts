export { projectFacts, type FactInputs, type PrintStyle, type ProjectFacts } from './facts.js'
export type { AttributeIR, HandlerIR, HookIR, ImportIR, JsxIR, PageIR, QueryIR, StateIR, StepIR } from './ir.js'
export {
  compilePage, CompileError, pageDiagnostics,
  type CompileContext, type EmittedModule, type RegistryItem,
} from './compile.js'
export type { ContractPageGenerator, ContractPageInput } from './contract-pages.js'
