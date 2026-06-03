import type { Ingredient } from "./types";

/**
 * Test ingredient master. Colors are approximate, normalized 0–1.
 * pH values are realistic-ish; they are not used by the optics step yet.
 */
export const INGREDIENTS: Record<string, Ingredient> = {
  butterfly_pea: {
    id: "butterfly_pea",
    name: "Butterfly Pea Tea",
    // Deep blue.
    rgb: { r: 0.13, g: 0.18, b: 0.55 },
    opacity: 0.85,
    pH: 6.5,
    reactive_type: "butterfly_pea",
  },
  lemon: {
    id: "lemon",
    name: "Lemon Juice",
    // Pale yellow.
    rgb: { r: 0.95, g: 0.9, b: 0.45 },
    opacity: 0.35,
    pH: 3.0,
    reactive_type: "none",
  },
  vodka: {
    id: "vodka",
    name: "Vodka",
    // Clear / colorless.
    rgb: { r: 1.0, g: 1.0, b: 1.0 },
    opacity: 0.02,
    pH: 7.0,
    reactive_type: "none",
  },
  syrup: {
    id: "syrup",
    name: "Sugar Syrup",
    // Faint amber.
    rgb: { r: 0.98, g: 0.92, b: 0.75 },
    opacity: 0.2,
    pH: 7.0,
    reactive_type: "none",
  },
};
