/** Notes live under the legacy workspace library or inside the Opening shell. */
export type LibraryBasePath = "/library" | "/opening/library";

export const DEFAULT_LIBRARY_BASE_PATH: LibraryBasePath = "/library";

export function libraryNotePath(basePath: LibraryBasePath, documentId: string): string {
  return `${basePath}/${encodeURIComponent(documentId)}`;
}

export function libraryNewNotePath(basePath: LibraryBasePath): string {
  return `${basePath}/new`;
}
