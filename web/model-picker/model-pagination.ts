// Adapted from Cody lib/model-catalog-pagination.ts (MIT, Copyright (c) 2026 agegr).
export const MODEL_PAGE_SIZE = 60;
export function getModelPageWindow(total: number, requestedPage: number, pageSize = MODEL_PAGE_SIZE) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safeSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 1;
  const pageCount = Math.max(1, Math.ceil(safeTotal / safeSize));
  const requested = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0;
  const pageIndex = Math.min(Math.max(0, requested), pageCount - 1);
  const start = pageIndex * safeSize;
  return { pageIndex, pageCount, start, end: Math.min(safeTotal, start + safeSize) };
}
