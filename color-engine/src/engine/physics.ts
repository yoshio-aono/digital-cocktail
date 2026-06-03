import type { RGB, RecipeItem, Technique, Ingredient } from "./types";

/** Fraction of the original volume added as water, per technique. */
const WATER_RATIO: Record<Technique, number> = {
  SHAKE: 0.22,
  STIR: 0.18,
  BUILD: 0.18,
};

/**
 * Colorless, neutral water. opacity 0 means it contributes zero absorbance
 * (no color), but its volume and pH 7.0 still dilute the mix chemically.
 * Generated here rather than stored in the ingredient master, since water is
 * a pipeline artifact, not a stockable ingredient.
 */
const WATER: Ingredient = {
  id: "water",
  name: "Water",
  rgb: { r: 1, g: 1, b: 1 },
  opacity: 0.0,
  pH: 7.0,
  reactive_type: "none",
};

/**
 * Pre-optics physical step: add technique-dependent water as a new item.
 * Returns a new items array; the input is not mutated. Feeding the result to
 * the chemistry step yields a naturally diluted pH.
 */
export function addWater(
  items: RecipeItem[],
  technique: Technique,
): RecipeItem[] {
  const totalVolume = items.reduce((sum, it) => sum + it.volume, 0);
  if (totalVolume <= 0) return items.slice();
  const waterVolume = totalVolume * WATER_RATIO[technique];
  return [...items, { ingredient: WATER, volume: waterVolume }];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Post-optics physical step: only on SHAKE, fake the look of aeration —
 * brighten each channel by +12% (clamped) and drop opacity by 15% (the
 * bubbles scatter light and cloud the drink). BUILD/STIR pass through.
 */
export function applyShakeFilter(
  rgb: RGB,
  opacity: number,
  technique: Technique,
): { rgb: RGB; opacity: number } {
  if (technique !== "SHAKE") return { rgb, opacity };
  return {
    rgb: {
      r: clamp01(rgb.r * 1.12),
      g: clamp01(rgb.g * 1.12),
      b: clamp01(rgb.b * 1.12),
    },
    opacity: clamp01(opacity * 0.85),
  };
}
