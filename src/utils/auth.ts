export function bearerAuthorized(
  request: Request,
  token: string | null,
): boolean {
  if (!token) return false;
  return constantTimeEqual(
    request.headers.get("Authorization") ?? "",
    `Bearer ${token}`,
  );
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
