import type { OpenApiInferencerProps } from '../types'
import { Inferencer } from './Inferencer'

/** A drop-in for Refine's `ShowInferencer`: the resource's show page from the OpenAPI contract, live, until it is ejected to disk. */
export function OpenApiShowInferencer(props: OpenApiInferencerProps) {
  return <Inferencer kind="show" {...props} />
}
