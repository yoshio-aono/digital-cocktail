import type { RGB, ReactiveType, RecipeItem } from "./types";

/**
 * Overall pH of a set of items. Because pH is logarithmic, we average the
 * hydrogen-ion concentration [H+] = 10^(-pH) by volume ratio, then convert
 * back: pH = -log10(H_avg). This is chemically correct and lets realistic
 * lemon amounts push the mix acidic enough to read red.
 *
 * Pure: pass already-diluted items in later steps and the weakened pH falls
 * out naturally. Returns 7.0 (neutral) for empty volume.
 */
export function calcOverallPH(items: RecipeItem[]): number {
  const totalVolume = items.reduce((sum, it) => sum + it.volume, 0);
  if (totalVolume <= 0) return 7.0;
  const hAvg = items.reduce((sum, it) => {
    const h = Math.pow(10, -it.ingredient.pH);
    return sum + h * (it.volume / totalVolume);
  }, 0);
  return -Math.log10(hAvg);
}

/** One point on a pH→color curve. RGB stored 0–255 for readability. */
type LutPoint = { pH: number; rgb: [number, number, number] };

/**
 * pH→color lookup tables per reactive type. Points must be sorted by
 * ascending pH. Values outside the range clamp to the nearest endpoint.
 */
const LUTS: Record<Exclude<ReactiveType, "none">, LutPoint[]> = {
  butterfly_pea: [
    { pH: 1.5, rgb: [220, 60, 90] }, // red / pink
    { pH: 3.0, rgb: [200, 50, 110] }, // red-purple / magenta
    { pH: 5.0, rgb: [120, 60, 180] }, // blue-purple
    { pH: 7.0, rgb: [30, 50, 200] }, // blue
  ],
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Look up a normalized (0–1) RGB for a reactive type at a given pH. */
export function lookupColor(type: Exclude<ReactiveType, "none">, pH: number): RGB {
  const table = LUTS[type];
  const first = table[0];
  const last = table[table.length - 1];

  let rgb255: [number, number, number];
  if (pH <= first.pH) {
    rgb255 = first.rgb;
  } else if (pH >= last.pH) {
    rgb255 = last.rgb;
  } else {
    let lo = first;
    let hi = last;
    for (let i = 0; i < table.length - 1; i++) {
      if (pH >= table[i].pH && pH <= table[i + 1].pH) {
        lo = table[i];
        hi = table[i + 1];
        break;
      }
    }
    const t = (pH - lo.pH) / (hi.pH - lo.pH);
    rgb255 = [
      lerp(lo.rgb[0], hi.rgb[0], t),
      lerp(lo.rgb[1], hi.rgb[1], t),
      lerp(lo.rgb[2], hi.rgb[2], t),
    ];
  }

  return { r: rgb255[0] / 255, g: rgb255[1] / 255, b: rgb255[2] / 255 };
}

/**
 * Chemistry step: compute overall pH, then rewrite the base RGB of every
 * reactive ingredient via its LUT. Returns a new items array with shallow-
 * copied ingredients; the ingredient master is never mutated.
 *
 * Runs immediately before the optics step.
 */
export function applyChemistry(items: RecipeItem[]): RecipeItem[] {
  const pH = calcOverallPH(items);
  return items.map((it) => {
    if (it.ingredient.reactive_type === "none") return it;
    return {
      ...it,
      ingredient: {
        ...it.ingredient,
        rgb: lookupColor(it.ingredient.reactive_type, pH),
      },
    };
  });
}
