export type AppTheme = "azul" | "claro" | "salvia" | "grafito";

export const appThemes: { id: AppTheme; name: string; description: string }[] = [
  { id: "azul", name: "Azul actual", description: "Azul sereno para el uso diario." },
  { id: "claro", name: "Claro", description: "Fondos claros y texto oscuro." },
  { id: "salvia", name: "Salvia", description: "Verde suave y natural." },
  { id: "grafito", name: "Grafito", description: "Neutro y descansado." },
];

const themeStorageKey = "biblioteca-theme";

function isAppTheme(theme: string | null): theme is AppTheme {
  return theme === "azul" || theme === "claro" || theme === "salvia" || theme === "grafito";
}

export function getAppTheme(): AppTheme {
  const savedTheme = window.localStorage.getItem(themeStorageKey);
  return isAppTheme(savedTheme) ? savedTheme : "azul";
}

export function applyAppTheme(theme = getAppTheme()) {
  document.documentElement.dataset.theme = theme;
}

export function saveAppTheme(theme: AppTheme) {
  window.localStorage.setItem(themeStorageKey, theme);
  applyAppTheme(theme);
}