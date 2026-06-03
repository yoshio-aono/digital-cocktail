/** RGB color, each channel normalized to 0–1. */
export type RGB = {
  r: number;
  g: number;
  b: number;
};

/**
 * How an ingredient reacts chemically. `none` means its color is fixed;
 * other types will have their RGB rewritten by a pH-driven LUT in a later step.
 */
export type ReactiveType = "none" | "butterfly_pea";

/** A single ingredient in the master list. */
export type Ingredient = {
  id: string;
  name: string;
  /** Base color, normalized 0–1 per channel. */
  rgb: RGB;
  /** 0 = fully transparent, 1 = fully opaque. Drives optical density. */
  opacity: number;
  /** Acidity of the pure ingredient (0–14). */
  pH: number;
  /** Whether/how the color changes with pH. */
  reactive_type: ReactiveType;
};

/** Preparation technique. Affects water addition and finishing in later steps. */
export type Technique = "BUILD" | "STIR" | "SHAKE";

/** One ingredient plus how much of it is in the glass. */
export type RecipeItem = {
  ingredient: Ingredient;
  /** Relative volume (e.g. ml). Only ratios matter for mixing. */
  volume: number;
};

/** A full drink: a set of measured ingredients and a technique. */
export type Recipe = {
  name: string;
  items: RecipeItem[];
  technique: Technique;
};
