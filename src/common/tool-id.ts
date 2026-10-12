export function toolId(provider: string, operation: string): string {
  return `${provider}/${encodeURIComponent(operation)}`;
}
