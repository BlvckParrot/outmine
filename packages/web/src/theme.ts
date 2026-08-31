import { useState } from "react";
import { rememberTheme, storedTheme, type Theme } from "./storage";

/** The class on <html> is already set by the inline script in index.html; this hook
 *  only keeps React's copy of it and flips both when someone presses the button.
 *  theme-color goes with it, or the browser chrome on a phone stays the old colour. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next === "dark" ? "#14100c" : "#fffcf5");
    rememberTheme(next);
    setTheme(next);
  };

  return [theme, toggle];
}
