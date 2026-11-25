export { projectFacts, type FactInputs, type PrintStyle, type ProjectFacts } from './facts.js'
export type { AttributeIR, HandlerIR, HookIR, ImportIR, JsxIR, PageIR, QueryIR, StateIR, StepIR } from './ir.js'
export {
  compilePage, CompileError, pageDiagnostics,
  type CompileContext, type ContractPageGenerator, type ContractPageInput, type EmittedModule, type RegistryItem,
} from './compile.js'
