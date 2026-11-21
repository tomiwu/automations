import { activenowBillingShapeExport } from "../activenow-billing-shape.ts";
import { entryDeps } from "./common.ts";

/** Read-only probe of the ActiveNow billing page shape. It takes no input. */
export default async function activenowBillingShape(input: unknown = {}) {
  const { runtime, storage, familyId, counter } = await entryDeps();
  return activenowBillingShapeExport({ runtime, storage, familyId, counter }, input);
}