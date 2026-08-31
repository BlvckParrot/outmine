import { Moon, Pickaxe, Sun } from "lucide-react";
import { linkProps } from "../router";
import { useTheme } from "../theme";

const NAV = [
  { href: "/", label: "Board" },
  { href: "/about", label: "About" },
  { href: "/rules", label: "Rules" },
];

export function Header({ path }: { path: string }) {
  const [theme, toggle] = useTheme();

  return (
    <header className="w-full">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 pt-5 pb-4">
        <a
          {...linkProps("/")}
          className="inline-flex items-center gap-1.5 text-[22px] font-medium tracking-[-0.04em]"
        >
          <Pickaxe className="size-5 text-primary" strokeWidth={2.2} />
          <span>outmine<span className="text-primary">.</span></span>
        </a>

        <div className="flex items-center gap-3 sm:gap-4">
          <nav aria-label="Main">
            <ul className="flex items-center gap-4 text-sm sm:gap-5">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    {...linkProps(item.href)}
                    aria-current={path === item.href ? "page" : undefined}
                    className={`font-medium transition-colors hover:text-foreground ${
                      path === item.href ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <button
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}
