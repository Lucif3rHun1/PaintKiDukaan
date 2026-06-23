import { Monitor, Moon, Sun } from "lucide-react";
import { Card, Section } from "../../../components/ui";
import { useTheme, type ThemeMode } from "../../../lib/theme";

const OPTIONS: ReadonlyArray<{
  id: ThemeMode;
  label: string;
  description: string;
  Icon: typeof Sun;
}> = [
  { id: "system", label: "System", description: "Match your operating system setting.", Icon: Monitor },
  { id: "light", label: "Light", description: "Bright surfaces, dark text. Best in daylight.", Icon: Sun },
  { id: "dark", label: "Dark", description: "Dim surfaces, light text. Best at night.", Icon: Moon },
];

export function ThemeSettings() {
  const { mode, resolved, setMode } = useTheme();

  return (
    <Card>
      <Section
        title="Appearance"
        description="Choose how PaintKiDukaan looks. System follows your OS preference."
      >
        <fieldset className="space-y-3" aria-label="Theme mode">
          {OPTIONS.map(({ id, label, description, Icon }) => {
            const selected = mode === id;
            return (
              <label
                key={id}
                className={
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors " +
                  (selected
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card hover:bg-muted")
                }
              >
                <input
                  type="radio"
                  name="theme-mode"
                  value={id}
                  checked={selected}
                  onChange={() => setMode(id)}
                  className="sr-only"
                />
                <span
                  className={
                    "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md " +
                    (selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
                  }
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium text-foreground">{label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
                </span>
                {selected ? (
                  <span className="ml-auto text-xs font-medium text-primary">Active</span>
                ) : null}
              </label>
            );
          })}
        </fieldset>

        <p className="mt-4 text-xs text-muted-foreground">
          Currently using <strong className="text-foreground">{resolved === "dark" ? "Dark" : "Light"}</strong>
          {mode === "system" ? " (from your system preference)." : "."}
        </p>
      </Section>
    </Card>
  );
}
