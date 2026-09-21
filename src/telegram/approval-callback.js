export function parseApprovalCallback(data = "") {
  if (data.startsWith("proc_")) return { action: "process", id: data.slice(5) };
  if (data.startsWith("ign_")) return { action: "ignore", id: data.slice(4) };
  return null;
}
