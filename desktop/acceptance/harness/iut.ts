/**
 * Implementation-under-test selector.
 *
 * Today the suite runs against `reference-iut.ts` (conforming oracle) or
 * `legacy-iut` behaviour through `ARCHRECON_IUT_MODE=legacy`. When the shared
 * contract commit lands, replace the import below with the production
 * adapter module and keep every assertion in `tests/` unchanged.
 */

import { createIut, type Iut, type IutOptions } from "./reference-iut.ts";

export type IutMode = "reference" | "legacy";

export const IUT_MODE: IutMode =
  process.env.ARCHRECON_IUT_MODE === "legacy" ? "legacy" : "reference";

export function createIutUnderTest(options: Omit<IutOptions, "mode">): Iut {
  return createIut({ ...options, mode: IUT_MODE });
}

export * from "./reference-iut.ts";
