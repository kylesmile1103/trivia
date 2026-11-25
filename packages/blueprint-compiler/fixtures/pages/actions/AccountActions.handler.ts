export interface ActionContext {
  event: unknown;
  state: {
    message: string;
  };
  setters: {
    message: (value: string) => void;
  };
}

export function audit(_context: ActionContext): void {}
