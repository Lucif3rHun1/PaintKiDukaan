import { invoke } from "../ipc";
import type { Category } from "../types";

export async function listCategories(): Promise<Category[]> {
  return invoke<Category[]>("list_categories");
}

export async function createCategory(name: string): Promise<Category> {
  return invoke<Category>("create_category", { name });
}

export async function deactivateCategory(id: number): Promise<void> {
  return invoke<void>("deactivate_category", { id });
}
