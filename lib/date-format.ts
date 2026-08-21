const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const shortTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

/* Host-timezone variants for client-side rendering after mount. Server markup
   must keep using the UTC formatters above so SSR output stays deterministic. */
const localDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const localTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

export function formatShortDate(timestamp: number) {
  return shortDateFormatter.format(new Date(timestamp));
}

export function formatShortTime(timestamp: number) {
  return shortTimeFormatter.format(new Date(timestamp));
}

export function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return `${Math.max(0, Math.floor(totalSeconds % 60))}s`;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

export function formatShortDateLocal(timestamp: number) {
  return localDateFormatter.format(new Date(timestamp));
}

export function formatShortTimeLocal(timestamp: number) {
  return localTimeFormatter.format(new Date(timestamp));
}
