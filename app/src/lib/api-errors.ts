export async function readServerError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    const m = j?.error || j?.message;
    return typeof m === "string" && m.length > 0 ? m : `${res.status}`;
  } catch {
    return `${res.status}`;
  }
}
