import { invoke } from "../../lib/ipc";
import type { Category, ListPage, ListQuery } from "../types";

export async function listCategories(): Promise<Category[]> {
  return invoke<Category[]>("list_categories");
}

export async function listCategoriesPaged(query: ListQuery): Promise<ListPage<Category>> {
  return invoke<ListPage<Category>>("cmd_list_categories_paged", { query });
}

export async function createCategory(name: string): Promise<Category> {
  return invoke<Category>("create_category", { name });
}

export async function deactivateCategory(id: number): Promise<void> {
  return invoke<void>("deactivate_category", { id });
}
