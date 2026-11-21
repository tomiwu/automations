import { eduskyBillingShapeExport } from "../edusky-billing-shape.ts";
import { entryDeps } from "./common.ts";

/** Read-only probe of the Edusky billing data shape. It takes no input. */
export default async function eduskyBillingShape(input: unknown = {}) {
  const { runtime, storage, familyId, counter } = await entryDeps();
  return eduskyBillingShapeExport({ runtime, storage, familyId, counter }, input);
}
