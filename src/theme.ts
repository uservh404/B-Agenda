export type AppTheme = "azul" | "salvia" | "grafito";

export const appThemes: { id: AppTheme; name: string; description: string }[] = [
  { id: "azul", name: "Azul actual", description: "Azul sereno para el uso diario." },
  { id: "grafito", name: "Grafito", description: "Neutro y descansado." },
  { id: "salvia", name: "Salvia", description: "Verde suave y natural." },
];

const themeStorageKey = "biblioteca-theme";

function isAppTheme(theme: string | null): theme is AppTheme {
  return theme === "azul" || theme === "salvia" || theme === "grafito";
}

export function getAppTheme(): AppTheme {
  const savedTheme = window.localStorage.getItem(themeStorageKey);
  if (
    savedTheme === "claro"
    || savedTheme === "lavanda"
  ) {
    window.localStorage.setItem(themeStorageKey, "azul");
    return "azul";
  }
  return isAppTheme(savedTheme) ? savedTheme : "azul";
}

export function applyAppTheme(theme = getAppTheme()) {
  document.documentElement.dataset.theme = theme;
}

export function saveAppTheme(theme: AppTheme) {
  window.localStorage.setItem(themeStorageKey, theme);
  applyAppTheme(theme);
}