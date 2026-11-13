import { useEffect, useState } from "react";

// "system" follows the OS setting via the prefers-color-scheme rules in
// styles.css; "light" and "dark" set data-theme on <html>, which overrides them.
// index.html applies the saved choice before React loads, so pages don't flash.
const STORAGE_KEY = "gridlock-theme";
const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function savedTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(savedTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this visit.
    }
  }, [theme]);

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={theme === option.value}
          className={theme === option.value ? "active" : undefined}
          onClick={() => setTheme(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
