// Utility for validating file types based on magic bytes
export async function getFileTypeFromPath(filePath: string): Promise<{ mime: string; ext: string } | null> {
  // @ts-expect-error file-type is ESM but we use it with dynamic import
  const { fileTypeFromFile } = await import('file-type');
  const fileType = await fileTypeFromFile(filePath);
  return fileType as { mime: string; ext: string } | null;
}
