import { useEffect, useRef, useState, isValidElement } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "./cn";

interface Action {
  label: string;
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode;
  onSelect?: () => void;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  label?: string;
  actions?: Action[];
  items?: Action[];
  className?: string;
}

function isIconComponent(
  icon: React.ComponentType<{ className?: string }> | React.ReactNode,
): icon is React.ComponentType<{ className?: string }> {
  return (
    typeof icon === "function" ||
    (typeof icon === "object" &&
      icon !== null &&
      !isValidElement(icon))
  );
}

interface MenuPos {
  top: number;
  left: number;
  placement: "bottom-right" | "top-right";
}

const MENU_WIDTH = 192; // w-48
const MENU_ITEM_PX = 36;
const MENU_VPAD = 8;
const VIEWPORT_GUTTER = 8;

export function ActionMenu({ label, actions, items, className }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPos>({
    top: 0,
    left: 0,
    placement: "bottom-right",
  });

  const allActions = (items ?? actions ?? []).filter((a) => !a.disabled);

  // Position the portal-rendered menu relative to the trigger, flipping up if
  // it would overflow the bottom of the viewport. Recomputed when the menu
  // opens or its content changes. Scroll/resize closes the menu so it never
  // dangles from a stale anchor.
  useEffect(() => {
    if (!open) return;
    function compute() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menuHeight = Math.min(
        allActions.length * MENU_ITEM_PX + MENU_VPAD,
        240,
      );
      const wouldOverflowBottom =
        rect.bottom + menuHeight > window.innerHeight - VIEWPORT_GUTTER;
      const placement: MenuPos["placement"] = wouldOverflowBottom
        ? "top-right"
        : "bottom-right";
      const top =
        placement === "bottom-right"
          ? rect.bottom + 4
          : rect.top - menuHeight - 4;
      const left = Math.max(
        VIEWPORT_GUTTER,
        Math.min(
          window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER,
          rect.right - MENU_WIDTH,
        ),
      );
      setPos({ top, left, placement });
    }
    compute();
    function dismissOnScroll() {
      setOpen(false);
    }
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismissOnScroll);
    return () => {
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismissOnScroll);
    };
  }, [open, allActions.length]);

  // Keyboard navigation while the menu is open.
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (allActions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % allActions.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + allActions.length) % allActions.length);
      }
      if (e.key === "Enter" && allActions[activeIndex]) {
        e.preventDefault();
        const action = allActions[activeIndex];
        action.onSelect?.();
        action.onClick?.();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, activeIndex, allActions]);

  useEffect(() => {
    if (open) setActiveIndex(0);
  }, [open]);

  // Outside-click dismiss. With a portal-rendered menu, both refs must be
  // checked — the trigger and the menu are siblings in the DOM, not parent/child.
  useEffect(() => {
    if (!open) return;
    function outside(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          className,
        )}
        aria-label={label ?? "Actions"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-placement={pos.placement}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: MENU_WIDTH,
            }}
            className="z-[1000] max-h-60 overflow-auto rounded-lg border border-border bg-card text-foreground shadow-xl ring-1 ring-black/5"
          >
            {allActions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No actions</div>
            ) : (
              allActions.map((action, i) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                    action.danger
                      ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
                      : "text-foreground hover:bg-muted focus-visible:bg-muted",
                    i === activeIndex &&
                      (action.danger
                        ? "bg-destructive/10"
                        : "bg-muted"),
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => {
                    action.onSelect?.();
                    action.onClick?.();
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  {action.icon && (
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                      {isIconComponent(action.icon) ? (
                        <action.icon className="h-4 w-4" />
                      ) : (
                        action.icon
                      )}
                    </span>
                  )}
                  {action.label}
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
