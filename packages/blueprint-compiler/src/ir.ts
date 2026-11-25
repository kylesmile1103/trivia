/** Emitted module syntax before the target printer chooses its layout. */
export interface PageIR {
  name: string
  file: string
  route: string
  client: boolean
  imports: ImportIR[]
  state: StateIR[]
  queries: QueryIR[]
  mutations: HookIR[]
  hooks: HookIR[]
  handlers: HandlerIR[]
  jsx: JsxIR
}

export interface ImportIR {
  source: string
  name: string
  as?: string
  kind?: 'named' | 'default' | 'type'
}

export interface StateIR {
  name: string
  setter?: string
  type: string
  initial: string
}

export interface HookIR {
  name: string
  hook: string
  args?: string
  type?: string
}

export interface QueryIR extends HookIR {
  fields: Readonly<Record<string, string>>
}

export interface HandlerIR {
  name: string
  params: string[]
  body: StepIR[]
}

export interface StepIR {
  code: string
  await?: boolean
}

export interface AttributeIR {
  name: string
  value: { kind: 'static'; value: unknown } | { kind: 'expr'; code: string }
}

export type JsxIR =
  | { kind: 'element'; tag: string; props: AttributeIR[]; children: JsxIR[] }
  | { kind: 'text'; value: string }
  | { kind: 'expr'; code: string }
  | { kind: 'cond'; test: string; child: JsxIR }
  | { kind: 'repeat'; list: string; item: string; index?: string; child: JsxIR }
