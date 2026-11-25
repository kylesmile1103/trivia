import type { ModelFieldType } from './types.js'

interface TypeMapping {
  csharp: string
  postgres: string
  postgresWithoutMaxLength?: string
  openapi: { type: string; format?: string } | { $ref: string }
  zod: string
}

/** The type forms shared with the generator (LLD-08 §2). Braced words are template inputs. */
export const MODEL_MAPPING = {
  string: {
    csharp: 'string', postgres: 'varchar({maxLength})', postgresWithoutMaxLength: 'text',
    openapi: { type: 'string' }, zod: 'z.string()',
  },
  text: { csharp: 'string', postgres: 'text', openapi: { type: 'string' }, zod: 'z.string()' },
  int: {
    csharp: 'int', postgres: 'integer', openapi: { type: 'integer', format: 'int32' },
    zod: 'z.number().int()',
  },
  long: {
    csharp: 'long', postgres: 'bigint', openapi: { type: 'integer', format: 'int64' },
    zod: 'z.number().int()',
  },
  decimal: {
    csharp: 'decimal', postgres: 'numeric({precision},{scale})', openapi: { type: 'number' },
    zod: 'z.number()',
  },
  bool: { csharp: 'bool', postgres: 'boolean', openapi: { type: 'boolean' }, zod: 'z.boolean()' },
  date: { csharp: 'DateOnly', postgres: 'date', openapi: { type: 'string', format: 'date' }, zod: 'z.string()' },
  datetime: {
    csharp: 'DateTimeOffset', postgres: 'timestamptz', openapi: { type: 'string', format: 'date-time' },
    zod: 'z.string()',
  },
  uuid: { csharp: 'Guid', postgres: 'uuid', openapi: { type: 'string', format: 'uuid' }, zod: 'z.string().uuid()' },
  enum: {
    csharp: '{enum}', postgres: 'text CHECK ({column} IN ({values}))',
    openapi: { $ref: '#/components/schemas/{enum}' }, zod: 'z.enum([{values}])',
  },
  json: { csharp: 'JsonDocument', postgres: 'jsonb', openapi: { type: 'object' }, zod: 'z.unknown()' },
} as const satisfies Record<ModelFieldType, TypeMapping>

export function modelMappingJson(): string {
  return JSON.stringify(MODEL_MAPPING, null, 2) + '\n'
}
