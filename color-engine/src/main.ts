import "./style.css";
import { INGREDIENTS } from "./engine/ingredients";
import { toCss } from "./engine/optics";
import { addWater } from "./engine/physics";
import { calcOverallPH } from "./engine/chemistry";
import { mixCocktail } from "./engine/cocktail";
import type { Recipe, Technique } from "./engine/types";

/** Same Butterfly Pea Sour, varying only the technique. */
function peaSour(technique: Technique): Recipe {
  return {
    name: technique,
    technique,
    items: [
      { ingredient: INGREDIENTS.butterfly_pea, volume: 30 },
      { ingredient: INGREDIENTS.syrup, volume: 10 },
      { ingredient: INGREDIENTS.lemon, volume: 15 },
    ],
  };
}

const recipes: Recipe[] = [peaSour("BUILD"), peaSour("STIR"), peaSour("SHAKE")];

function card(recipe: Recipe): string {
  const { rgb, opacity } = mixCocktail(recipe);
  const css = toCss(rgb);
  // Recompute the watered intermediate purely for display.
  const watered = addWater(recipe.items, recipe.technique);
  const totalVolume = watered.reduce((s, it) => s + it.volume, 0);
  const pH = calcOverallPH(watered);
  return `
    <div class="card">
      <div class="swatch-wrap">
        <div class="swatch" style="background:${css}; opacity:${opacity.toFixed(2)}"></div>
      </div>
      <div class="meta">
        <h3>${recipe.technique}</h3>
        <p class="recipe">Pea 30 + Syrup 10 + Lemon 15</p>
        <p class="ph">pH ${pH.toFixed(2)} · total ${totalVolume.toFixed(1)}ml</p>
        <code>${css}</code>
        <code>opacity ${opacity.toFixed(3)}</code>
      </div>
    </div>`;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>Color Engine — Physics layer (water + shake)</h1>
  <p class="note">Same recipe, technique only. SHAKE adds more water, brightens, and lowers opacity.</p>
  <div class="grid">
    ${recipes.map(card).join("")}
  </div>`;
