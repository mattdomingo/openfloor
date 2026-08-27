export type SettingsSection = "profile" | "plan" | "connections" | "preferences" | "danger";

const SETTINGS_SECTION_VALUES: SettingsSection[] = ["profile", "plan", "connections", "preferences", "danger"];

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return SETTINGS_SECTION_VALUES.includes(value as SettingsSection);
}
