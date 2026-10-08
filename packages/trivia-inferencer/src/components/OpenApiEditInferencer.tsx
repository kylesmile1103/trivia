import type { OpenApiInferencerProps } from '../types'
import { Inferencer } from './Inferencer'

/** A drop-in for Refine's `EditInferencer`: the resource's edit page from the OpenAPI contract, live, until it is ejected to disk. */
export function OpenApiEditInferencer(props: OpenApiInferencerProps) {
  return <Inferencer kind="edit" {...props} />
}
