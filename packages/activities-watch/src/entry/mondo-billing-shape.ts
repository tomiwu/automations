import { mondoBillingShapeExport } from "../mondo-billing-shape.ts";
import { entryDeps } from "./common.ts";

/** Read-only probe of the Mondo billing page shape. It takes no input. */
export default async function mondoBillingShape(input: unknown = {}) {
  const { runtime, storage, familyId, counter } = await entryDeps();
  return mondoBillingShapeExport({ runtime, storage, familyId, counter }, input);
}
