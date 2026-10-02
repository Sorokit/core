export function printResult(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(formatHuman(data));
}

export function printError(message: string, json: boolean): void {
  if (json) {
    console.error(JSON.stringify({ error: message }, null, 2));
    return;
  }
  console.error(`Error: ${message}`);
}

function formatHuman(data: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(data)) {
    if (data.length === 0) return `${pad}(none)`;
    return data.map((item) => formatHuman(item, indent)).join("\n");
  }
  if (data && typeof data === "object") {
    return Object.entries(data as Record<string, unknown>)
      .map(([key, value]) => {
        if (value && typeof value === "object") {
          return `${pad}${key}:\n${formatHuman(value, indent + 1)}`;
        }
        return `${pad}${key}: ${value}`;
      })
      .join("\n");
  }
  return `${pad}${String(data)}`;
}
