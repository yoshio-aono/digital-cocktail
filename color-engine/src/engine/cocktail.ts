import type { RGB, Recipe, RecipeItem } from "./types";
import { addWater, applyShakeFilter } from "./physics";
import { applyChemistry } from "./chemistry";
import { mixColor } from "./optics";

/** Volume-weighted average opacity of a set of items. */
function mixOpacity(items: RecipeItem[]): number {
  const totalVolume = items.reduce((sum, it) => sum + it.volume, 0);
  if (totalVolume <= 0) return 0;
  return items.reduce(
    (sum, it) => sum + it.ingredient.opacity * (it.volume / totalVolume),
    0,
  );
}

/**
 * Full color pipeline for a recipe. Order is fixed:
 *   addWater (physics, pre) → applyChemistry (chemistry) →
 *   mixColor (optics) → applyShakeFilter (physics, post).
 */
export function mixCocktail(recipe: Recipe): { rgb: RGB; opacity: number } {
  const watered = addWater(recipe.items, recipe.technique);
  const reacted = applyChemistry(watered);
  const rgb = mixColor({ ...recipe, items: reacted });
  const opacity = mixOpacity(reacted);
  return applyShakeFilter(rgb, opacity, recipe.technique);
}
