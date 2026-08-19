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

export function formatShortDate(timestamp: number) {
  return shortDateFormatter.format(new Date(timestamp));
}

export function formatShortTime(timestamp: number) {
  return shortTimeFormatter.format(new Date(timestamp));
}
