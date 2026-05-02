export function formatDuration(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / 1000 / 60) % 60);
  const hours = Math.floor(ms / 3600000);
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatUptime(startedAt: string | null): string {
  if (!startedAt) {
    return 'n/a';
  }

  const diff = Date.now() - new Date(startedAt).getTime();
  if (diff < 60000) {
    return `${Math.floor(diff / 1000)}s`;
  }
  if (diff < 3600000) {
    return `${Math.floor(diff / 60000)}m`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return `${days}d ${hours}h`;
}
