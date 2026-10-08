import type { OpenApiInferencerProps } from '../types'
import { Inferencer } from './Inferencer'

/** A drop-in for Refine's `ListInferencer`: the resource's list page from the OpenAPI contract, live, until it is ejected to disk. */
export function OpenApiListInferencer(props: OpenApiInferencerProps) {
  return <Inferencer kind="list" {...props} />
}
