const key = (userId: string) => `sa.welcomed.${userId}`;

export function needsWelcome(userId: string): boolean {
  try {
    return !localStorage.getItem(key(userId));
  } catch {
    return false;
  }
}

export function markWelcomed(userId: string): void {
  try {
    localStorage.setItem(key(userId), "1");
  } catch {
    // storage may be unavailable; the welcome page then shows again next time
  }
}
