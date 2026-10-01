// Adapted from Cody lib/model-categories.ts (MIT, Copyright (c) 2026 agegr).
// Display classification only. Never use these categories for capabilities.
export const MODEL_CATEGORY_OPTIONS = ["SWE", "Fusion", "Other"] as const;
export type ModelCategory = typeof MODEL_CATEGORY_OPTIONS[number];
interface CategoryModel { id: string; displayName: string; family?: { id: string; displayName: string } }
export function modelCategories(model: CategoryModel): ModelCategory[] {
  const text = `${model.id} ${model.displayName} ${model.family?.id ?? ""} ${model.family?.displayName ?? ""}`.toLowerCase().replace(/[\-_]+/g, " ");
  const categories: ModelCategory[] = [];
  if (/\bswe(?:\s*[-_]?\s*\d+(?:\.\d+)*)?\b/.test(text)) categories.push("SWE");
  if (/\bfusion\b/.test(text)) categories.push("Fusion");
  return categories.length ? categories : ["Other"];
}
export function modelCategoryBucket(model: CategoryModel): ModelCategory {
  const categories = modelCategories(model);
  return categories.includes("Fusion") ? "Fusion" : categories[0];
}
export function modelMatchesCategories(model: CategoryModel, selected: ReadonlySet<ModelCategory>): boolean {
  return selected.size === 0 || selected.has(modelCategoryBucket(model));
}
