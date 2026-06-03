import type { RGB, Recipe } from "./types";

/** Smallest transmittance we allow, so -log10(T) never diverges. */
const MIN_T = 1 / 255;

const clampT = (t: number): number => Math.min(1, Math.max(MIN_T, t));

/** Transmittance (0–1) → absorbance via Lambert–Beer. */
const absorbance = (t: number): number => -Math.log10(clampT(t));

/** Absorbance → transmittance (0–1). */
const transmittance = (a: number): number => Math.pow(10, -a);

/**
 * Subtractive color mixing via the Lambert–Beer law.
 *
 * Each ingredient's normalized RGB is read as a per-channel transmittance.
 * Absorbance is scaled by opacity (a stand-in for dye concentration), then
 * volume-weighted across the recipe and summed. Higher total absorbance =
 * darker result, so mixing colored liquids trends darker, as expected.
 *
 * pH and water addition are intentionally NOT handled here yet.
 */
export function mixColor(recipe: Recipe): RGB {
  const totalVolume = recipe.items.reduce((sum, it) => sum + it.volume, 0);
  if (totalVolume <= 0) {
    return { r: 1, g: 1, b: 1 };
  }

  let aR = 0;
  let aG = 0;
  let aB = 0;

  for (const { ingredient, volume } of recipe.items) {
    const ratio = volume / totalVolume;
    const { rgb, opacity } = ingredient;
    aR += absorbance(rgb.r) * opacity * ratio;
    aG += absorbance(rgb.g) * opacity * ratio;
    aB += absorbance(rgb.b) * opacity * ratio;
  }

  return {
    r: transmittance(aR),
    g: transmittance(aG),
    b: transmittance(aB),
  };
}

/** Convert normalized RGB (0–1) to a CSS rgb() string. */
export function toCss(rgb: RGB): string {
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to255(rgb.r)}, ${to255(rgb.g)}, ${to255(rgb.b)})`;
}
