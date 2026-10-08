import type { OpenApiInferencerProps } from '../types'
import { Inferencer } from './Inferencer'

/** A drop-in for Refine's `CreateInferencer`: the resource's create page from the OpenAPI contract, live, until it is ejected to disk. */
export function OpenApiCreateInferencer(props: OpenApiInferencerProps) {
  return <Inferencer kind="create" {...props} />
}
